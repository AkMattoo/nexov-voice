"""SQLite store for doctors, slots and appointments.

Mock data is re-seeded on every server start so a demo always begins clean.
Slots are generated for the next few working days relative to today.
"""

import random
import re
import sqlite3
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "clinic.db"
_lock = threading.Lock()

DOCTORS = [
    ("d1", "Dr. Ananya Rao", "General Physician", "Room 104"),
    ("d2", "Dr. Vikram Mehta", "Cardiologist", "Room 210"),
    ("d3", "Dr. Sara Thomas", "Dermatologist", "Room 118"),
    ("d4", "Dr. Arjun Nair", "Orthopedic Surgeon", "Room 305"),
    ("d5", "Dr. Meera Iyer", "Pediatrician", "Room 122"),
]

SLOT_TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
              "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def _working_days(n: int) -> list[date]:
    days, d = [], date.today()
    while len(days) < n:
        d += timedelta(days=1)
        if d.weekday() < 6:  # Mon-Sat
            days.append(d)
    return days


def init_db() -> None:
    with _lock, _conn() as c:
        c.executescript(
            """
            DROP TABLE IF EXISTS appointments;
            DROP TABLE IF EXISTS slots;
            DROP TABLE IF EXISTS doctors;
            CREATE TABLE doctors (id TEXT PRIMARY KEY, name TEXT, speciality TEXT, room TEXT);
            CREATE TABLE slots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doctor_id TEXT, day TEXT, time TEXT, booked INTEGER DEFAULT 0,
                UNIQUE (doctor_id, day, time)
            );
            DROP TABLE IF EXISTS calls;
            CREATE TABLE calls (
                id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, duration_s INTEGER,
                outcome TEXT, phone TEXT, summary TEXT, urgent TEXT, transcript TEXT, events TEXT
            );
            CREATE TABLE appointments (
                id TEXT PRIMARY KEY, slot_id INTEGER, doctor_id TEXT,
                patient_name TEXT, phone TEXT, status TEXT, created_at TEXT
            );
            """
        )
        c.executemany("INSERT INTO doctors VALUES (?,?,?,?)", DOCTORS)
        rng = random.Random(7)
        for doc_id, *_ in DOCTORS:
            for day in _working_days(4):
                # each doctor works a random subset of slots, so availability differs
                for t in SLOT_TIMES:
                    if rng.random() < 0.55:
                        c.execute(
                            "INSERT INTO slots (doctor_id, day, time) VALUES (?,?,?)",
                            (doc_id, day.isoformat(), t),
                        )


# ---------- helpers ----------

def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    return digits


