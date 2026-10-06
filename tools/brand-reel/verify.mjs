import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const artifact = "artifacts/brand-reel-20261006/v2";
const candidates = [
  [`${artifact}/labx-brand-reel-1920x1080.mp4`, "1920x1080", 60],
  [`${artifact}/labx-brand-reel-1080x1920.mp4`, "1080x1920", 60],
  ["web/public/brand/labx-intro-wide.mp4", "1600x900", 30],
  ["web/public/brand/labx-intro-tall.mp4", "720x1280", 30],
];

const results = candidates.map(([file, size, fps]) => {
  const decoded = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-i",
      path.join(root, file),
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const log = decoded.stderr || "";
  const duration = log.match(/Duration: ([\d:.]+)/)?.[1];
  const frames = Number([...log.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
  const peakDbfs = Number(log.match(/max_volume: ([\d.-]+) dB/)?.[1]);
  const streams = log
    .split("Output #0")[0]
    .split("\n")
    .filter((line) => line.includes("Stream #"));
  const bytes = readFileSync(path.join(root, file));
  const pass =
    decoded.status === 0 &&
    duration === "00:00:15.00" &&
    frames === fps * 15 &&
    peakDbfs <= -0.5 &&
    streams.some(
      (line) =>
        line.includes(`Video: h264`) &&
        line.includes(size) &&
        line.includes(`${fps} fps`),
    ) &&
    streams.some(
      (line) =>
        line.includes("Audio: aac") && line.includes("48000 Hz, stereo"),
    );
  writeFileSync(
    path.join(root, artifact, `${path.basename(file)}.decode.log`),
    log,
  );
  return {
    file,
    status: pass ? "PASS" : "FAIL",
    exit: decoded.status,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    duration,
    frames,
    peakDbfs,
    streams,
  };
});

writeFileSync(
  path.join(root, artifact, "media-verification.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
