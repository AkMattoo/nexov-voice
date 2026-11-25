import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { sounds } from "./sounds.js";
import { Wave } from "./wave.js";

const $ = (id) => document.getElementById(id);
const API = import.meta.env.VITE_API_URL || "";

// ---------------------------------------------------------------- data
const state = { doctors: [], appts: [], day: null, focusDoc: null, flash: {}, fresh: {} };

async function load() {
  const [d, a] = await Promise.all([
    fetch(`${API}/api/doctors`).then((r) => r.json()),
    fetch(`${API}/api/appointments`).then((r) => r.json()),
  ]);
  state.doctors = d;
  state.appts = a;
  const days = allDays();
  if (!state.day || !days.includes(state.day)) state.day = days[0];
  render();
}

const allDays = () => [...new Set(state.doctors.flatMap((d) => d.slots.map((s) => s.day)))].sort();
const allTimes = () => [...new Set(state.doctors.flatMap((d) => d.slots.map((s) => s.time)))].sort();

const fmt = {
  dow: (iso) => new Date(iso + "T00:00").toLocaleDateString("en-GB", { weekday: "short" }),
  dom: (iso) => new Date(iso + "T00:00").getDate(),
  mon: (iso) => new Date(iso + "T00:00").toLocaleDateString("en-GB", { month: "short" }),
  long: (iso) => new Date(iso + "T00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
  time: (t) => {
    const [h, m] = t.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? "a" : "p"}`;
  },
  phone: (p) => (p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p),
};

// ---------------------------------------------------------------- render
function render() {
  renderDays();
  renderGrid();
  renderAppts();
}

function renderDays() {
  $("dayTabs").innerHTML = allDays()
    .map(
      (d) => `<button role="tab" data-day="${d}" aria-selected="${d === state.day}">
        <b>${fmt.dow(d)} ${fmt.dom(d)}</b>${openOn(d)} open</button>`
    )
    .join("");
}

const openOn = (day) =>
  state.doctors.reduce((n, d) => n + d.slots.filter((s) => s.day === day && !s.booked).length, 0);

function renderGrid() {
  const times = allTimes();
  const firstPm = times.findIndex((t) => t >= "13:00");
  $("boardTitle").textContent = fmt.long(state.day);
  $("boardSub").textContent = `${state.doctors.length} doctors · ${openOn(state.day)} open slots`;

  const head = `<div class="g-head" style="--cols:${times.length}">
      <span>Doctor</span>${times.map((t, i) => `<span class="${i === firstPm ? "gap" : ""}">${t}</span>`).join("")}
    </div>`;

  const rows = state.doctors
    .map((doc) => {
      const byTime = Object.fromEntries(doc.slots.filter((s) => s.day === state.day).map((s) => [s.time, s]));
      const free = Object.values(byTime).filter((s) => !s.booked).length;
      const cells = times
        .map((t, i) => {
          const s = byTime[t];
          const cls = !s ? "none" : s.booked ? "taken" : "open";
          const fl = s && state.flash[s.id] ? ` flash-${state.flash[s.id]}` : "";
          const tip = s ? `${doc.name} · ${fmt.time(t)} · ${s.booked ? "booked" : "open"}` : "";
          return `<div class="cell${i === firstPm ? " gap" : ""}"><button class="slot ${cls}${fl}" ${
            s ? `data-tip="${tip}" data-slot="${s.id}"` : "disabled"
          } aria-label="${tip || "off"}"></button></div>`;
        })
        .join("");
      return `<div class="g-row${state.focusDoc === doc.id ? " focus" : ""}" style="--cols:${times.length}">
          <div class="doc"><div class="doc-name">${doc.name}</div>
          <div class="doc-spec">${doc.speciality}<span class="free">· ${free}</span></div></div>${cells}</div>`;
    })
    .join("");

  $("grid").innerHTML = head + rows;
}

function renderAppts() {
  const list = state.appts;
  $("apptCount").textContent = list.filter((a) => a.status === "booked").length;
  $("apptEmpty").style.display = list.length ? "none" : "block";
  $("appts").innerHTML = list
    .map((a) => {
      const f = state.fresh[a.id];
      return `<li class="appt ${a.status}${f === "book" ? " new" : ""}${f === "cancel" ? " just-cancelled" : ""}">
        <div class="date"><b>${fmt.dom(a.day)}</b><span>${fmt.mon(a.day)}</span></div>
        <div class="who"><div>${a.patient_name}</div><div>${a.doctor_name} · ${a.speciality}</div></div>
        <div class="meta"><b>${fmt.time(a.time)}</b>${
          a.status === "cancelled" ? `<span class="tag c">cancelled</span>` : fmt.phone(a.phone)
        }</div></li>`;
    })
    .join("");
}

$("dayTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-day]");
  if (!b) return;
  state.day = b.dataset.day;
  render();
});

// slot tooltip
const tip = Object.assign(document.createElement("div"), { className: "tip" });
document.body.append(tip);
$("grid").addEventListener("pointerover", (e) => {
  const s = e.target.closest("[data-tip]");
  if (!s) return (tip.style.opacity = 0);
  const r = s.getBoundingClientRect();
  tip.textContent = s.dataset.tip;
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${r.top}px`;
  tip.style.opacity = 1;
});
$("grid").addEventListener("pointerleave", () => (tip.style.opacity = 0));

