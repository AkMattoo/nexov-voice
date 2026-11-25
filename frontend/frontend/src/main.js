import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { sounds } from "./sounds.js";
import { Wave } from "./wave.js";

const $ = (id) => document.getElementById(id);
const API = import.meta.env.VITE_API_URL || "";

// ---------------------------------------------------------------- data
const state = { doctors: [], appts: [], calls: [], day: null, focusDoc: null, flash: {}, fresh: {}, freshCall: null };

async function load() {
  const [d, a, c] = await Promise.all([
    fetch(`${API}/api/doctors`).then((r) => r.json()),
    fetch(`${API}/api/appointments`).then((r) => r.json()),
    fetch(`${API}/api/calls`).then((r) => r.json()),
  ]);
  state.doctors = d;
  state.appts = a;
  state.calls = c;
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
  phone: (p) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p || "—"),
  dur: (s) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`),
  clock: (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
};

// ---------------------------------------------------------------- render
function render() {
  renderDays();
  renderGrid();
  renderAppts();
  renderCalls();
  renderKpis();
}

// ---------------------------------------------------------------- KPIs (Krittiya-style call analytics)
let lastKpi = {};
function renderKpis() {
  const today = new Date().toDateString();
  const calls = state.calls.filter((c) => new Date(c.started_at).toDateString() === today);
  const booked = state.appts.filter((a) => a.status === "booked").length;
  const converted = calls.filter((c) => ["booked", "rescheduled"].includes(c.outcome)).length;
  const avg = calls.length ? Math.round(calls.reduce((n, c) => n + (c.duration_s || 0), 0) / calls.length) : null;
  const vals = {
    kCalls: String(calls.length),
    kBooked: String(booked),
    kRate: calls.length ? `${Math.round((converted / calls.length) * 100)}%` : "—",
    kAvg: fmt.dur(avg),
  };
  for (const [id, v] of Object.entries(vals)) {
    const el = $(id);
    if (lastKpi[id] !== undefined && lastKpi[id] !== v) {
      el.classList.add("bump");
      setTimeout(() => el.classList.remove("bump"), 1200);
    }
    el.textContent = v;
  }
  lastKpi = vals;

  // calls by hour, 8:00 to 20:00
  const hours = Array.from({ length: 13 }, (_, i) => i + 8);
  const counts = hours.map((h) => calls.filter((c) => new Date(c.started_at).getHours() === h).length);
  const max = Math.max(1, ...counts);
  const now = new Date().getHours();
  $("spark").innerHTML = hours
    .map((h, i) => `<i class="${counts[i] ? "on" : ""}${h === now ? " now" : ""}" style="height:${Math.max(8, (counts[i] / max) * 100)}%" title="${h}:00 · ${counts[i]} call${counts[i] === 1 ? "" : "s"}"></i>`)
    .join("");
}

// ---------------------------------------------------------------- call log + drawer
const OUTCOME = { booked: "booked", rescheduled: "rescheduled", cancelled: "cancelled", urgent: "urgent", "no action": "none" };
function renderCalls() {
  $("callCount").textContent = state.calls.length;
  $("callEmpty").style.display = state.calls.length ? "none" : "block";
  $("calls").innerHTML = state.calls
    .map((c) => {
      const emergency = c.urgent?.startsWith("emergency");
      const pill = emergency ? "emergency" : OUTCOME[c.outcome] || "none";
      return `<li><button class="call-row${state.freshCall === c.id ? " new" : ""}" data-call="${c.id}">
        <div class="cr-top"><span class="pill ${pill}">${emergency ? "emergency" : c.outcome}</span>
          <span>${fmt.clock(c.started_at)}</span><span>${fmt.phone(c.phone)}</span><span class="dur">${fmt.dur(c.duration_s)}</span></div>
        <div class="cr-sum">${esc(c.summary || "")}</div></button></li>`;
    })
    .join("");
}

let drawerCall = null;
function openDrawer(id, tab = "summary") {
  const c = state.calls.find((x) => x.id === id);
  if (!c) return;
  drawerCall = c;
  $("dId").textContent = `${c.id} · ${new Date(c.started_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  $("dTitle").textContent = c.outcome === "no action" ? "Enquiry" : c.outcome[0].toUpperCase() + c.outcome.slice(1);
  $("dMeta").innerHTML = `<div><span>Duration</span><b>${fmt.dur(c.duration_s)}</b></div>
    <div><span>Caller</span><b>${fmt.phone(c.phone)}</b></div>
    <div><span>Turns</span><b>${c.transcript.length}</b></div>`;
  drawerTab(tab);
  $("drawerLayer").hidden = false;
}
function drawerTab(tab) {
  const c = drawerCall;
  document.querySelectorAll("[data-dtab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.dtab === tab));
  if (tab === "summary") {
    const actions = c.events.filter((e) => ["booked", "rescheduled", "cancelled"].includes(e.kind));
    $("dBody").innerHTML = `<p class="d-sum">${esc(c.summary || "")}</p>
      ${c.urgent ? `<div class="d-label">Flag</div><div class="d-flag">${esc(c.urgent)}</div>` : ""}
      <div class="d-label">Actions</div>
      ${actions.length ? actions.map((e) => `<div class="d-turn"><span>${e.kind}</span><div>${esc(e.doctor || "")} · ${esc(e.when || "")}${e.previous ? ` <span class="muted">(was ${esc(e.previous)})</span>` : ""}</div></div>`).join("") : `<p class="muted small">No changes to the schedule.</p>`}`;
  } else if (tab === "transcript") {
    $("dBody").innerHTML = c.transcript.map((t) => `<div class="d-turn ${t.role}"><span>${t.role}</span><div>${esc(t.text)}</div></div>`).join("") || `<p class="muted small">No transcript.</p>`;
  } else {
    const label = {
      availability: (e) => `Checked availability · ${esc(e.query)}${e.date ? ` · ${e.date}` : ""}`,
      booked: (e) => `Booked ${e.id} · ${esc(e.doctor)} · ${esc(e.when)}`,
      rescheduled: (e) => `Moved ${e.id} to ${esc(e.when)}`,
      cancelled: (e) => `Cancelled ${e.id} · ${esc(e.when)}`,
      urgent: (e) => `Flagged ${e.level} · ${esc(e.symptom)}`,
      failed: (e) => `${e.tool} refused · ${esc(e.reason || "")}`,
    };
    $("dBody").innerHTML = c.events.length
      ? `<ol class="tl">${c.events.map((e) => `<li class="${e.kind}"><span class="t">${fmt.dur(Math.round(e.t))}</span>${(label[e.kind] || (() => e.kind))(e)}</li>`).join("")}</ol>`
      : `<p class="muted small">No tool calls on this call.</p>`;
  }
}
$("calls").addEventListener("click", (e) => {
  const b = e.target.closest("[data-call]");
  if (b) openDrawer(b.dataset.call);
});
document.querySelectorAll("[data-dtab]").forEach((b) => b.addEventListener("click", () => drawerTab(b.dataset.dtab)));
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => ($("drawerLayer").hidden = true)));

