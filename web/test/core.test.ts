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
import { MemoryStore as Mem } from "../lib/store";
import { checkIn, checkInMessage } from "../lib/points";
import { createReserve, revealReserve, saltedPrivateHash, revealMessage } from "../lib/reserve";
import { keccak256, toBytes } from "viem";


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

describe("reserve salt", () => {
  it("does not publish an unsalted private hash or the salt", async () => {
    const store = new Mem();
    const seller = privateKeyToAccount(generatePrivateKey());
    const text = "private-commitment";
    const published = await createReserve(store, {
      seller: seller.address,
      nft: "0x3333333333333333333333333333333333333333",
      tokenId: "1",
      publicSummary: "The escrowed piece is the prize.",
      privateCommitment: text,
      chainId: 11155111n,
      labx: "0x1111111111111111111111111111111111111111"
    });
    expect(published).not.toHaveProperty("salt");
    expect(published).not.toHaveProperty("privateHash");
    expect(saltedPrivateHash("0x6666666666666666666666666666666666666666666666666666666666666666", text)).not.toBe(
      keccak256(toBytes(text))
    );
    const deadline = 1_700_000_100n;
    const signature = await seller.signMessage({
      message: revealMessage(published.commit, published.labx, deadline)
    });
    const revealed = await revealReserve(store, {
      commit: published.commit,
      seller: seller.address,
      signature,
      deadline,
      now: deadline - 30n
    });
    expect(revealed.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(revealed.privateHash).not.toBe(keccak256(toBytes(text)));
    expect(revealed).not.toHaveProperty("privateCommitment");
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
    // Arithmetic rounding is code, not published pricing copy.
    expect(text.toLowerCase().replaceAll("math.floor", "")).not.toMatch(/\bfloor\b/);
  });

  it("keeps the fluoro tokens and provides a solid reduced-transparency fallback", () => {
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    for (const token of ["#b9ff87", "#b37df6", "#ff79c0", "#8fffb6", "#000000", "#3c3b3c"]) {
      expect(css.toLowerCase()).toContain(token);
    }
    expect(css).toMatch(/backdrop-filter:\s*blur/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency:\s*reduce\)[\s\S]*backdrop-filter:\s*none/);
  });

  it("ships hardware plates and no figure assets", () => {
    const names = readdirSync(path.join(root, "public/lab")).join(" ").toLowerCase();
    expect(names).toContain("hero-linked-panels.jpg");
    expect(names).toContain("chrome-fluoro-run.jpg");
    expect(names).not.toMatch(/head|face|human|workstation/);
  });

  it("keeps reusable artwork capsules while publishing an honest empty collection", () => {
    const page = readFileSync(path.join(root, "app/page.tsx"), "utf8");
    const hub = readFileSync(path.join(root, "components/BenchHub.tsx"), "utf8");
    const marks = readFileSync(path.join(root, "components/PieceMark.tsx"), "utf8");
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(page).not.toMatch(/next\/image/);
    expect(hub).not.toMatch(/\.jpg|\.png/);
    expect(hub).toMatch(/shown\.map/);
    expect(hub).toMatch(/className="raffle-capsule"/);
    expect(hub).toMatch(/src=\{piece.image\}/);
    expect(hub).toMatch(/No raffles listed/);
    expect(hub).toMatch(/Listing tools are not connected yet/);
    expect(hub.toLowerCase()).not.toMatch(/\bdemo(?:nstration)?\b/);
    expect(marks.toLowerCase()).not.toMatch(/head|face|human|hand|figure/);
    expect(css).toMatch(/nft-capsule/);
    expect(css).toMatch(/lab-tube-liquid/);
    expect(css).toMatch(/\.capsule-art[^{]*\{[^}]*aspect-ratio:\s*1/);
    expect(css).toMatch(/\.btn[^{]*\{[^}]*text-decoration:\s*none/);
  });
});