$("resetBtn").addEventListener("click", async () => {
  await fetch(`${API}/api/reset`, { method: "POST" });
  state.flash = {};
  state.fresh = {};
  load();
});

// ---------------------------------------------------------------- live events from the agent
function mark(map, key, val, ms = 2600) {
  map[key] = val;
  setTimeout(() => {
    delete map[key];
    render();
  }, ms);
}

const TOOL_LABEL = {
  check_doctor_availability: (a) => `checking ${a.doctor_name || a.speciality || "the"} calendar`,
  book_appointment: () => "booking the slot",
  cancel_appointment: () => "finding the appointment",
};

async function onServerMessage(msg) {
  if (msg.type === "tool") {
    activity(TOOL_LABEL[msg.name]?.(msg.args || {}) || "working");
  }
  if (msg.type === "availability") {
    activity(null);
    const a = msg.args || {};
    if (a.date && allDays().includes(a.date)) state.day = a.date;
    const q = (a.doctor_name || a.speciality || "").toLowerCase().replace("dr.", "").trim();
    const doc = q && state.doctors.find((d) => (d.name + " " + d.speciality).toLowerCase().includes(q.split(" ").pop()));
    if (doc) {
      state.focusDoc = doc.id;
      setTimeout(() => ((state.focusDoc = null), renderGrid()), 6000);
    }
    render();
  }
  if (msg.type === "booked" || msg.type === "cancelled") {
    activity(null);
    const ap = msg.appointment;
    const kind = msg.type === "booked" ? "book" : "cancel";
    mark(state.flash, ap.slot_id, kind);
    mark(state.fresh, ap.appointment_id, kind, 4000);
    await load();
    const slot = state.doctors.flatMap((d) => d.slots).find((s) => s.id === ap.slot_id);
    if (slot && slot.day !== state.day) {
      state.day = slot.day;
      render();
    }
    confirmCard(kind, ap);
    sounds.chime();
  }
}

// ---------------------------------------------------------------- phone
const phone = $("phone");
const wave = new Wave($("wave"));
let client = null;
let timer = null;
let startedAt = 0;
let muted = false;

function setCall(s, label) {
  phone.dataset.state = s;
  $("callStatus").textContent = label;
  const pill = $("agentPill");
  pill.classList.toggle("live", s === "connected");
  pill.querySelector("span").textContent = `Maya · ${s === "connected" ? "on call" : s === "ringing" ? "connecting" : "idle"}`;
  $("tryCall").disabled = s === "ringing" || s === "connected";
}

function openPhone() {
  document.body.classList.add("in-call");
  $("phoneLayer").classList.add("open");
  $("phoneLayer").setAttribute("aria-hidden", "false");
}
function closePhone() {
  document.body.classList.remove("in-call");
  $("phoneLayer").classList.remove("open");
  $("phoneLayer").setAttribute("aria-hidden", "true");
  setTimeout(() => setCall("idle", ""), 600);
}

function activity(text) {
  const el = $("activity");
  el.classList.toggle("on", !!text);
  if (text) el.textContent = text;
}

