"""Pipecat voice agent: mic audio -> VAD -> ElevenLabs STT -> Gemini -> ElevenLabs TTS -> speaker."""

import os
import random
import time
import uuid
from datetime import date, datetime

import aiohttp
from loguru import logger

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame, TTSSpeakFrame
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
from summary import summarize


def system_prompt() -> str:
    roster = "\n".join(f"- {d['name']} ({d['speciality']})" for d in db.list_doctors())
    today = date.today()
    return f"""You are Maya, the voice receptionist at Nexov Health Clinic. You are on a phone call.
Today is {today.strftime('%A, %d %B %Y')} (ISO {today.isoformat()}).

Doctors:
{roster}

You can check availability, book, reschedule and cancel appointments.

Safety first:
- If the caller describes an emergency (chest pain, trouble breathing, stroke signs, heavy bleeding,
  loss of consciousness, severe allergic reaction, thoughts of self-harm), call flag_urgent_case with
  emergency=true, tell them calmly to call 112 or go to the nearest emergency room now, and do not book.
- If it is urgent but not an emergency (high fever, a child who is unwell, sudden pain, an injury),
  call flag_urgent_case with emergency=false, then offer the earliest slot with the right doctor.

How to work:
- The caller is identified ONLY by the phone number they say. Ask for it early.
- Before booking, rescheduling or cancelling, read the number back in groups (e.g. "98765, 43210")
  and wait for a clear yes. Only then call the tool with phone_confirmed=true.
- For a booking you also need the caller's name, the doctor, the day and the time.
- Always call check_doctor_availability before offering slots. Never invent slots.
  Offer two or three options, not the whole list.
- When the caller describes a problem instead of a doctor, suggest the matching speciality.
- Dates passed to tools are ISO (YYYY-MM-DD); resolve "tomorrow" or "Friday" yourself.
- After a tool result, confirm in one short sentence (doctor, day, time).

Style: this is speech, not text. Short sentences, one question at a time, warm and calm.
No lists, markdown, emojis or symbols. Say times like "ten thirty a.m."."""


PHONE = {"type": "string", "description": "Caller's 10-digit phone number, digits only"}
CONFIRMED = {"type": "boolean", "description": "True only if the caller confirmed the read-back"}

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
                "phone": PHONE, "phone_confirmed": CONFIRMED,
                "patient_name": {"type": "string"},
                "doctor_name": {"type": "string"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
                "time": {"type": "string", "description": "24h HH:MM, e.g. 14:30"},
            },
            required=["phone", "phone_confirmed", "patient_name", "doctor_name", "date", "time"],
        ),
        FunctionSchema(
            name="reschedule_appointment",
            description="Move the caller's existing appointment to a new slot. Check availability first.",
            properties={
                "phone": PHONE, "phone_confirmed": CONFIRMED,
                "new_date": {"type": "string", "description": "YYYY-MM-DD"},
                "new_time": {"type": "string", "description": "24h HH:MM"},
                "doctor_name": {"type": "string", "description": "Only if switching doctor"},
                "appointment_id": {"type": "string", "description": "Only if the caller has several"},
            },
            required=["phone", "phone_confirmed", "new_date", "new_time"],
        ),
        FunctionSchema(
            name="cancel_appointment",
            description="Cancel the caller's appointment, found by phone number. Only after the number was confirmed.",
            properties={
                "phone": PHONE, "phone_confirmed": CONFIRMED,
                "appointment_id": {"type": "string", "description": "Only if the caller has several appointments"},
            },
            required=["phone", "phone_confirmed"],
        ),
        FunctionSchema(
            name="flag_urgent_case",
            description="Flag an urgent or emergency symptom so front-desk staff see it immediately.",
            properties={
                "symptom": {"type": "string", "description": "Short description in the caller's words"},
                "emergency": {"type": "boolean", "description": "True if they must go to emergency care now"},
            },
            required=["symptom", "emergency"],
        ),
    ]
)

# Short lines spoken while a tool runs, so the caller never hears dead air.
FILLERS = {
    "check_doctor_availability": ["Let me check the calendar.", "One moment, checking that for you."],
    "book_appointment": ["Booking that now.", "Okay, locking that in."],
    "reschedule_appointment": ["Moving that for you now."],
    "cancel_appointment": ["One moment, pulling that up."],
}


class Call:
    """Everything we keep about one call: outcome, events for the dashboard, transcript for the log."""

    def __init__(self):
        self.id = "C" + uuid.uuid4().hex[:6].upper()
        self.started = time.time()
        self.started_at = datetime.now().isoformat(timespec="seconds")
        self.events: list[dict] = []
        self.outcomes: list[str] = []
        self.phone: str | None = None
        self.urgent: str | None = None

    def log(self, kind: str, **data):
        self.events.append({"t": round(time.time() - self.started, 1), "kind": kind, **data})


def _unconfirmed(a: dict) -> dict | None:
    if not a.get("phone_confirmed"):
        return {"ok": False, "error": "Read the phone number back and get a yes before calling this."}
    return None


