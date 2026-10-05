import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { assertAgreements } from "../lib/agreements";
import { issueChallenge, verifyChallenge } from "../lib/captcha";
import { AMOE_TYPEHASH, COMMIT_VECTOR, hashCommitment } from "../lib/commitment";
import { pickWinner, snapshotLots } from "../lib/draw";
import { receiptBody } from "../lib/email";
import { checkIn, checkInMessage, type Store } from "../lib/points";

class Mem implements Store {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("draw weights", () => {
  const lots = [
    { address: "alice", weight: 1, expiresAt: 10 },
    { address: "bob", weight: 1, expiresAt: 10 },
    { address: "cara", weight: 5, expiresAt: 10 },
    { address: "old", weight: 9, expiresAt: 1 }
  ];
  const snap = snapshotLots(lots, 5);
  it("drops expired lots", () => {
    expect(snap.total).toBe(7);
    expect(snap.cumulative).toEqual([1, 2, 7]);
  });
  it("matches the contract bands", () => {
    expect(pickWinner(snap.cumulative, snap.holders, 0n)).toBe("alice");
    expect(pickWinner(snap.cumulative, snap.holders, 1n)).toBe("bob");
    expect(pickWinner(snap.cumulative, snap.holders, 6n)).toBe("cara");
  });
});

describe("commitment", () => {
  it("matches the Forge vector", () => {
    expect(hashCommitment(COMMIT_VECTOR)).toBe(COMMIT_VECTOR.expected);
  });
  it("uses the VRF-era AMOE type string", () => {
    expect(AMOE_TYPEHASH).toBe("0xbc81dcb16048d14426e084f5bdcf5fbba5cc3ca24e5d5063c9487767d3dd9b25");
  });
});

describe("bot check-in", () => {
  it("refuses a missing bot token and awards once per day", async () => {
    const store = new Mem();
    const account = privateKeyToAccount(generatePrivateKey());
    const day = "2026-10-05";
    const signature = await account.signMessage({ message: checkInMessage(account.address, day) });
    await expect(
      checkIn(store, {
        address: account.address,
        signature,
        botToken: null,
        expectedToken: "bot-secret",
        now: Date.parse(`${day}T03:00:00Z`)
      })
    ).rejects.toThrow(/Bot gate/);
    const first = await checkIn(store, {
      address: account.address,
      signature,
      botToken: "bot-secret",
      expectedToken: "bot-secret",
      now: Date.parse(`${day}T03:00:00Z`)
    });
    expect(first.awarded).toBe(10);
    const second = await checkIn(store, {
      address: account.address,
      signature,
      botToken: "bot-secret",
      expectedToken: "bot-secret",
      now: Date.parse(`${day}T05:00:00Z`)
    });
    expect(second.awarded).toBe(0);
    expect(second.balance).toBe(10);
  });
});

describe("captcha and agreements", () => {
  it("accepts the issued answer only", () => {
    const challenge = issueChallenge("secret", 1_700_000_000_000);
    expect(verifyChallenge("secret", { ...challenge, answer: String(challenge.answer) }, challenge.expiresAt - 1)).toBe(true);
    expect(verifyChallenge("secret", { ...challenge, answer: "0" }, challenge.expiresAt - 1)).toBe(false);
  });
  it("requires every agreement", () => {
    expect(() => assertAgreements({ address: "0x1", terms: true, rules: true, age: false })).toThrow(/agreements/);
  });
});

describe("receipt", () => {
  it("states the lab fee and expiry", () => {
    const body = receiptBody({ to: "a@labx.art", piece: "Junction Array", pack: "Entry", entries: 1, priceUsdc: 25, feeUsdc: 5 });
    expect(body.text).toContain("5 USDC");
    expect(body.text).toContain("12 months");
    expect(body.text.toLowerCase()).not.toMatch(/\btickets?\b/);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(tsx|ts|css|json|svg)$/.test(name)) out.push(full);
  }
  return out;
}

describe("surface copy and materials", () => {
  const root = path.resolve(__dirname, "..");
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components")), ...walk(path.join(root, "lib")), ...walk(path.join(root, "public"))];
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");

  it("does not market packs as chances or publish a floor", () => {
    expect(text.toLowerCase()).not.toMatch(/\btickets?\b/);
    expect(text.toLowerCase()).not.toMatch(/\bfloor\b/);
  });

  it("keeps the fluoro tokens and refuses backdrop blur", () => {
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    for (const token of ["#b9ff87", "#ff79c0", "#8fffb6", "#8049ff", "#b09be8", "#000000", "#3c3b3c"]) {
      expect(css.toLowerCase()).toContain(token);
    }
    expect(css).not.toMatch(/backdrop-filter/);
  });

  it("ships hardware plates and no figure assets", () => {
    const names = readdirSync(path.join(root, "public/lab")).join(" ").toLowerCase();
    expect(names).toContain("hero-linked-panels.jpg");
    expect(names).toContain("chrome-fluoro-run.jpg");
    expect(names).not.toMatch(/head|face|human|workstation/);
  });
});
