#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BPM = 128;
const BEAT = 60 / BPM;
const DURATION = 32 * BEAT;
const FRAMES = Math.round(DURATION * SAMPLE_RATE);
const outputPath = path.resolve(
  __dirname,
  "../../artifacts/brand-reel-20261006/audio.wav",
);

const left = new Float64Array(FRAMES);
const right = new Float64Array(FRAMES);
let noiseState = 0x4c414258;

function random() {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return (noiseState >>> 0) / 0x1_0000_0000;
}

function panGains(pan = 0) {
  const angle = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

function mix(startSeconds, durationSeconds, pan, voice) {
  const start = Math.max(0, Math.round(startSeconds * SAMPLE_RATE));
  const length = Math.min(
    Math.round(durationSeconds * SAMPLE_RATE),
    FRAMES - start,
  );
  const [gainL, gainR] = panGains(pan);
  for (let i = 0; i < length; i += 1) {
    const sample = voice(i / SAMPLE_RATE, i, length);
    left[start + i] += sample * gainL;
    right[start + i] += sample * gainR;
  }
}

function atBeat(beat) {
  return beat * BEAT;
}

function kick(beat, gain = 1) {
  mix(atBeat(beat), 0.48, 0, (t) => {
    const bodyEnv = Math.exp(-t * 9.2);
    const phase = 2 * Math.PI * (47 * t + (120 / 48) * (1 - Math.exp(-48 * t)));
    const body = Math.sin(phase) * bodyEnv;
    const knock = Math.sin(2 * Math.PI * 165 * t) * Math.exp(-t * 42);
    const click = (random() * 2 - 1) * Math.exp(-t * 150);
    return gain * (0.92 * body + 0.18 * knock + 0.055 * click);
  });
}

function clap(beat, gain = 0.72) {
  mix(atBeat(beat), 0.34, 0.08, (t) => {
    const bursts = [0, 0.018, 0.039].reduce((sum, offset) => {
      const local = t - offset;
      return local >= 0 ? sum + Math.exp(-local * 58) : sum;
    }, 0);
    const tail = t > 0.044 ? 0.42 * Math.exp(-(t - 0.044) * 15) : 0;
    const tone = 0.13 * Math.sin(2 * Math.PI * 194 * t) * Math.exp(-t * 18);
    const noisy = (random() * 2 - 1) * (bursts + tail);
    return gain * (0.78 * noisy + tone);
  });
}

function hat(beat, gain = 0.17, open = false, pan = 0) {
  const duration = open ? 0.24 : 0.075;
  let previous = 0;
  mix(atBeat(beat), duration, pan, (t) => {
    const white = random() * 2 - 1;
    const high = white - previous * 0.82;
    previous = white;
    const metallic =
      Math.sin(2 * Math.PI * 7_931 * t) +
      0.5 * Math.sin(2 * Math.PI * 10_657 * t);
    const decay = open ? 15 : 54;
    return gain * (0.75 * high + 0.12 * metallic) * Math.exp(-t * decay);
  });
}

function sub(beat, beats, midi, gain = 0.34, glideFrom = null) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const fromFrequency =
    glideFrom == null ? frequency : 440 * 2 ** ((glideFrom - 69) / 12);
  const duration = beats * BEAT;
  let phase = 0;
  mix(atBeat(beat), duration + 0.1, 0, (t) => {
    const attack = 1 - Math.exp(-t * 70);
    const releaseStart = Math.max(0.04, duration - 0.08);
    const release = t < releaseStart ? 1 : Math.exp(-(t - releaseStart) * 24);
    const glide = Math.min(1, t / 0.065);
    const hz = fromFrequency * (frequency / fromFrequency) ** glide;
    phase += (2 * Math.PI * hz) / SAMPLE_RATE;
    const fundamental = Math.sin(phase);
    const harmonic = 0.16 * Math.sin(phase * 2);
    return Math.tanh((fundamental + harmonic) * 1.45) * gain * attack * release;
  });
}