def make_handlers(call: Call):
    async def notify(params: FunctionCallParams, payload: dict):
        # Sent to the browser over the RTVI data channel (phone card + dashboard refresh).
        await params.llm.push_frame(RTVIServerMessageFrame(data={**payload, "call_id": call.id}))

    async def check_doctor_availability(params: FunctionCallParams):
        a = params.arguments
        await notify(params, {"type": "tool", "name": "check_doctor_availability", "args": a})
        result = db.availability(a.get("doctor_name"), a.get("speciality"), a.get("date"))
        call.log("availability", query=a.get("doctor_name") or a.get("speciality") or "any", date=a.get("date"))
        await notify(params, {"type": "availability", "args": a})
        await params.result_callback(result)

    async def book_appointment(params: FunctionCallParams):
        a = params.arguments
        await notify(params, {"type": "tool", "name": "book_appointment", "args": a})
        result = _unconfirmed(a) or db.book(
            a.get("phone", ""), a.get("doctor_name", ""), a.get("date", ""), a.get("time", ""),
            a.get("patient_name", ""),
        )
        if result.get("ok"):
            call.phone, _ = result["phone"], call.outcomes.append("booked")
            call.log("booked", id=result["appointment_id"], doctor=result["doctor"], when=result["when"])
            await notify(params, {"type": "booked", "appointment": result})
        else:
            call.log("failed", tool="book", reason=result.get("error"))
        await params.result_callback(result)

    async def reschedule_appointment(params: FunctionCallParams):
        a = params.arguments
        await notify(params, {"type": "tool", "name": "reschedule_appointment", "args": a})
        result = _unconfirmed(a) or db.reschedule(
            a.get("phone", ""), a.get("appointment_id"), a.get("doctor_name"),
            a.get("new_date", ""), a.get("new_time", ""),
        )
        if result.get("ok"):
            call.phone, _ = result["phone"], call.outcomes.append("rescheduled")
            call.log("rescheduled", id=result["appointment_id"], doctor=result["doctor"],
                     when=result["when"], previous=result.get("previous"))
            await notify(params, {"type": "rescheduled", "appointment": result})
        else:
            call.log("failed", tool="reschedule", reason=result.get("error"))
        await params.result_callback(result)

    async def cancel_appointment(params: FunctionCallParams):
        a = params.arguments
        await notify(params, {"type": "tool", "name": "cancel_appointment", "args": a})
        result = _unconfirmed(a) or db.cancel(a.get("phone", ""), a.get("appointment_id"))
        if result.get("ok"):
            call.phone, _ = result["phone"], call.outcomes.append("cancelled")
            call.log("cancelled", id=result["appointment_id"], doctor=result["doctor"], when=result["when"])
            await notify(params, {"type": "cancelled", "appointment": result})
        else:
            call.log("failed", tool="cancel", reason=result.get("error"))
        await params.result_callback(result)

    async def flag_urgent_case(params: FunctionCallParams):
        a = params.arguments
        level = "emergency" if a.get("emergency") else "urgent"
        call.urgent = f"{level}: {a.get('symptom', '')}"
        call.log("urgent", level=level, symptom=a.get("symptom"))
        await notify(params, {"type": "urgent", "level": level, "symptom": a.get("symptom")})
        advice = ("Tell the caller to call 112 or go to the nearest emergency room now. Do not book."
                  if level == "emergency" else "Offer the earliest available slot with the right doctor.")
        await params.result_callback({"ok": True, "flagged": level, "next": advice})

    return {
        "check_doctor_availability": check_doctor_availability,
        "book_appointment": book_appointment,
        "reschedule_appointment": reschedule_appointment,
        "cancel_appointment": cancel_appointment,
        "flag_urgent_case": flag_urgent_case,
    }


def transcript_of(context: LLMContext) -> list[dict]:
    """Flatten the LLM context into simple caller/agent turns for the call log."""
    out = []
    for m in context.get_messages():
        role = m.get("role") if isinstance(m, dict) else None
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        text = (content or "").strip()
        if text and not text.startswith("(The call just connected"):
            out.append({"role": "caller" if role == "user" else "agent", "text": text})
    return out


async def run_bot(connection: SmallWebRTCConnection):
    call = Call()
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
        for name, handler in make_handlers(call).items():
            llm.register_function(name, handler)

        @llm.event_handler("on_function_calls_started")
        async def on_tools_started(_service, function_calls):
            # Fill the silence while the database is queried.
            for fc in function_calls:
                lines = FILLERS.get(fc.function_name)
                if lines:
                    await tts.queue_frame(TTSSpeakFrame(random.choice(lines)))
                    break

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

        task = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))

        @transport.event_handler("on_client_connected")
        async def on_connected(_transport, _client):
            logger.info(f"Caller connected ({call.id})")
            await task.queue_frames([LLMRunFrame()])

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_transport, _client):
            logger.info(f"Caller disconnected ({call.id})")
            await task.cancel()

        runner = PipelineRunner(handle_sigint=False)
        await runner.add_workers(task)
        try:
            await runner.run()
        finally:
            await finish_call(call, context)


async def finish_call(call: Call, context: LLMContext):
    transcript = transcript_of(context)
    if not transcript:
        return  # nothing happened (e.g. connection dropped before the greeting)
    outcome = call.outcomes[-1] if call.outcomes else ("urgent" if call.urgent else "no action")
    summary = await summarize(transcript, outcome)
    db.save_call({
        "id": call.id,
        "started_at": call.started_at,
        "ended_at": datetime.now().isoformat(timespec="seconds"),
        "duration_s": int(time.time() - call.started),
        "outcome": outcome,
        "phone": call.phone,
        "summary": summary,
        "urgent": call.urgent,
        "transcript": transcript,
        "events": call.events,
    })
    logger.info(f"Call {call.id} saved: {outcome} — {summary}")
