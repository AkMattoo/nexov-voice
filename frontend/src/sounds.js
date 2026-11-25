// Tiny synthesized call sounds, no audio assets needed.
let ctx;
export const audioCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

function tone(freqs, start, dur, gain = 0.06) {
  const c = audioCtx();
  const g = c.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, start + dur);
  g.connect(c.destination);
  freqs.forEach((f) => {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(start);
    o.stop(start + dur);
  });
}

let ringTimer = null;
export const sounds = {
  // UK/India-style double ring: 400+450 Hz, two short bursts, repeat
  ring() {
    const c = audioCtx();
    c.resume();
    const once = () => {
      const t = c.currentTime + 0.05;
      tone([400, 450], t, 0.4);
      tone([400, 450], t + 0.6, 0.4);
    };
    once();
    ringTimer = setInterval(once, 2400);
  },
  stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
  },
  hangup() {
    const t = audioCtx().currentTime + 0.05;
    [0, 0.22, 0.44].forEach((d) => tone([480, 620], t + d, 0.14, 0.05));
  },
  chime() {
    const t = audioCtx().currentTime + 0.02;
    tone([880], t, 0.12, 0.035);
    tone([1320], t + 0.1, 0.22, 0.03);
  },
};
