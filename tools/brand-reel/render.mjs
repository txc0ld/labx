import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const args = process.argv.slice(2);
const arg = (key, def) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : def;
const W = Number(arg("--width", 1920)),
  H = Number(arg("--height", 1080)),
  FPS = Number(arg("--fps", 60));
const OUT = path.resolve(
  arg(
    "--out",
    path.join(ROOT, "artifacts/brand-reel-20261006/labx-reel-landscape.mp4"),
  ),
);
const C = {
  paper: "#f8f9fa",
  ink: "#111113",
  lime: "#b9ff87",
  purple: "#b37df6",
  pink: "#ff79c0",
  mint: "#87ffb1",
};
const BEAT = 60 / 128;
const portrait = H > W;
const c = createCanvas(W, H),
  ctx = c.getContext("2d");
ctx.imageSmoothingQuality = "high";
GlobalFonts.registerFromPath(
  path.join(ROOT, "web/app/fonts/basetica-regular.woff2"),
  "Basetica",
);
GlobalFonts.registerFromPath(
  path.join(ROOT, "tools/brand-reel/assets/sixtyfour.woff2"),
  "Sixtyfour",
);
const logo = await loadImage(path.join(ROOT, "web/public/brand/labx-logo.png"));
const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => 1 - Math.pow(1 - clamp(t), 4);
const smooth = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const spring = (t) => 1 - Math.exp(-7 * clamp(t)) * Math.cos(11 * clamp(t));
const out = (t, end, d = 0.22) => 1 - ease((t - (end - d)) / d);
const unit = Math.min(W, H) / 1080;
function rounded(x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}
function circle(x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
function bg(color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
}
function dotGrid(t, color = "rgba(0,0,0,.15)", opacity = 1, scale = 1) {
  ctx.save();
  ctx.globalAlpha = opacity;
  const space = 30 * unit * scale;
  const ox = (t * 8 * unit) % space;
  for (let x = ox - space; x < W + space; x += space)
    for (let y = -space; y < H + space; y += space)
      circle(x, y, 1.2 * unit, color);
  ctx.restore();
}
function type(
  text,
  x,
  y,
  size,
  color,
  { font = "Basetica", align = "center", stroke = 0, maxWidth = Infinity } = {},
) {
  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width;
  const scale = Math.min(1, maxWidth / width);
  ctx.translate(x, y);
  ctx.scale(scale, 1);
  if (stroke) {
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke;
    ctx.strokeText(text, 0, 0);
  } else {
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
  }
  ctx.restore();
}
function logoAt(x, y, width, rotation = 0, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.drawImage(logo, -width / 2, -width / 6, width, width / 3);
  ctx.restore();
}
function cross(x, y, size, color, angle = 0, thickness = 0.27) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  rounded(
    -size / 2,
    (-size * thickness) / 2,
    size,
    size * thickness,
    size * 0.11,
    color,
  );
  rounded(
    (-size * thickness) / 2,
    -size / 2,
    size * thickness,
    size,
    size * 0.11,
    color,
  );
  ctx.restore();
}
function pill3d(x, y, w, h, color, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.shadowColor = "rgba(0,0,0,.22)";
  ctx.shadowBlur = 28 * unit;
  ctx.shadowOffsetY = 14 * unit;
  rounded(-w / 2, -h / 2, w, h, h / 2, color);
  ctx.shadowColor = "transparent";
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, "rgba(255,255,255,.67)");
  g.addColorStop(0.18, "rgba(255,255,255,0)");
  g.addColorStop(0.65, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.23)");
  rounded(
    -w / 2 + 3 * unit,
    -h / 2 + 3 * unit,
    w - 6 * unit,
    h - 6 * unit,
    h / 2,
    g,
  );
  ctx.restore();
}
function extruded(text, x, y, size, color, depth = 16, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  for (let d = depth; d > 0; d -= 2)
    type(text, d * unit, d * unit, size, "#161518", {
      font: "Sixtyfour",
      maxWidth: W * 0.87,
    });
  type(text, 0, 0, size, color, { font: "Sixtyfour", maxWidth: W * 0.87 });
  ctx.restore();
}
const grain = createCanvas(240, 240);
const gc = grain.getContext("2d");
const gd = gc.createImageData(240, 240);
let seed = 27;
for (let i = 0; i < gd.data.length; i += 4) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const v = seed % 255;
  gd.data[i] = gd.data[i + 1] = gd.data[i + 2] = v;
  gd.data[i + 3] = 8;
}
gc.putImageData(gd, 0, 0);
const grainPattern = ctx.createPattern(grain, "repeat");
function texture(frame) {
  ctx.save();
  ctx.translate(((frame * 37) % 240) - 240, ((frame * 59) % 240) - 240);
  ctx.fillStyle = grainPattern;
  ctx.fillRect(0, 0, W + 480, H + 480);
  ctx.restore();
}
function brandCorner(alpha = 1) {
  logoAt(W * 0.085, H * 0.08, W * 0.105, 0, alpha);
}

