import { audioCtx } from "./sounds.js";

// Live waveform: one row of bars, the bot's voice in green, the caller's in bone.
// Bars scroll right-to-left so the last few seconds of the call stay visible.
export class Wave {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.bot = null;
    this.user = null;
    this.hist = new Array(56).fill({ v: 0.02, who: "idle" });
    this.raf = null;
    this.t = 0;
  }

  _analyser(track) {
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    src.connect(a); // analysis only, not routed to speakers
    return { a, buf: new Uint8Array(a.fftSize) };
  }
  attachBot(track) { this.bot = this._analyser(track); this.start(); }
  attachUser(track) { this.user = this._analyser(track); this.start(); }

  _level(n) {
    if (!n) return 0;
    n.a.getByteTimeDomainData(n.buf);
    let sum = 0;
    for (const x of n.buf) sum += ((x - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / n.buf.length) * 4.5);
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if ((this.t = (this.t + 1) % 3)) return; // ~20 fps push rate
      const b = this._level(this.bot);
      const u = this._level(this.user);
      const who = b > 0.04 && b >= u ? "bot" : u > 0.04 ? "user" : "idle";
      this.hist.push({ v: Math.max(0.02, Math.max(b, u)), who });
      this.hist.shift();
      this.draw();
    };
    loop();
  }

  draw() {
    const { g, c } = this;
    const w = c.width, h = c.height, n = this.hist.length;
    const step = w / n, bw = step * 0.5;
    g.clearRect(0, 0, w, h);
    this.hist.forEach((p, i) => {
      const bh = Math.max(4, p.v * h * 0.9);
      g.fillStyle = p.who === "bot" ? "#f0a73a" : p.who === "user" ? "#ecebe7" : "#33302b";
      g.globalAlpha = 0.35 + 0.65 * (i / n);
      const x = i * step + (step - bw) / 2;
      const y = (h - bh) / 2;
      g.beginPath();
      g.roundRect(x, y, bw, bh, bw / 2);
      g.fill();
    });
    g.globalAlpha = 1;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.bot = this.user = null;
    this.hist = this.hist.map(() => ({ v: 0.02, who: "idle" }));
    this.draw();
  }
}