function tickClock() {
  $("phoneClock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
tickClock();
setInterval(tickClock, 15000);

function startTimer() {
  startedAt = Date.now();
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("callStatus").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

// transcript ----------------------------------------------------------
const tx = $("transcript");
let botBubble = null;
let botSegs = new Map();
let userInterim = null;

function scroll() {
  tx.scrollTop = tx.scrollHeight;
}
function addMsg(cls, text) {
  const el = Object.assign(document.createElement("div"), { className: `msg ${cls}`, textContent: text });
  tx.append(el);
  scroll();
  return el;
}

function onUserTranscript({ text, final }) {
  if (!text?.trim()) return;
  botBubble = null; // next bot words start a new bubble
  botSegs = new Map();
  if (!userInterim) userInterim = addMsg("user interim", text);
  userInterim.textContent = text;
  if (final) {
    userInterim.classList.remove("interim");
    userInterim = null;
  }
  scroll();
}

function onBotOutput(d) {
  if (!d?.text && !d?.spoken_progress) return;
  if (d.output_type === "word" || d.output_type === "token") return;
  if (!botBubble) botBubble = addMsg("bot", "");
  const id = d.segment_id ?? `s${botSegs.size}`;
  const p = d.spoken_progress;
  const seg = botSegs.get(id) || { full: "", spoken: "" };
  if (p) {
    seg.spoken = p.accumulated_text || "";
    seg.full = (p.accumulated_text || "") + (p.remaining_text || "");
  } else {
    seg.full = d.text;
    seg.spoken = d.spoken_status === "completed" ? d.text : seg.spoken;
  }
  if (d.spoken_status === "completed") seg.spoken = seg.full;
  botSegs.set(id, seg);
  // show everything that's been said; unsaid remainder is faint until spoken
  botBubble.innerHTML = [...botSegs.values()]
    .map((s) => {
      const rest = s.full.slice(s.spoken.length);
      return `${esc(s.spoken)}<span style="opacity:.45">${esc(rest)}</span>`;
    })
    .join(" ");
  scroll();
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function confirmCard(kind, ap) {
  botBubble = null;
  botSegs = new Map();
  const el = document.createElement("div");
  el.className = `card${kind === "cancel" ? " cancel" : ""}`;
  el.innerHTML =
    kind === "book"
      ? `<div class="k"><span>Booked</span><span>${ap.appointment_id}</span></div>
         <div class="t">${ap.doctor}</div><div class="s">${ap.speciality} · ${ap.room}</div>
         <div class="row"><span>${ap.when}</span><span>${fmt.phone(ap.phone)}</span></div>`
      : `<div class="k"><span>Cancelled</span><span>${ap.appointment_id}</span></div>
         <div class="t">${ap.doctor}</div><div class="s">Slot released</div>
         <div class="row"><span>${ap.when}</span><span>${fmt.phone(ap.phone)}</span></div>`;
  tx.append(el);
  scroll();
}

// call lifecycle ------------------------------------------------------
async function startCall() {
  tx.innerHTML = "";
  botBubble = null;
  botSegs = new Map();
  userInterim = null;
  muted = false;
  $("muteBtn").classList.remove("on");
  activity(null);
  openPhone();
  setCall("ringing", "Calling…");
  sounds.ring();

  client = new PipecatClient({
    transport: new SmallWebRTCTransport(),
    enableMic: true,
    enableCam: false,
    callbacks: {
      onBotReady: () => {
        sounds.stopRing();
        setCall("connected", "00:00");
        startTimer();
      },
      onDisconnected: () => endCall(false),
      onUserTranscript,
      onBotOutput,
      onServerMessage,
      onTrackStarted: (track, p) => {
        if (track.kind === "audio" && p && !p.local) {
          $("botAudio").srcObject = new MediaStream([track]);
          wave.attachBot(track);
        }
        if (track.kind === "audio" && p?.local) wave.attachUser(track);
      },
      onError: (e) => console.error("pipecat error", e),
    },
  });

  try {
    await client.connect({ webrtcRequestParams: { endpoint: `${API}/api/offer` } });
  } catch (e) {
    console.error(e);
    sounds.stopRing();
    setCall("ended", "Couldn't connect");
    addMsg("bot", "The agent isn't reachable. Is the backend running on port 7860?");
  }
}

let ending = false;
async function endCall(userInitiated = true) {
  if (ending || phone.dataset.state === "ended" || phone.dataset.state === "idle") return;
  ending = true;
  sounds.stopRing();
  clearInterval(timer);
  const secs = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  startedAt = 0;
  setCall("ended", secs ? `Call ended · ${Math.floor(secs / 60)}m ${secs % 60}s` : "Call ended");
  activity(null);
  wave.stop();
  sounds.hangup();
  if (userInitiated && client) {
    try { await client.disconnect(); } catch {}
  }
  client = null;
  ending = false;
}

$("tryCall").addEventListener("click", startCall);
$("endBtn").addEventListener("click", () => endCall(true));
$("closeBtn").addEventListener("click", closePhone);
$("muteBtn").addEventListener("click", () => {
  if (!client) return;
  muted = !muted;
  client.enableMic(!muted);
  $("muteBtn").classList.toggle("on", muted);
  $("muteBtn").querySelector("span").textContent = muted ? "unmute" : "mute";
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && phone.dataset.state === "ended") closePhone();
});

// keep the board fresh if something changes outside a call
setInterval(() => !client && load(), 15000);
load().catch(() => {
  $("boardSub").textContent = "Backend not reachable on :7860";
});