function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  $("pane-appts").hidden = name !== "appts";
  $("pane-calls").hidden = name !== "calls";
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

function showAlert(level, symptom) {
  $("alert").hidden = false;
  $("alert").className = `alert ${level === "emergency" ? "" : "urgent"}`;
  $("alertLevel").textContent = level === "emergency" ? "Emergency" : "Urgent";
  $("alertText").textContent = `Caller reports ${symptom}`;
}
$("alertX").addEventListener("click", () => ($("alert").hidden = true));

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
          <div class="doc">${avatar(doc)}<div class="doc-txt"><div class="doc-name">${doc.name}</div>
          <div class="doc-spec">${doc.speciality}<span class="free">· ${free}</span></div></div></div>${cells}</div>`;
    })
    .join("");

  $("grid").innerHTML = head + rows;
}

// Illustrated, gently animated doctor portraits (pure SVG, no image assets).
const LOOKS = {
  d1: { bg: ["#cfe0ff", "#8fb2ff"], skin: "#e9b48f", hair: "#2b1d16", long: true },
  d2: { bg: ["#d7f0ff", "#7fc4ef"], skin: "#c68b63", hair: "#1c1c22", long: false, beard: true },
  d3: { bg: ["#ffe3ec", "#f3a5bf"], skin: "#f1c6a5", hair: "#5a3424", long: true },
  d4: { bg: ["#e2f6e9", "#93d3ac"], skin: "#a86f4c", hair: "#121212", long: false },
  d5: { bg: ["#fff1d6", "#f7c67a"], skin: "#d9a07a", hair: "#2a1a12", long: true, bun: true },
};
function avatar(doc) {
  const L = LOOKS[doc.id] || LOOKS.d1;
  const id = doc.id;
  const hair = L.long
    ? `<path d="M15 30c0-12 7-19 17-19s17 7 17 19v14c-3 2-6 2-8 0V30H23v14c-2 2-5 2-8 0z" fill="${L.hair}"/>`
    : `<path d="M17 28c0-10 6-15 15-15s15 5 15 15c-3-4-8-6-15-6s-12 2-15 6z" fill="${L.hair}"/>`;
  return `<span class="av" style="--d:${(parseInt(id.slice(1)) * 0.7).toFixed(1)}s">
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${L.bg[0]}"/><stop offset="1" stop-color="${L.bg[1]}"/></linearGradient>
    <clipPath id="c${id}"><circle cx="32" cy="32" r="32"/></clipPath></defs>
    <g clip-path="url(#c${id})">
      <rect width="64" height="64" fill="url(#g${id})"/>
      <g class="av-body">
        <path d="M8 66c2-12 11-18 24-18s22 6 24 18z" fill="#fff"/>
        <path d="M27 48l5 8 5-8" fill="#dfe8f7"/>
        <path d="M22 51c0 8 4 11 6 11" stroke="#2459e0" stroke-width="1.6" fill="none"/><circle cx="28" cy="62" r="2" fill="#2459e0"/>
        <rect x="28" y="40" width="8" height="9" rx="3" fill="${L.skin}"/>
        ${L.bun ? `<circle cx="32" cy="12" r="6" fill="${L.hair}"/>` : ""}
        ${L.long ? hair : ""}
        <ellipse cx="32" cy="31" rx="12" ry="13.5" fill="${L.skin}"/>
        ${L.long ? "" : hair}
        ${L.long ? `<path d="M20 28c2-8 7-11 12-11s10 3 12 11c-6-3-12-5-24 0z" fill="${L.hair}"/>` : ""}
        ${L.beard ? `<path d="M21 33c1 9 6 12 11 12s10-3 11-12c-2 4-6 6-11 6s-9-2-11-6z" fill="${L.hair}" opacity=".85"/>` : ""}
        <g class="av-eyes"><ellipse cx="27.5" cy="31" rx="1.4" ry="1.7" fill="#1b1b1f"/><ellipse cx="36.5" cy="31" rx="1.4" ry="1.7" fill="#1b1b1f"/></g>
        <path d="M28.5 37c2 1.6 5 1.6 7 0" stroke="#7a3b2a" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <circle cx="25" cy="35" r="1.8" fill="#f28b8b" opacity=".35"/><circle cx="39" cy="35" r="1.8" fill="#f28b8b" opacity=".35"/>
      </g>
    </g>
  </svg></span>`;
}

function renderAppts() {
  const list = state.appts;
  $("apptCount").textContent = list.filter((a) => a.status === "booked").length;
  $("apptEmpty").style.display = list.length ? "none" : "block";
  $("appts").innerHTML = list
    .map((a) => {
      const f = state.fresh[a.id];
      return `<li class="appt ${a.status}${f === "book" ? " new" : ""}${f === "move" ? " moved" : ""}${f === "cancel" ? " just-cancelled" : ""}">
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
  $("alert").hidden = true;
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
  reschedule_appointment: () => "moving the appointment",
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
  if (msg.type === "urgent") {
    showAlert(msg.level, msg.symptom);
    urgentCard(msg.level, msg.symptom);
  }
  if (["booked", "cancelled", "rescheduled"].includes(msg.type)) {
    activity(null);
    const ap = msg.appointment;
    const kind = { booked: "book", cancelled: "cancel", rescheduled: "move" }[msg.type];
    mark(state.flash, ap.slot_id, kind);
    if (ap.previous_slot_id) mark(state.flash, ap.previous_slot_id, "cancel");
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
  el.className = `card${kind === "cancel" ? " cancel" : kind === "move" ? " move" : ""}`;
  el.innerHTML =
    kind === "move"
      ? `<div class="k"><span>Rescheduled</span><span>${ap.appointment_id}</span></div>
         <div class="t">${ap.doctor}</div><div class="s">was ${ap.previous || "—"}</div>
         <div class="row"><span>${ap.when}</span><span>${fmt.phone(ap.phone)}</span></div>`
      : kind === "book"
      ? `<div class="k"><span>Booked</span><span>${ap.appointment_id}</span></div>
         <div class="t">${ap.doctor}</div><div class="s">${ap.speciality} · ${ap.room}</div>
         <div class="row"><span>${ap.when}</span><span>${fmt.phone(ap.phone)}</span></div>`
      : `<div class="k"><span>Cancelled</span><span>${ap.appointment_id}</span></div>
         <div class="t">${ap.doctor}</div><div class="s">Slot released</div>
         <div class="row"><span>${ap.when}</span><span>${fmt.phone(ap.phone)}</span></div>`;
  tx.append(el);
  scroll();
}

