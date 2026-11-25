"""FastAPI server: WebRTC signalling for the voice agent + REST for the dashboard."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import uvicorn
from fastapi import BackgroundTasks, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

import db
from bot import run_bot

webrtc = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield
    await webrtc.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    async def on_connection(connection: SmallWebRTCConnection):
        background_tasks.add_task(run_bot, connection)

    return await webrtc.handle_web_request(request=request, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await webrtc.handle_patch_request(request)
    return {"status": "ok"}


@app.get("/api/doctors")
def doctors():
    return db.list_doctors()


@app.get("/api/appointments")
def appointments():
    return db.list_appointments()


@app.get("/api/calls")
def calls():
    return db.list_calls()


@app.post("/api/reset")
def reset():
    db.init_db()
    return {"ok": True}


# Serve the built dashboard if present (frontend/dist), so one command runs everything.
dist = Path(__file__).parent.parent / "frontend" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="ui")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "7860")))
