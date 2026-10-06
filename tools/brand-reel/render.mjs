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
  {
    font = "Basetica",
    weight = 400,
    align = "center",
    stroke = 0,
    maxWidth = Infinity,
  } = {},
) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
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
// The narrative stays literal: membership purchase, bonus NFT raffle entries,
// and the two partner discounts supplied by the user. Nothing is a live listing.
function artTexture(image) {
  const canvas = createCanvas(700, 800),
    q = canvas.getContext("2d");
  q.fillStyle = C.paper;
  q.beginPath();
  q.roundRect(8, 8, 684, 784, 34);
  q.fill();
  q.save();
  q.beginPath();
  q.roundRect(24, 24, 652, 652, 20);
  q.clip();
  q.imageSmoothingEnabled = false;
  q.drawImage(image, 24, 24, 652, 652);
  q.restore();
  q.fillStyle = C.ink;
  q.font = "36px Basetica";
  q.fillText("NFT ART", 34, 746);
  q.drawImage(logo, 480, 698, 180, 60);
  return canvas;
}
const artImages = await Promise.all(
  ["argonaut-7297.png", "demo-portrait-03.png", "demo-portrait-04.png"].map(
    (name) => loadImage(path.join(ROOT, "web/public/artwork", name)),
  ),
);
const artCards = artImages.map(artTexture);
function heading(text, x, y, size, color, opts = {}) {
  type(text, x, y, size, color, { font: "Basetica", weight: 700, ...opts });
}
function sweep(t, start, duration, color) {
  const p = ease((t - start) / duration);
  if (p > 0) {
    ctx.save();
    ctx.translate(W * (1 - p) * 1.25, 0);
    ctx.rotate(-0.08);
    rounded(-W * 0.06, -H * 0.2, W * 1.35, H * 1.5, 70 * unit, color);
    ctx.restore();
  }
}
function overview(t) {
  bg(C.paper);
  dotGrid(t, "rgba(0,0,0,.13)");
  const x = portrait ? W * 0.5 : W * 0.07;
  const y = portrait ? H * 0.19 : H * 0.34;
  const size = portrait ? W * 0.088 : H * 0.103;
  const gap = portrait ? H * 0.071 : H * 0.125;
  const max = portrait ? W * 0.9 : W * 0.51;
  logoAt(
    portrait ? W / 2 : W * 0.137,
    portrait ? H * 0.075 : H * 0.105,
    portrait ? W * 0.27 : W * 0.135,
  );
  // The opening artwork is already visible at frame zero; a short dolly reveals the story.
  for (const i of [0, 2, 1]) {
    const k = i - 1;
    const p = ease((t - Math.abs(k) * 0.07) / 0.55);
    const aw = portrait ? W * 0.45 : H * 0.48;
    plane(
      artCards[i],
      (portrait ? W * 0.5 : W * 0.78) + k * (portrait ? W * 0.19 : W * 0.065),
      H * (portrait ? 0.66 : 0.55) +
        Math.abs(k) * H * 0.03 +
        (1 - p) * H * 0.08,
      aw * (1 + 0.05 * (1 - p)),
      (aw * 800) / 700,
      k * 0.18 + Math.sin(t * 1.5) * 0.04,
      k * 0.115,
      Math.abs(k) * 65 * unit,
    );
  }
  ["MEMBERSHIPS.", "NFT RAFFLES.", "PARTNER PERKS."].forEach((line, i) => {
    const p = ease((t - i * 0.095) / 0.38);
    ctx.save();
    ctx.globalAlpha = Math.max(0.25, p);
    heading(
      line,
      x + (portrait ? 0 : (1 - p) * -W * 0.025),
      y + i * gap + (1 - p) * 25 * unit,
      size,
      C.ink,
      { align: portrait ? "center" : "left", maxWidth: max },
    );
    ctx.restore();
  });
  if (!portrait) {
    rounded(W * 0.073, H * 0.735, W * 0.35, 8 * unit, 4 * unit, C.lime);
    circle(W * 0.458, H * 0.739, 12 * unit, C.pink);
  }
  sweep(t, 2.55, 0.2625, C.lime);
}
function chooseMembership(t) {
  const lt = t - 6 * BEAT;
  bg(C.lime);
  dotGrid(t, "rgba(0,0,0,.12)");
  const titleSize = portrait ? W * 0.1 : H * 0.102;
  heading(
    "BUY A MEMBERSHIP.",
    W / 2,
    H * (portrait ? 0.17 : 0.16),
    titleSize,
    C.ink,
    { maxWidth: W * 0.9 },
  );
  const cw = portrait ? W * 0.49 : H * 0.36,
    ch = (cw * 880) / 650;
  const enter = ease(lt / 0.35),
    sway = Math.sin(lt * 1.5) * 0.24;
  for (const i of [0, 4, 1, 3, 2]) {
    const offset = i - 2;
    const x = W / 2 + offset * (portrait ? W * 0.12 : W * 0.12) * enter;
    plane(
      cards[i],
      x,
      H * (portrait ? 0.56 : 0.59) +
        Math.abs(offset) * H * 0.035 +
        (1 - enter) * H * 0.48,
      cw,
      ch,
      offset * 0.2 - sway,
      offset * 0.06,
      Math.abs(offset) * 60 * unit,
    );
  }
  type(
    "BONUS NFT RAFFLE ENTRIES INCLUDED",
    W / 2,
    H * (portrait ? 0.84 : 0.93),
    portrait ? W * 0.032 : H * 0.032,
    C.ink,
    { maxWidth: W * 0.89, weight: 600 },
  );
  const last = ease((lt - 2.53) / 0.2825);
  if (last > 0) circle(W * 0.5, H * 0.6, Math.hypot(W, H) * last, C.pink);
}
function arrow(x1, y1, x2, y2, p = 1) {
  ctx.save();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 4 * unit;
  ctx.setLineDash([6 * unit, 12 * unit]);
  ctx.lineDashOffset = -p * 40 * unit;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(
    lerp(x1, x2, 0.4),
    y1 - 50 * unit,
    lerp(x1, x2, 0.6),
    y2 - 50 * unit,
    x2,
    y2,
  );
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2 - 14 * unit, y2 - 14 * unit);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - 20 * unit, y2 + 6 * unit);
  ctx.stroke();
  ctx.restore();
}
function bonusEntries(t) {
  const lt = t - 12 * BEAT;
  bg(C.pink);
  dotGrid(t, "rgba(0,0,0,.11)");
  const sy = portrait ? H * 0.18 : H * 0.13;
  type(
    "BONUS RAFFLE ENTRIES",
    W / 2,
    sy,
    portrait ? W * 0.042 : H * 0.041,
    C.ink,
    { weight: 600, maxWidth: W * 0.87 },
  );
  heading(
    "A CHANCE TO",
    W / 2,
    sy + H * 0.085,
    portrait ? W * 0.102 : H * 0.087,
    C.ink,
    { maxWidth: W * 0.92 },
  );
  heading(
    "WIN AN NFT.",
    W / 2,
    sy + H * 0.176,
    portrait ? W * 0.115 : H * 0.095,
    C.ink,
    { maxWidth: W * 0.92 },
  );
  const p = ease(lt / 0.42),
    stageY = portrait ? H * 0.65 : H * 0.69;
  const pw = portrait ? W * 0.32 : H * 0.29;
  const aw = portrait ? W * 0.51 : H * 0.42;
  plane(
    cards[2],
    W * (portrait ? 0.22 : 0.24) - (1 - p) * W * 0.2,
    stageY,
    pw,
    (pw * 880) / 650,
    -0.23 + 0.04 * Math.sin(t),
    -0.055,
    0,
  );
  plane(
    artCards[0],
    W * (portrait ? 0.7 : 0.76) + (1 - p) * W * 0.25,
    stageY,
    aw,
    (aw * 800) / 700,
    0.18 - 0.06 * Math.sin(lt * 2),
    0.035,
    0,
  );
  const a = W * (portrait ? 0.405 : 0.4),
    b = W * (portrait ? 0.438 : 0.585);
  arrow(a, stageY, b, stageY, lt);
  for (let i = 0; i < 4; i++) {
    const progress = (lt * 0.55 + i * 0.25) % 1;
    const x = lerp(
      W * (portrait ? 0.36 : 0.35),
      W * (portrait ? 0.46 : 0.62),
      progress,
    );
    const y = stageY - H * 0.08 - Math.sin(progress * Math.PI) * H * 0.05;
    pill3d(
      x,
      y,
      portrait ? W * 0.047 : 54 * unit,
      portrait ? W * 0.047 : 54 * unit,
      [C.lime, C.purple, C.paper, C.mint][i],
      lt * 0.5,
    );
  }
  sweep(lt, 3.04, 0.24125, C.purple);
}
function offerPanel(x, y, w, h, kind, rotation = 0) {
  const dark = kind === "seatmap";
  const foreground = dark ? "#f7f5f1" : "#241738";
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.shadowColor = "rgba(20,12,30,.19)";
  ctx.shadowBlur = 25 * unit;
  ctx.shadowOffsetY = 18 * unit;
  rounded(-w / 2, -h / 2, w, h, 40 * unit, dark ? "#1d1b19" : "#f8f4ff");
  ctx.shadowColor = "transparent";
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 40 * unit);
  ctx.clip();
  if (dark) {
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++)
        rounded(
          w * 0.26 + col * w * 0.052,
          -h * 0.12 + row * h * 0.13,
          w * 0.044,
          h * 0.09,
          7 * unit,
          row === 1 && col === 1 ? "#ff5722" : "#49443d",
        );
  } else {
    const g = ctx.createRadialGradient(
      w * 0.37,
      -h * 0.04,
      0,
      w * 0.4,
      0,
      w * 0.16,
    );
    g.addColorStop(0, "#ddbcff");
    g.addColorStop(0.45, "#9b55ff");
    g.addColorStop(1, "#4500ad");
    circle(w * 0.4, 0, w * 0.16, g);
  }
  ctx.restore();
  heading(
    dark ? "SeatMap" : "Fantom Labs",
    -w * 0.41,
    -h * 0.31,
    h * 0.105,
    dark ? "#f7f5f1" : "#6600ff",
    { align: "left", maxWidth: w * 0.71 },
  );
  heading("5% OFF", -w * 0.41, h * 0.005, h * 0.25, foreground, {
    align: "left",
    maxWidth: w * 0.6,
  });
  type(
    dark ? "Pro membership" : "Any service",
    -w * 0.41,
    h * 0.31,
    h * 0.093,
    foreground,
    { align: "left", maxWidth: w * 0.76 },
  );
  ctx.restore();
}
function memberPerks(t) {
  const lt = t - 19 * BEAT;
  bg(C.purple);
  dotGrid(t, "rgba(0,0,0,.13)");
  heading(
    "MEMBER DISCOUNTS.",
    W / 2,
    H * (portrait ? 0.17 : 0.18),
    portrait ? W * 0.083 : H * 0.105,
    C.ink,
    { maxWidth: W * 0.9 },
  );
  if (portrait) {
    const w = W * 0.84,
      h = H * 0.225;
    offerPanel(
      W / 2 + (1 - ease(lt / 0.38)) * W,
      H * 0.405,
      w,
      h,
      "fantom",
      -0.035,
    );
    offerPanel(
      W / 2 - (1 - ease((lt - 0.14) / 0.42)) * W,
      H * 0.675,
      w,
      h,
      "seatmap",
      0.035,
    );
  } else {
    const w = W * 0.4,
      h = H * 0.47;
    offerPanel(
      W * 0.28,
      H * 0.55 + (1 - ease(lt / 0.38)) * H,
      w,
      h,
      "fantom",
      -0.035,
    );
    offerPanel(
      W * 0.72,
      H * 0.55 + (1 - ease((lt - 0.14) / 0.42)) * H,
      w,
      h,
      "seatmap",
      0.035,
    );
  }
  type(
    "Redemption coming soon.",
    W / 2,
    H * (portrait ? 0.87 : 0.91),
    portrait ? W * 0.031 : H * 0.031,
    C.ink,
    { maxWidth: W * 0.85 },
  );
  const iris = ease((lt - 3.06) / 0.22125);
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
    H * (portrait ? 0.39 : 0.4),
    lw * lerp(0.88, 1, settle),
    lerp(-0.04, 0, ease(lt / 0.6)),
  );
  ctx.globalAlpha = ease((lt - 0.18) / 0.4);
  if (portrait) {
    ["MEMBERSHIPS.", "NFT RAFFLES.", "PARTNER PERKS."].forEach((line, i) =>
      heading(line, W / 2, H * (0.535 + i * 0.046), W * 0.052, C.ink, {
        maxWidth: W * 0.88,
      }),
    );
  } else
    heading(
      "MEMBERSHIPS. NFT RAFFLES. PARTNER PERKS.",
      W / 2,
      H * 0.63,
      H * 0.047,
      C.ink,
      { maxWidth: W * 0.85 },
    );
  ctx.globalAlpha = 1;
  for (let i = 0; i < 3; i++) {
    const dp = spring((lt - 0.2 - i * 0.065) / 0.5);
    circle(
      W / 2 + (i - 1) * 35 * unit,
      H * (portrait ? 0.73 : 0.77) + 35 * unit * (1 - dp),
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
  if (t < 6 * BEAT) overview(t);
  else if (t < 12 * BEAT) chooseMembership(t);
  else if (t < 19 * BEAT) bonusEntries(t);
  else if (t < 26 * BEAT) memberPerks(t);
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
