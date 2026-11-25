"""Pipecat voice agent: mic audio -> VAD -> ElevenLabs STT -> Gemini -> ElevenLabs TTS -> speaker."""

import os
from datetime import date

import aiohttp
from loguru import logger

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame
from pipecat.services.elevenlabs.stt import ElevenLabsSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

import db


def system_prompt() -> str:
    roster = "\n".join(f"- {d['name']} ({d['speciality']})" for d in db.list_doctors())
    today = date.today()
    return f"""You are Maya, the voice receptionist at Nexov Health Clinic. You are on a phone call.
Today is {today.strftime('%A, %d %B %Y')} (ISO {today.isoformat()}).

Doctors:
{roster}

You can check availability, book an appointment, and cancel an appointment.

How to work:
- The caller is identified ONLY by the phone number they say. Ask for it early.
- Before booking or cancelling, read the number back digit by digit in groups (e.g. "98765, 43210")
  and wait for a clear yes. Only then call the tool with phone_confirmed=true.
- For a booking you also need the caller's name, the doctor, the day and the time.
- Always call check_doctor_availability before offering slots. Never invent slots.
  Offer two or three options, not the whole list.
- When the caller describes a problem instead of a doctor, suggest the matching speciality.
- Dates passed to tools are ISO (YYYY-MM-DD); resolve "tomorrow" or "Friday" yourself.
- After a tool result, confirm in one short sentence (doctor, day, time).

Style: this is speech, not text. Short sentences, one question at a time, warm and calm.
No lists, markdown, emojis or symbols. Say times like "ten thirty a.m."."""


TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="check_doctor_availability",
            description="Get open appointment slots. Filter by doctor name, speciality and/or date.",
            properties={
                "doctor_name": {"type": "string", "description": "e.g. 'Dr. Rao' or 'Ananya Rao'"},
                "speciality": {"type": "string", "description": "e.g. 'cardiologist'"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
            },
            required=[],
        ),
        FunctionSchema(
            name="book_appointment",
            description="Book a slot for the caller. Only call after the caller confirmed their phone number.",
            properties={
                "phone": {"type": "string", "description": "Caller's 10-digit phone number, digits only"},
                "phone_confirmed": {"type": "boolean", "description": "True only if the caller confirmed the read-back"},
                "patient_name": {"type": "string"},
                "doctor_name": {"type": "string"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
                "time": {"type": "string", "description": "24h HH:MM, e.g. 14:30"},
            },
            required=["phone", "phone_confirmed", "patient_name", "doctor_name", "date", "time"],
        ),
        FunctionSchema(
            name="cancel_appointment",
            description="Cancel the caller's appointment, found by phone number. Only call after the number was confirmed.",
            properties={
                "phone": {"type": "string", "description": "Caller's 10-digit phone number, digits only"},
                "phone_confirmed": {"type": "boolean"},
                "appointment_id": {"type": "string", "description": "Only if the caller has several appointments"},
            },
            required=["phone", "phone_confirmed"],
        ),
    ]
)


async def _notify(params: FunctionCallParams, payload: dict):
    """Send an event to the browser over the RTVI data channel (phone card + dashboard refresh)."""
    await params.llm.push_frame(RTVIServerMessageFrame(data=payload))


async def check_doctor_availability(params: FunctionCallParams):
    a = params.arguments
    await _notify(params, {"type": "tool", "name": "check_doctor_availability", "args": a})
    result = db.availability(a.get("doctor_name"), a.get("speciality"), a.get("date"))
    await _notify(params, {"type": "availability", "args": a})
    await params.result_callback(result)


def _unconfirmed(a: dict) -> dict | None:
    if not a.get("phone_confirmed"):
        return {"ok": False, "error": "Read the phone number back and get a yes before calling this."}
    return None


async def book_appointment(params: FunctionCallParams):
    a = params.arguments
    await _notify(params, {"type": "tool", "name": "book_appointment", "args": a})
    result = _unconfirmed(a) or db.book(
        a.get("phone", ""), a.get("doctor_name", ""), a.get("date", ""), a.get("time", ""),
        a.get("patient_name", ""),
    )
    if result.get("ok"):
        await _notify(params, {"type": "booked", "appointment": result})
    await params.result_callback(result)


async def cancel_appointment(params: FunctionCallParams):
    a = params.arguments
    await _notify(params, {"type": "tool", "name": "cancel_appointment", "args": a})
    result = _unconfirmed(a) or db.cancel(a.get("phone", ""), a.get("appointment_id"))
    if result.get("ok"):
        await _notify(params, {"type": "cancelled", "appointment": result})
    await params.result_callback(result)


async def run_bot(connection: SmallWebRTCConnection):
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    async with aiohttp.ClientSession() as session:
        stt = ElevenLabsSTTService(api_key=os.environ["ELEVENLABS_API_KEY"], aiohttp_session=session)
        tts = ElevenLabsTTSService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            settings=ElevenLabsTTSService.Settings(
                voice=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
            ),
        )
        llm_settings = {"system_instruction": system_prompt()}
        if os.getenv("GEMINI_MODEL"):
            llm_settings["model"] = os.environ["GEMINI_MODEL"]
        llm = GoogleLLMService(
            api_key=os.environ["GOOGLE_API_KEY"],
            settings=GoogleLLMService.Settings(**llm_settings),
        )
        llm.register_function("check_doctor_availability", check_doctor_availability)
        llm.register_function("book_appointment", book_appointment)
        llm.register_function("cancel_appointment", cancel_appointment)

        context = LLMContext(
            messages=[{"role": "user", "content": "(The call just connected. Greet the caller briefly.)"}],
            tools=TOOLS,
        )
        aggregators = LLMContextAggregatorPair(context)

        # Silero VAD marks where speech starts/stops; ElevenLabs STT transcribes each segment.
        vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.5)))

        pipeline = Pipeline(
            [
                transport.input(),
                vad,
                stt,
                aggregators.user(),
                llm,
                tts,
                transport.output(),
                aggregators.assistant(),
            ]
        )

        task = PipelineWorker(
            pipeline,
            params=PipelineParams(enable_metrics=True),
        )

        @transport.event_handler("on_client_connected")
        async def on_connected(_transport, _client):
            logger.info("Caller connected")
            await task.queue_frames([LLMRunFrame()])

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_transport, _client):
            logger.info("Caller disconnected")
            await task.cancel()

        runner = PipelineRunner(handle_sigint=False)
        await runner.add_workers(task)
        await runner.run()
