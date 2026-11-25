import { audioCtx } from "./sounds.js";

// Glowing voice orb: a stack of soft, wavy rings that breathe on their own
// and swell with whoever is speaking (Maya = blue, caller = ice white).
export class Wave {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.bot = null;
    this.user = null;
    this.level = 0;
    this.mix = 0; // 0 = Maya colour, 1 = caller colour
    this.t = 0;
    this.raf = null;
    this.start();
  }

  _analyser(track) {
    const ctx = audioCtx();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    src.connect(a); // analysis only
    return { a, buf: new Uint8Array(a.fftSize) };
  }
  attachBot(track) { this.bot = this._analyser(track); }
  attachUser(track) { this.user = this._analyser(track); }

  _lvl(n) {
    if (!n) return 0;
    n.a.getByteTimeDomainData(n.buf);
    let s = 0;
    for (const x of n.buf) s += ((x - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(s / n.buf.length) * 5);
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const b = this._lvl(this.bot), u = this._lvl(this.user);
      const target = Math.max(b, u);
      this.level += (target - this.level) * 0.15;
      this.mix += ((u > b && u > 0.05 ? 1 : 0) - this.mix) * 0.08;
      this.t += 0.012 + this.level * 0.04;
      this.draw();
    };
    loop();
  }

  draw() {
    const { g, c } = this;
    const w = c.width, h = c.height, cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.3;
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";

    // inner glow
    const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
    glow.addColorStop(0, `rgba(60,110,255,${0.05 + this.level * 0.15})`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    const lines = 26;
    for (let i = 0; i < lines; i++) {
      const p = i / lines;
      const r = Math.round(70 + 120 * this.mix + p * 60);
      const gr = Math.round(130 + 90 * this.mix + p * 60);
      g.strokeStyle = `rgba(${r},${gr},255,${0.16 + 0.34 * (1 - Math.abs(p - 0.5) * 2)})`;
      g.lineWidth = 1.2;
      g.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.05) {
        const wob =
          Math.sin(a * 3 + this.t * 1.3 + p * 2.2) * (0.1 + this.level * 0.22) +
          Math.sin(a * 5 - this.t * 0.9 + p * 4) * (0.05 + this.level * 0.12) +
          Math.cos(a * 2 + this.t * 0.6) * 0.06;
        const rr = R * (1 + wob + (p - 0.5) * 0.18);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    // sparkle dust
    for (let i = 0; i < 18; i++) {
      const a = i * 2.4 + this.t * 0.3;
      const rr = R * (1.25 + 0.15 * Math.sin(i + this.t));
      g.fillStyle = `rgba(150,185,255,${0.25 + 0.3 * Math.sin(this.t * 2 + i) ** 2})`;
      g.beginPath();
      g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1.3, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
  }

  stop() {
    this.bot = this.user = null;
  }
}