def pretty_day(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%A, %d %B")


def pretty_time(hhmm: str) -> str:
    return datetime.strptime(hhmm, "%H:%M").strftime("%-I:%M %p")


def _norm_time(t: str) -> str | None:
    """Accept '10:30', '10.30', '10:30 AM', '2 pm', '14:00'."""
    t = (t or "").strip().lower().replace(".", ":")
    for fmt in ("%H:%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H"):
        try:
            return datetime.strptime(t, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return None


def find_doctor(query: str | None) -> sqlite3.Row | None:
    if not query:
        return None
    q = query.lower().replace("dr.", "").replace("doctor", "").strip()
    with _conn() as c:
        rows = c.execute("SELECT * FROM doctors").fetchall()
    for r in rows:
        if r["id"] == q:
            return r
    for r in rows:
        name = r["name"].lower().replace("dr.", "")
        if q and (q in name or any(part in name.split() for part in q.split())):
            return r
    for r in rows:
        if q and q in r["speciality"].lower():
            return r
    return None


# ---------- reads (dashboard + tools) ----------

def list_doctors() -> list[dict]:
    with _conn() as c:
        docs = [dict(r) for r in c.execute("SELECT * FROM doctors ORDER BY id")]
        for d in docs:
            d["slots"] = [
                dict(s)
                for s in c.execute(
                    "SELECT id, day, time, booked FROM slots WHERE doctor_id=? ORDER BY day, time",
                    (d["id"],),
                )
            ]
    return docs


def list_appointments() -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            """SELECT a.*, s.day, s.time, d.name AS doctor_name, d.speciality
               FROM appointments a JOIN slots s ON s.id=a.slot_id
               JOIN doctors d ON d.id=a.doctor_id
               ORDER BY a.created_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def availability(doctor: str | None, speciality: str | None, day: str | None) -> dict:
    with _conn() as c:
        sql = """SELECT s.day, s.time, d.id, d.name, d.speciality FROM slots s
                 JOIN doctors d ON d.id=s.doctor_id WHERE s.booked=0"""
        args: list = []
        if doctor:
            doc = find_doctor(doctor)
            if not doc:
                names = [r["name"] for r in c.execute("SELECT name FROM doctors")]
                return {"error": f"No doctor matching '{doctor}'.", "doctors": names}
            sql += " AND d.id=?"
            args.append(doc["id"])
        if speciality and not doctor:
            sql += " AND lower(d.speciality) LIKE ?"
            args.append(f"%{speciality.lower()[:6]}%")
        if day:
            sql += " AND s.day=?"
            args.append(day)
        sql += " ORDER BY s.day, s.time"
        rows = c.execute(sql, args).fetchall()

    out: dict[str, dict] = {}
    for r in rows:
        doc = out.setdefault(r["id"], {"doctor": r["name"], "speciality": r["speciality"], "days": {}})
        doc["days"].setdefault(r["day"], []).append(r["time"])
    # keep the payload small for the LLM: max 3 days, 6 slots each
    for doc in out.values():
        doc["days"] = {
            f"{d} ({pretty_day(d)})": [pretty_time(t) for t in ts[:6]]
            for d, ts in list(doc["days"].items())[:3]
        }
    if not out:
        return {"available": [], "note": "No open slots for that request."}
    return {"available": list(out.values())}


# ---------- writes ----------

def book(phone: str, doctor: str, day: str, time: str, patient_name: str) -> dict:
    phone = normalize_phone(phone)
    if len(phone) != 10:
        return {"ok": False, "error": "Phone number must be 10 digits. Ask the caller again."}
    doc = find_doctor(doctor)
    if not doc:
        return {"ok": False, "error": f"No doctor matching '{doctor}'."}
    t = _norm_time(time)
    if not t:
        return {"ok": False, "error": f"Could not understand the time '{time}'."}
    with _lock, _conn() as c:
        slot = c.execute(
            "SELECT * FROM slots WHERE doctor_id=? AND day=? AND time=?", (doc["id"], day, t)
        ).fetchone()
        if not slot:
            return {"ok": False, "error": f"{doc['name']} has no slot at {pretty_time(t)} on {day}."}
        if slot["booked"]:
            return {"ok": False, "error": "That slot was just taken. Offer another one."}
        appt_id = "A" + datetime.now().strftime("%H%M%S")[-4:] + str(slot["id"]).zfill(2)
        c.execute("UPDATE slots SET booked=1 WHERE id=?", (slot["id"],))
        c.execute(
            "INSERT INTO appointments VALUES (?,?,?,?,?,?,?)",
            (appt_id, slot["id"], doc["id"], patient_name or "Caller", phone, "booked",
             datetime.now().isoformat(timespec="seconds")),
        )
    return {
        "ok": True,
        "appointment_id": appt_id,
        "doctor": doc["name"],
        "speciality": doc["speciality"],
        "room": doc["room"],
        "day": day,
        "when": f"{pretty_day(day)} at {pretty_time(t)}",
        "time": t,
        "phone": phone,
        "patient_name": patient_name or "Caller",
        "slot_id": slot["id"],
    }


def cancel(phone: str, appointment_id: str | None) -> dict:
    phone = normalize_phone(phone)
    with _lock, _conn() as c:
        rows = c.execute(
            """SELECT a.*, s.day, s.time, d.name AS doctor_name FROM appointments a
               JOIN slots s ON s.id=a.slot_id JOIN doctors d ON d.id=a.doctor_id
               WHERE a.phone=? AND a.status='booked' ORDER BY s.day, s.time""",
            (phone,),
        ).fetchall()
        if not rows:
            return {"ok": False, "error": "No active appointment found for that phone number."}
        if appointment_id:
            rows = [r for r in rows if r["id"].lower() == appointment_id.lower()] or rows
        if len(rows) > 1 and not appointment_id:
            return {
                "ok": False,
                "needs_choice": True,
                "appointments": [
                    {"appointment_id": r["id"], "doctor": r["doctor_name"],
                     "when": f"{pretty_day(r['day'])} at {pretty_time(r['time'])}"}
                    for r in rows
                ],
                "error": "Caller has several appointments. Ask which one to cancel.",
            }
        r = rows[0]
        c.execute("UPDATE appointments SET status='cancelled' WHERE id=?", (r["id"],))
        c.execute("UPDATE slots SET booked=0 WHERE id=?", (r["slot_id"],))
    return {
        "ok": True,
        "appointment_id": r["id"],
        "doctor": r["doctor_name"],
        "when": f"{pretty_day(r['day'])} at {pretty_time(r['time'])}",
        "phone": phone,
        "slot_id": r["slot_id"],
    }


def reschedule(phone: str, appointment_id: str | None, doctor: str | None, day: str, time: str) -> dict:
    """Move an existing booking: book the new slot first, then release the old one."""
    phone = normalize_phone(phone)
    with _conn() as c:
        rows = c.execute(
            """SELECT a.*, d.name AS doctor_name FROM appointments a JOIN doctors d ON d.id=a.doctor_id
               WHERE a.phone=? AND a.status='booked'""", (phone,)).fetchall()
    if not rows:
        return {"ok": False, "error": "No active appointment found for that phone number."}
    if appointment_id:
        rows = [r for r in rows if r["id"].lower() == appointment_id.lower()] or rows
    if len(rows) > 1 and not appointment_id:
        return {"ok": False, "needs_choice": True, "error": "Several appointments. Ask which one to move.",
                "appointments": [{"appointment_id": r["id"], "doctor": r["doctor_name"]} for r in rows]}
    old = rows[0]
    new = book(phone, doctor or old["doctor_id"], day, time, old["patient_name"])
    if not new.get("ok"):
        return new
    old_c = cancel(phone, old["id"])
    return {**new, "ok": True, "previous": old_c.get("when"), "previous_slot_id": old_c.get("slot_id"),
            "previous_appointment_id": old["id"]}


# ---------- call log ----------

def save_call(call: dict) -> None:
    import json
    with _lock, _conn() as c:
        c.execute("INSERT OR REPLACE INTO calls VALUES (?,?,?,?,?,?,?,?,?,?)", (
            call["id"], call["started_at"], call["ended_at"], call["duration_s"], call["outcome"],
            call.get("phone"), call.get("summary"), call.get("urgent"),
            json.dumps(call.get("transcript", [])), json.dumps(call.get("events", [])),
        ))


def list_calls() -> list[dict]:
    import json
    with _conn() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM calls ORDER BY started_at DESC")]
    for r in rows:
        r["transcript"] = json.loads(r["transcript"] or "[]")
        r["events"] = json.loads(r["events"] or "[]")
    return rows
