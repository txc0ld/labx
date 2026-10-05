import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { assertAgreements } from "../lib/agreements";
import { issueChallenge, verifyChallenge } from "../lib/captcha";
import { AMOE_TYPEHASH, COMMIT_VECTOR, hashCommitment } from "../lib/commitment";
import { pickWinner, snapshotLots } from "../lib/draw";
import { allowReceipt, receiptBody, receiptMessage, resetReceiptRateLimit, verifyReceipt } from "../lib/email";
import { issueAmoeClaim, captchaDigest } from "../lib/amoe";
import { checkIn, checkInMessage, type Store } from "../lib/points";
import { createReserve, revealReserve, saltedPrivateHash, revealMessage } from "../lib/reserve";
import { keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";

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

  it("requires a fresh wallet signature and then rate-limits", async () => {
    resetReceiptRateLimit();
    const account = privateKeyToAccount(generatePrivateKey());
    const now = 1_700_000_000n;
    const message = receiptMessage(account.address, "a@labx.art", "Junction Array", "Entry", now + 60n);
    const signature = await account.signMessage({ message });
    expect(
      await verifyReceipt({
        address: account.address,
        to: "a@labx.art",
        piece: "Junction Array",
        pack: "Entry",
        deadline: 0n,
        signature,
        now
      })
    ).toBe(false);
    expect(
      await verifyReceipt({
        address: account.address,
        to: "a@labx.art",
        piece: "Junction Array",
        pack: "Entry",
        deadline: now + 60n,
        signature,
        now
      })
    ).toBe(true);
    for (let i = 0; i < 5; i += 1) expect(allowReceipt(account.address, 1_000)).toBe(true);
    expect(allowReceipt(account.address, 1_000)).toBe(false);
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

describe("amoe signer", () => {
  it("spends the captcha before it signs", async () => {
    const store = new Mem();
    const signerKey = generatePrivateKey();
    const signer = privateKeyToAccount(signerKey);
    const account = "0x00000000000000000000000000000000000000aa" as Address;
    const terms = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
    const labx = "0x1111111111111111111111111111111111111111" as Address;
    const signed = await issueAmoeClaim(store, {
      address: account,
      pieceId: "junction-array",
      raffleId: "4",
      captchaId: "challenge-1",
      answer: "9",
      expiresAt: 1_700_000_000_000,
      points: 10,
      signerKey,
      chainId: 11155111n,
      verifyingContract: labx,
      termsHash: terms,
      now: 1_700_000_000_000
    });
    expect(signed.mode).toBe("signed");
    if (signed.mode !== "signed") return;
    const recovered = await recoverTypedDataAddress({
      domain: { name: "LABx", version: "1", chainId: 11155111n, verifyingContract: labx },
      types: {
        AmoeClaim: [
          { name: "raffleId", type: "uint256" },
          { name: "account", type: "address" },
          { name: "captchaDigest", type: "bytes32" },
          { name: "deadline", type: "uint256" },
          { name: "termsHash", type: "bytes32" }
        ]
      },
      primaryType: "AmoeClaim",
      message: {
        raffleId: 4n,
        account,
        captchaDigest: captchaDigest("challenge-1", "9", 1_700_000_000_000),
        deadline: BigInt(signed.deadline),
        termsHash: terms
      },
      signature: signed.signature
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
    await expect(
      issueAmoeClaim(store, {
        address: "0x00000000000000000000000000000000000000bb",
        pieceId: "other",
        raffleId: "4",
        captchaId: "challenge-1",
        answer: "9",
        expiresAt: 1_700_000_000_000,
        points: 10,
        signerKey,
        chainId: 11155111n,
        verifyingContract: labx,
        termsHash: terms
      })
    ).rejects.toThrow(/captcha/i);
    await expect(
      issueAmoeClaim(store, {
        address: account,
        pieceId: "junction-array",
        raffleId: "4",
        captchaId: "challenge-2",
        answer: "9",
        expiresAt: 1_700_000_000_000,
        points: 9,
        signerKey,
        chainId: 11155111n,
        verifyingContract: labx,
        termsHash: terms
      })
    ).rejects.toThrow(/Check in/);
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

  it("explore discovers demo pieces through individual artwork capsules", () => {
    const page = readFileSync(path.join(root, "app/page.tsx"), "utf8");
    const hub = readFileSync(path.join(root, "components/BenchHub.tsx"), "utf8");
    const marks = readFileSync(path.join(root, "components/PieceMark.tsx"), "utf8");
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(page).not.toMatch(/next\/image/);
    expect(hub).not.toMatch(/\.jpg|\.png/);
    expect(hub).toMatch(/shown\.map/);
    expect(hub).toMatch(/raffle-capsule bezel/);
    expect(hub).toMatch(/src=\{piece.image\}/);
    expect(hub).toMatch(/Demo artwork/);
    expect(hub).toMatch(/not a live raffle listing/);
    expect(marks.toLowerCase()).not.toMatch(/head|face|human|hand|figure/);
    expect(css).toMatch(/nft-capsule/);
    expect(css).toMatch(/lab-tube-liquid/);
    expect(css).toMatch(/border-radius: 999px/);
    expect(css).toMatch(/\.btn[^{]*\{[^}]*text-decoration:\s*none/);
  });
});
