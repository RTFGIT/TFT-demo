/**
 * sfx.js — tiny synthesised sound effects for the kick (no audio files).
 *
 *   thump()        boot on ball
 *   cheer(big)     crowd swell + a rising chime; bigger for milestones
 *
 * Browsers only allow audio after a user gesture; every call here happens
 * inside the "Make my pledge" click chain, so that's satisfied. Muting is a
 * per-device preference (a classroom may not want noise) kept in localStorage.
 */

const KEY = 'tft26_sound';
let ac = null;

export const sound = {
  get on() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } },
  set on(v) { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch {} }
};

function ctx() {
  if (!sound.on) return null;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch { return null; }
}

function noise(a, secs) {
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * secs), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(); src.buffer = buf;
  return src;
}

/** Unlock the context early (call from the first click) so the kick is on time. */
export function warm() { ctx(); }

export function thump() {
  const a = ctx(); if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator(), g = a.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + 0.25);
  // The leathery "smack" on top.
  const n = noise(a, 0.05), hp = a.createBiquadFilter(), ng = a.createGain();
  hp.type = 'highpass'; hp.frequency.value = 1800;
  ng.gain.setValueAtTime(0.35, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  n.connect(hp).connect(ng).connect(a.destination);
  n.start(t);
}

export function cheer(big = false) {
  const a = ctx(); if (!a) return;
  const t = a.currentTime, dur = big ? 2.4 : 1.5;
  // Crowd: band-passed noise that swells and fades, with a fluttering "roar".
  const n = noise(a, dur), bp = a.createBiquadFilter(), g = a.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(big ? 0.34 : 0.22, t + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lfo = a.createOscillator(), lg = a.createGain();
  lfo.frequency.value = 7; lg.gain.value = 0.06;
  lfo.connect(lg).connect(g.gain);
  n.connect(bp).connect(g).connect(a.destination);
  n.start(t); lfo.start(t); lfo.stop(t + dur);
  // Chime: a quick rising arpeggio — the "you did it" note.
  const notes = big ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((hz, i) => {
    const o = a.createOscillator(), og = a.createGain(), at = t + 0.02 + i * 0.075;
    o.type = 'triangle'; o.frequency.value = hz;
    og.gain.setValueAtTime(0.0001, at);
    og.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    o.connect(og).connect(a.destination);
    o.start(at); o.stop(at + 0.5);
  });
}