// Each shot uses the same 128 BPM grid as the original audio sting.
function hook(t) {
  bg(C.purple);
  dotGrid(t, "rgba(17,17,19,.2)");
  const u = clamp(t / 0.48),
    z = lerp(3.8, 1, ease(u));
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(z, z);
  ctx.rotate(lerp(-0.28, 0.035, ease(u)));
  const radius = Math.min(W, H) * 0.38;
  ctx.lineWidth = radius * 0.24;
  ctx.strokeStyle = C.lime;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
  cross(radius * 0.8, -radius * 0.7, radius * 0.4, C.pink, t * 1.8);
  ctx.restore();
  if (t < 0.94) {
    const textIn = spring(t / 0.35);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(textIn, textIn);
    extruded("READY?", 0, 0, Math.min(W * 0.19, H * 0.27), C.paper, 14, -0.05);
    ctx.restore();
  } else {
    const s = spring((t - 0.94) / 0.45);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(s, s);
    logoAt(0, 0, W * (portrait ? 0.95 : 0.7), -0.035 + Math.sin(t * 4) * 0.015);
    ctx.restore();
  }
  const mask = ease((t - 1.63) / 0.245);
  if (mask > 0) {
    ctx.fillStyle = C.ink;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(W, H);
    ctx.lineTo(W, H - H * mask * 1.5);
    ctx.lineTo(0, H - H * mask * 1.5 + H * 0.35);
    ctx.closePath();
    ctx.fill();
  }
}
function kinetic(t) {
  const lt = t - 4 * BEAT;
  bg(C.ink);
  const shift = lt / (6 * BEAT);
  const word = "MEMBERSHIP";
  const size = portrait ? W * 0.19 : H * 0.205;
  for (let row = -2; row < 4; row++) {
    const yy = H * 0.34 + row * size * 1.25 - lt * 50 * unit;
    type(
      word,
      W / 2 + Math.sin(lt * 1.4 + row) * W * 0.08,
      yy,
      size,
      row === 0 ? C.purple : "#343437",
      {
        font: "Sixtyfour",
        stroke: row === 0 ? 0 : 1.5 * unit,
        maxWidth: W * 1.12,
      },
    );
  }
  const enter = ease((lt - 0.75) / 0.3);
  ctx.save();
  ctx.translate(lerp(W * 1.2, W * 0.5, enter), H * 0.6);
  ctx.rotate(lerp(0.18, -0.045, enter));
  const pw = W * (portrait ? 0.91 : 0.66),
    ph = H * (portrait ? 0.26 : 0.32);
  rounded(-pw / 2, -ph / 2, pw, ph, 35 * unit, C.lime);
  type("WITH", 0, -ph * 0.2, ph * 0.36, C.ink, {
    font: "Sixtyfour",
    maxWidth: pw * 0.88,
  });
  type("MORE.", 0, ph * 0.22, ph * 0.42, C.ink, {
    font: "Sixtyfour",
    maxWidth: pw * 0.88,
  });
  ctx.restore();
  if (lt > 1.85) {
    let p = ease((lt - 1.85) / 0.55);
    cross(W * 0.83, H * 0.25, Math.min(W, H) * 0.25 * p, C.pink, p * 1.6);
  }
  brandCorner();
  const wipe = ease((lt - 2.57) / 0.2425);
  if (wipe > 0) circle(W / 2, H / 2, Math.hypot(W, H) * wipe, C.lime);
}
function shapes(t) {
  const lt = t - 10 * BEAT;
  const seg = Math.min(2, Math.floor(lt / (2 * BEAT)));
  const st = lt - seg * 2 * BEAT;
  const colors = [C.lime, C.purple, C.pink];
  bg(colors[seg]);
  const R = Math.min(W, H) * 0.27;
  const spin = lt * 1.7;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + spin;
    const burst = 1 + 0.11 * Math.sin((st / BEAT) * Math.PI * 2);
    const x = W / 2 + Math.cos(a) * R * burst * (portrait ? 1 : 1.6),
      y = H / 2 + Math.sin(a) * R * burst;
    if (i % 2) pill3d(x, y, R * 0.85, R * 0.32, colors[(seg + 1) % 3], a + lt);
    else cross(x, y, R * 0.6, C.ink, a + 0.3, 0.24);
  }
  const text = ["ART.", "PERKS.", "EXTRA."][seg];
  let s = lerp(0.65, 1, spring(st / 0.32));
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(s, s);
  extruded(
    text,
    0,
    0,
    Math.min(W * 0.2, H * 0.28),
    C.paper,
    12,
    Math.sin(st * 3) * 0.015,
  );
  ctx.restore();
  brandCorner();
  // One circular match cut joins the orbit to the membership-card carousel.
  if (lt > 2.61)
    circle(
      W * 0.5,
      H * 0.5,
      Math.hypot(W, H) * ease((lt - 2.61) / 0.2025),
      C.paper,
    );
}