function pluck(beat, midi, gain = 0.19, pan = 0) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  mix(atBeat(beat), 0.62, pan, (t) => {
    const env = (1 - Math.exp(-t * 100)) * Math.exp(-t * 7.4);
    const phase = 2 * Math.PI * frequency * t;
    const fm = Math.sin(
      phase + 1.25 * Math.sin(phase * 2.01) * Math.exp(-t * 8),
    );
    const octave = 0.23 * Math.sin(phase * 2 + 0.4);
    return gain * (fm + octave) * env;
  });
}

function chord(beat, beats, midiNotes, gain = 0.095, panSpread = 0.62) {
  midiNotes.forEach((midi, index) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const pan =
      midiNotes.length === 1
        ? 0
        : -panSpread + (2 * panSpread * index) / (midiNotes.length - 1);
    mix(atBeat(beat), beats * BEAT + 1.1, pan, (t) => {
      const sustain = beats * BEAT;
      const attack = 1 - Math.exp(-t * 4.8);
      const release = t < sustain ? 1 : Math.exp(-(t - sustain) * 3.4);
      const shimmer =
        0.68 * Math.sin(2 * Math.PI * frequency * t) +
        0.21 * Math.sin(2 * Math.PI * frequency * 2.002 * t + 0.3) +
        0.11 * Math.sin(2 * Math.PI * frequency * 3.997 * t + 0.8);
      return gain * shimmer * attack * release;
    });
  });
}

function impact() {
  let lowNoise = 0;
  mix(0, 1.25, 0, (t) => {
    lowNoise += (random() * 2 - 1 - lowNoise) * 0.025;
    const boomPhase = 2 * Math.PI * (42 * t + 2.3 * (1 - Math.exp(-18 * t)));
    const boom = Math.sin(boomPhase) * Math.exp(-t * 4.4);
    const wash = lowNoise * Math.exp(-t * 3.2);
    return 0.66 * boom + 0.27 * wash;
  });
}

function reverseLift(startBeat, beats, gain = 0.12) {
  let smooth = 0;
  mix(atBeat(startBeat), beats * BEAT, 0.18, (t, _i, length) => {
    smooth += (random() * 2 - 1 - smooth) * 0.19;
    const progress = Math.min(1, t / (length / SAMPLE_RATE));
    return gain * smooth * progress ** 1.8 * (0.25 + 0.75 * progress);
  });
}

impact();

// 2-step pulse: firm downbeats and syncopated answers, with space for the reel edits.
const kickBeats = [
  0, 2.5, 4, 6.75, 8, 10.5, 12, 14.5, 16, 18.5, 20, 21.5, 22, 23.5, 24.75, 26,
  28.5,
];
kickBeats.forEach((beat, index) =>
  kick(beat, beat >= 22 && beat < 26 ? 0.84 + index * 0.004 : 0.92),
);
[1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29].forEach((beat) =>
  clap(beat),
);

for (let beat = 0.5, index = 0; beat < 29.5; beat += 0.5, index += 1) {
  const swungBeat = index % 2 === 1 ? beat + 0.07 : beat;
  if (beat >= 22 && beat < 26 && index % 2 === 0) continue;
  hat(
    swungBeat,
    index % 4 === 3 ? 0.21 : 0.145,
    index % 8 === 7,
    index % 2 ? 0.22 : -0.22,
  );
}
[23.25, 23.5, 23.75, 24.25, 24.5, 24.75, 25.25, 25.5, 25.75].forEach(
  (beat, i) => {
    hat(beat, 0.12 + i * 0.009, false, i % 2 ? 0.4 : -0.4);
  },
);

// F-minor bass phrases; each section changes its final answer to reinforce the cut.
[
  [0, 1.25, 29],
  [1.75, 0.5, 36],
  [2.5, 0.75, 32],
  [3.5, 0.4, 27],
  [4, 1.25, 29],
  [5.75, 0.5, 36],
  [6.5, 0.75, 39],
  [7.5, 0.4, 32],
  [8, 1.1, 29],
  [9.5, 0.45, 32],
  [10.25, 0.7, 36],
  [11.5, 0.4, 39],
  [12, 1.1, 29],
  [13.5, 0.45, 27],
  [14.25, 0.75, 32],
  [15.5, 0.4, 36],
  [16, 1.25, 29],
  [17.75, 0.45, 36],
  [18.5, 0.75, 39],
  [19.5, 0.4, 32],
  [20, 1.1, 29],
  [21.5, 0.4, 27],
  [22, 0.8, 29],
  [23.25, 0.45, 32],
  [24, 0.65, 36],
  [25, 0.35, 39],
  [26, 1.5, 29],
  [28.5, 0.8, 36],
].forEach(([beat, beats, midi], index) =>
  sub(beat, beats, midi, beat >= 26 ? 0.27 : 0.34, index > 0 ? undefined : 24),
);