function urgentCard(level, symptom) {
  botBubble = null;
  botSegs = new Map();
  const el = document.createElement("div");
  el.className = "card alert-card";
  el.innerHTML = `<div class="k"><span>${level === "emergency" ? "Emergency" : "Urgent"} flag</span><span>front desk notified</span></div>
    <div class="t">${esc(symptom || "")}</div>
    <div class="s">${level === "emergency" ? "Advised to call 112 / go to ER" : "Prioritising earliest slot"}</div>`;
  tx.append(el);
  scroll();
}

// pull the call log a few times after hang-up; the AI summary takes a moment
async function refreshCallsAfterHangup() {
  const before = state.calls.length;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await load();
    if (state.calls.length > before) {
      state.freshCall = state.calls[0].id;
      showTab("calls");
      render();
      setTimeout(() => ((state.freshCall = null), renderCalls()), 4000);
      return;
    }
  }
}

function playBot(track) {
  const el = $("botAudio");
  if (el.srcObject?.getAudioTracks?.()[0]?.id === track.id) return;
  el.srcObject = new MediaStream([track]);
  el.muted = false;
  el.volume = 1;
  el.play().catch((e) => console.warn("audio play blocked", e));
  wave.attachBot(track);
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
        // fallback in case onTrackStarted fired before we were listening
        const t = client?.tracks?.()?.bot?.audio;
        if (t) playBot(t);
        sounds.stopRing();
        setCall("connected", "00:00");
        startTimer();
      },
      onDisconnected: () => endCall(false),
      onUserTranscript,
      onBotOutput,
      onServerMessage,
      onTrackStarted: (track, p) => {
        if (track.kind !== "audio") return;
        if (p?.local) return wave.attachUser(track);
        playBot(track); // anything not local is Maya
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
  refreshCallsAfterHangup();
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
  if (e.key !== "Escape") return;
  if (!$("drawerLayer").hidden) $("drawerLayer").hidden = true;
  else if (phone.dataset.state === "ended") closePhone();
});

// keep the board fresh if something changes outside a call
setInterval(() => !client && load(), 15000);
load().catch(() => {
  $("boardSub").textContent = "Backend not reachable on :7860";
});