function cardTexture(title, color, index) {
  const p = createCanvas(650, 880),
    q = p.getContext("2d");
  q.beginPath();
  q.roundRect(12, 12, 626, 856, 76);
  let g = q.createLinearGradient(0, 0, 600, 900);
  g.addColorStop(0, color);
  g.addColorStop(0.5, color);
  g.addColorStop(
    1,
    index === 4 ? "#9aa83f" : index === 0 ? "#8255b9" : "#55565b",
  );
  q.fillStyle = g;
  q.fill();
  q.lineWidth = 5;
  q.strokeStyle = "rgba(255,255,255,.75)";
  q.stroke();
  q.save();
  q.beginPath();
  q.roundRect(25, 25, 600, 830, 67);
  q.clip();
  let shine = q.createLinearGradient(0, 0, 500, 600);
  shine.addColorStop(0, "rgba(255,255,255,.6)");
  shine.addColorStop(0.25, "rgba(255,255,255,0)");
  q.fillStyle = shine;
  q.fillRect(0, 0, 650, 880);
  q.restore();
  q.drawImage(logo, 55, 46, 280, 94);
  q.fillStyle = "#19191b";
  q.font = "34px Basetica";
  q.fillText("MEMBERSHIP", 55, 211);
  q.font = "59px Basetica";
  q.fillText(title, 52, 292);
  q.fillStyle = "#1b1b1d";
  for (let j = 0; j < 3; j++) {
    q.beginPath();
    q.arc(146 + j * 179, 462, 57, 0, Math.PI * 2);
    q.fill();
    q.strokeStyle = "rgba(255,255,255,.42)";
    q.lineWidth = 3;
    q.stroke();
  }
  q.font = "28px Basetica";
  q.fillText("A LITTLE EXTRA.", 55, 752);
  q.fillStyle = "rgba(0,0,0,.1)";
  q.fillRect(55, 680, 540, 2);
  q.font = "26px Sixtyfour";
  q.fillText("LABx", 452, 804);
  return p;
}
const cards = [
  ["ENTRY", C.purple],
  ["BRONZE", "#cf9164"],
  ["SILVER", "#dedfe5"],
  ["GOLD", "#ffd673"],
  ["PLATINUM", "#ccff00"],
].map(([n, col], i) => cardTexture(n, col, i));
function tri(img, s, d) {
  ctx.save();
  const mx = (d[0].x + d[1].x + d[2].x) / 3,
    my = (d[0].y + d[1].y + d[2].y) / 3;
  const edge = d.map((p) => {
    const len = Math.hypot(p.x - mx, p.y - my);
    return {
      x: p.x + ((p.x - mx) / len) * 0.85,
      y: p.y + ((p.y - my) / len) * 0.85,
    };
  });
  ctx.beginPath();
  ctx.moveTo(edge[0].x, edge[0].y);
  ctx.lineTo(edge[1].x, edge[1].y);
  ctx.lineTo(edge[2].x, edge[2].y);
  ctx.closePath();
  ctx.clip();
  const [p0, p1, p2] = s,
    [v0, v1, v2] = d;
  const det =
    p0.x * (p1.y - p2.y) + p1.x * (p2.y - p0.y) + p2.x * (p0.y - p1.y);
  const a =
    (v0.x * (p1.y - p2.y) + v1.x * (p2.y - p0.y) + v2.x * (p0.y - p1.y)) / det;
  const b =
    (v0.y * (p1.y - p2.y) + v1.y * (p2.y - p0.y) + v2.y * (p0.y - p1.y)) / det;
  const cc =
    (v0.x * (p2.x - p1.x) + v1.x * (p0.x - p2.x) + v2.x * (p1.x - p0.x)) / det;
  const dd =
    (v0.y * (p2.x - p1.x) + v1.y * (p0.x - p2.x) + v2.y * (p1.x - p0.x)) / det;
  ctx.setTransform(
    a,
    b,
    cc,
    dd,
    v0.x - a * p0.x - cc * p0.y,
    v0.y - b * p0.x - dd * p0.y,
  );
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
function plane(img, cx, cy, w, h, ry, rz, depth) {
  const project = (sx, sy) => {
    let x = (sx / img.width - 0.5) * w,
      y = (sy / img.height - 0.5) * h;
    let z = -x * Math.sin(ry) + depth;
    x *= Math.cos(ry);
    const xx = x * Math.cos(rz) - y * Math.sin(rz),
      yy = x * Math.sin(rz) + y * Math.cos(rz);
    const f = (1400 * unit) / (1400 * unit + z);
    return { x: cx + xx * f, y: cy + yy * f };
  };
  const nx = 6,
    ny = 8;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const a = { x: (i / nx) * img.width, y: (j / ny) * img.height },
        b = { x: ((i + 1) / nx) * img.width, y: (j / ny) * img.height },
        d = { x: (i / nx) * img.width, y: ((j + 1) / ny) * img.height },
        e = { x: b.x, y: d.y };
      tri(
        img,
        [a, b, d],
        [project(a.x, a.y), project(b.x, b.y), project(d.x, d.y)],
      );
      tri(
        img,
        [b, e, d],
        [project(b.x, b.y), project(e.x, e.y), project(d.x, d.y)],
      );
    }
}
function carousel(t) {
  const lt = t - 16 * BEAT;
  bg(C.paper);
  dotGrid(t, "rgba(0,0,0,.13)");
  const entrance = ease(lt / 0.4);
  const fan = smooth(lt / (4 * BEAT));
  const pan = Math.sin(lt * 1.65) * 0.38;
  const cw = portrait ? W * 0.58 : H * 0.43,
    ch = (cw * 880) / 650;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.14)";
  ctx.shadowBlur = 35 * unit;
  ctx.fillStyle = "rgba(0,0,0,.07)";
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.8, W * 0.3, H * 0.028, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  for (const i of [0, 4, 1, 3, 2]) {
    const offset = i - 2;
    const cx = W / 2 + offset * (portrait ? W * 0.115 : W * 0.115) * entrance;
    const cy =
      H * (portrait ? 0.53 : 0.52) +
      Math.abs(offset) * H * 0.045 +
      (1 - entrance) * H;
    plane(
      cards[i],
      cx,
      cy,
      cw * (1 + fan * 0.09),
      ch * (1 + fan * 0.09),
      offset * 0.25 - pan,
      offset * 0.075 * (1 - fan * 0.2),
      Math.abs(offset) * 85 * unit,
    );
  }
  const line = portrait ? "FIND YOUR" : "A LITTLE EXTRA.";
  type(line, W / 2, H * 0.12, Math.min(W * 0.072, H * 0.072), C.ink, {
    font: "Sixtyfour",
    maxWidth: W * 0.88,
  });
  if (portrait)
    type("NEXT THING.", W / 2, H * 0.19, W * 0.075, C.ink, {
      font: "Sixtyfour",
      maxWidth: W * 0.88,
    });
  // Tilt the camera through the central card, then a clean color wipe.
  if (lt > 2.39) {
    const p = ease((lt - 2.39) / 0.4225);
    rounded(
      -W * 0.2 + W * 0.2 * p,
      H * (1 - p) * 1.1,
      W * 1.4,
      H * 1.3,
      100 * unit,
      C.purple,
    );
  }
}
function build(t) {
  const lt = t - 22 * BEAT;
  bg(C.purple);
  const texts = portrait ? ["GO", "LABx"] : ["GO", "LABx"];
  const s = lt < BEAT ? 0 : 1;
  const st = lt - s * BEAT;
  if (s === 0) {
    for (let i = 0; i < 5; i++)
      type(
        "GO",
        W / 2 + (i - 2) * W * 0.34 - lt * W * 0.4,
        H / 2,
        Math.min(W * 0.5, H * 0.68),
        i === 2 ? C.lime : C.ink,
        { font: "Sixtyfour", stroke: i === 2 ? 0 : 3 * unit },
      );
  } else {
    const rot = lerp(-0.15, 0.03, ease(st / 0.65));
    logoAt(
      W / 2,
      H / 2,
      W * (portrait ? 1.13 : 0.82) * (1 + 0.04 * Math.sin(st * 8)),
      rot,
    );
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5 + st;
      const r = lerp(
        Math.min(W, H) * 0.13,
        Math.max(W, H) * 0.62,
        ease(st / 0.7),
      );
      circle(
        W / 2 + Math.cos(a) * r,
        H / 2 + Math.sin(a) * r,
        15 * unit,
        [C.lime, C.pink, C.paper][i % 3],
      );
    }
  }
  const iris = ease((lt - 1.59) / 0.285);
  if (iris > 0) circle(W / 2, H / 2, Math.hypot(W, H) * iris, C.paper);
}
function finale(t) {
  const lt = t - 26 * BEAT;
  bg(C.paper);
  dotGrid(t, "rgba(0,0,0,.10)", 1 - smooth(lt / 0.8) * 0.3);
  const settle = spring(lt / 0.55);
  const lw = W * (portrait ? 0.89 : 0.62);
  logoAt(
    W / 2,
    H * (portrait ? 0.44 : 0.43),
    lw * lerp(0.88, 1, settle),
    lerp(-0.04, 0, ease(lt / 0.6)),
  );
  const p = ease((lt - 0.24) / 0.6);
  ctx.globalAlpha = p;
  type(
    "MEMBERSHIP. WITH MORE.",
    W / 2,
    H * (portrait ? 0.57 : 0.65),
    Math.min(W * 0.044, H * 0.047),
    C.ink,
    { font: "Basetica", maxWidth: W * 0.83 },
  );
  ctx.globalAlpha = 1;
  const dotY = H * (portrait ? 0.65 : 0.77);
  for (let i = 0; i < 3; i++) {
    const dp = spring((lt - 0.2 - i * 0.065) / 0.5);
    circle(
      W / 2 + (i - 1) * 35 * unit,
      dotY + 35 * unit * (1 - dp),
      8 * unit,
      [C.lime, C.purple, C.pink][i],
    );
  }
}
function frame(n) {
  const t = n / FPS;
  ctx.resetTransform();
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.clearRect(0, 0, W, H);
  if (t < 4 * BEAT) hook(t);
  else if (t < 10 * BEAT) kinetic(t);
  else if (t < 16 * BEAT) shapes(t);
  else if (t < 22 * BEAT) carousel(t);
  else if (t < 26 * BEAT) build(t);
  else finale(t);
  texture(n);
}

