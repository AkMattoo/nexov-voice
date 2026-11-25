# Nexov Health — Voice Front Desk

A voice receptionist that checks doctor availability, books and cancels appointments over a real-time call, plus a front-desk dashboard that shows the schedule change as the call happens.

- **Voice pipeline:** Pipecat (Python), ElevenLabs STT (Scribe) + ElevenLabs TTS, Silero VAD
- **LLM:** Google Gemini (Flash, free tier) via `GoogleLLMService`, with function calling
- **Transport:** Pipecat `SmallWebRTCTransport` (browser ↔ server WebRTC, no third-party room service)
- **Data:** SQLite, seeded with mock doctors and slots for the next four working days on every start
- **Frontend:** Vite + vanilla JS, `@pipecat-ai/client-js` with the small-webrtc transport

## Run it

Needs Python 3.11+ and Node 18+.

```bash
# 1. backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add ELEVENLABS_API_KEY and GOOGLE_API_KEY
python server.py              # http://localhost:7860

# 2. frontend (second terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173  (proxies /api to :7860)
```

Open http://localhost:5173, click **Try call**, allow the mic.

To serve everything from one port instead: `npm run build` in `frontend/`, then `python server.py` serves the built dashboard at http://localhost:7860.

## How a call flows

```
mic ──WebRTC──▶ Silero VAD ─▶ ElevenLabs STT ─▶ user context ─▶ Gemini ─▶ ElevenLabs TTS ──WebRTC──▶ speaker
                                                                   │
                                                  tool calls ──────┘──▶ SQLite
                                                                   │
                                                  RTVI server msg ─┘──▶ dashboard (flash slot, add row, phone card)
```

1. The browser opens a WebRTC connection by POSTing an SDP offer to `/api/offer`. The server answers and starts a Pipecat pipeline for that call.
2. Silero VAD finds where the caller starts and stops speaking. Each speech segment goes to ElevenLabs Scribe for transcription.
3. The transcript is added to the LLM context. Gemini replies or calls one of three tools.
4. Gemini's reply streams sentence by sentence into ElevenLabs TTS, and the audio goes back over WebRTC. The caller can interrupt.
5. Transcripts reach the browser over the RTVI data channel. Tool handlers also send small `server-message` events (`booked`, `cancelled`, `availability`) so the dashboard reacts immediately instead of polling.

## Tools

| Tool | Args | Does |
|---|---|---|
| `check_doctor_availability` | `doctor_name?`, `speciality?`, `date?` | Open slots, capped to 3 days × 6 slots so the answer stays speakable |
| `book_appointment` | `phone`, `phone_confirmed`, `patient_name`, `doctor_name`, `date`, `time` | Books the slot, marks it taken |
| `cancel_appointment` | `phone`, `phone_confirmed`, `appointment_id?` | Finds active bookings by phone; asks which one if there are several |

**Identity is the spoken phone number only.** The prompt makes the agent read the number back before booking or cancelling, and the tools enforce it: `phone_confirmed` must be `true` or the tool returns an error telling the agent to confirm first. Numbers are normalised to 10 digits (a leading `+91` is stripped).

## Dashboard

- Schedule board: doctors × time slots for a selected day. Booked slots fill in; when the agent books or cancels, the cell flashes green or rust and the board jumps to that day.
- Appointments ledger: newest first, new rows slide in highlighted, cancelled rows strike through.
- Phone call screen: ringing → connected → ended states, call timer, mute, end call, live transcript with the not-yet-spoken part of each bot sentence shown faint, a live waveform (agent voice in green, caller in white), a "checking Dr. Rao's calendar" activity line during tool calls, a confirmation card on booking/cancellation, and synthesized ring, end-call and confirmation sounds.
- On wide screens the phone docks to the right and the dashboard reflows so both stay visible. On mobile the phone goes full screen.

## Files

```
backend/
  server.py   FastAPI: WebRTC signalling (/api/offer) + REST for the dashboard
  bot.py      Pipecat pipeline, system prompt, tool schemas and handlers
  db.py       SQLite schema, mock data seeding, availability / book / cancel
frontend/
  src/main.js    dashboard rendering, Pipecat client, call lifecycle, transcript
  src/wave.js    waveform from WebAudio analysers on both audio tracks
  src/sounds.js  ring / hangup / chime, synthesized with WebAudio
```

## Notes

- `POST /api/reset` (the "Reset demo data" link) reseeds the database.
- Times the caller says are resolved by the LLM into ISO dates and 24h times; the backend also accepts `10:30 am`, `2 pm`, etc.
- Gemini model can be overridden with `GEMINI_MODEL` in `.env`.