// A compact recurring hook (F-Ab-C-Eb) ties the typography and shape sections together.
[
  [0.25, 65, -0.45],
  [0.75, 68, 0.4],
  [1.5, 72, -0.1],
  [2.75, 75, 0.35],
  [3.25, 72, -0.25],
  [4.25, 65, -0.45],
  [4.75, 68, 0.4],
  [5.5, 72, -0.1],
  [6.75, 77, 0.35],
  [7.25, 75, -0.25],
  [10.25, 72, -0.5],
  [10.75, 75, 0.45],
  [11.5, 77, -0.12],
  [12.75, 80, 0.4],
  [16.25, 65, -0.42],
  [16.75, 68, 0.38],
  [17.5, 72, -0.1],
  [18.75, 75, 0.36],
  [20.25, 77, -0.36],
  [20.75, 75, 0.28],
  [21.5, 72, 0],
  [24.25, 72, -0.42],
  [24.75, 75, 0.4],
  [25.25, 77, -0.18],
  [25.75, 80, 0.22],
].forEach(([beat, midi, pan], index) =>
  pluck(beat, midi, index >= 21 ? 0.16 : 0.19, pan),
);

chord(10, 1.45, [53, 60, 63, 68], 0.065);
chord(14, 1.45, [56, 60, 63, 67], 0.063);
chord(18, 1.45, [51, 58, 63, 67], 0.06);
reverseLift(21.25, 0.75, 0.12);
reverseLift(24.5, 1.5, 0.18);

// Final logo: Fm9 opens into a wide, airy decay while percussion clears away.
chord(26, 4.5, [53, 60, 63, 67, 72], 0.105, 0.78);
pluck(26, 77, 0.16, -0.18);
pluck(27, 80, 0.13, 0.22);
pluck(28, 84, 0.1, 0.05);

let peak = 0;
for (let i = 0; i < FRAMES; i += 1) {
  const time = i / SAMPLE_RATE;
  const fade =
    time < 14.45 ? 1 : Math.cos((((time - 14.45) / 0.55) * Math.PI) / 2) ** 2;
  left[i] = Math.tanh(left[i] * 0.86) * fade;
  right[i] = Math.tanh(right[i] * 0.86) * fade;
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}

const targetPeak = 10 ** (-1.25 / 20);
const scale = targetPeak / peak;
let sumSquares = 0;
for (let i = 0; i < FRAMES; i += 1) {
  left[i] *= scale;
  right[i] *= scale;
  sumSquares += left[i] ** 2 + right[i] ** 2;
}

const dataBytes = FRAMES * CHANNELS * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(CHANNELS, 22);
wav.writeUInt32LE(SAMPLE_RATE, 24);
wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
wav.writeUInt16LE(CHANNELS * 2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataBytes, 40);

for (let i = 0; i < FRAMES; i += 1) {
  wav.writeInt16LE(
    Math.round(Math.max(-1, Math.min(1, left[i])) * 32767),
    44 + i * 4,
  );
  wav.writeInt16LE(
    Math.round(Math.max(-1, Math.min(1, right[i])) * 32767),
    46 + i * 4,
  );
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, wav);

const rms = Math.sqrt(sumSquares / (FRAMES * CHANNELS));
console.log(
  JSON.stringify(
    {
      output: outputPath,
      durationSeconds: FRAMES / SAMPLE_RATE,
      frames: FRAMES,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: 16,
      peakDbfs: Number((20 * Math.log10(targetPeak)).toFixed(2)),
      rmsDbfs: Number((20 * Math.log10(rms)).toFixed(2)),
      bytes: wav.length,
    },
    null,
    2,
  ),
);