await mkdir(path.dirname(OUT), { recursive: true });
if (args.includes("--stills")) {
  for (const sec of [
    0, 0.25, 0.7, 1.3, 2.4, 3.8, 5.15, 6.15, 7.05, 8.25, 9.5, 10.55, 11.4, 12.7,
    14.9,
  ]) {
    frame(Math.round(sec * FPS));
    await writeFile(
      path.join(path.dirname(OUT), `still-${W}x${H}-${sec}.png`),
      c.toBuffer("image/png"),
    );
  }
  console.log("Stills ready");
} else {
  const audio = arg("--audio", null);
  const cmd = [
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${W}x${H}`,
    "-framerate",
    String(FPS),
    "-i",
    "pipe:0",
  ];
  if (audio) cmd.push("-i", audio);
  cmd.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-threads",
    "4",
    "-crf",
    arg("--crf", "18"),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  );
  if (audio) cmd.push("-c:a", "aac", "-b:a", "256k");
  else cmd.push("-an");
  cmd.push("-t", "15", OUT);
  const proc = spawn(ffmpeg, cmd, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  proc.stdin.on("error", () => {});
  for (let n = 0; n < 15 * FPS; n++) {
    frame(n);
    const buf = Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);
    if (!proc.stdin.write(buf)) await once(proc.stdin, "drain");
    if (n % (FPS * 3) === 0) console.log(`${n / FPS}/15s`);
  }
  proc.stdin.end();
  const [code] = await once(proc, "close");
  await writeFile(OUT + ".render.log", err);
  if (code !== 0) throw new Error(err.slice(-2000));
  console.log(OUT);
}
