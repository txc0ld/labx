import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const artifact = path.join(root, "artifacts/brand-reel-20261006/v2");
const target = path.join(root, "web/public/brand");
for (const [name, input, size] of [
  ["wide", "1920x1080", "1600:900"],
  ["tall", "1080x1920", "720:1280"],
]) {
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      path.join(artifact, `labx-brand-reel-${input}.mp4`),
      "-vf",
      `scale=${size},fps=30`,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-threads",
      "4",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-t",
      "15",
      "-movflags",
      "+faststart",
      path.join(target, `labx-intro-${name}.mp4`),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const poster = spawnSync(
  ffmpeg,
  [
    "-y",
    "-ss",
    "14.9",
    "-i",
    path.join(artifact, "labx-brand-reel-1920x1080.mp4"),
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:720",
    "-quality",
    "85",
    path.join(target, "labx-intro-poster.webp"),
  ],
  { stdio: "inherit" },
);
process.exit(poster.status ?? 1);
