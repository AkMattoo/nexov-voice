"""One-line AI summary of a finished call, for the call log."""

import os

from loguru import logger


async def summarize(transcript: list[dict], outcome: str) -> str:
    text = "\n".join(f"{t['role']}: {t['text']}" for t in transcript)[-6000:]
    try:
        from google import genai

        client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
        resp = await client.aio.models.generate_content(
            model=os.getenv("SUMMARY_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-flash-latest",
            contents=(
                "Summarise this clinic phone call for the front desk in one sentence, max 22 words. "
                "Who called, what they wanted, what happened. No preamble.\n\n" + text
            ),
        )
        line = (resp.text or "").strip().split("\n")[0]
        if line:
            return line
    except Exception as e:  # summary is nice-to-have; never break the call log
        logger.warning(f"Summary failed: {e}")
    first = next((t["text"] for t in transcript if t["role"] == "caller"), "")
    return f"Caller: “{first[:80]}” — {outcome}."
