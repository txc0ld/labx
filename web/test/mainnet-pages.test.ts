import React, { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest compiles the pages' TSX with the classic JSX runtime, which looks React up globally.
Object.assign(globalThis, { React });
// The legal pages' shared navigation reads the current route.
vi.mock("next/navigation", () => ({ usePathname: () => "/about" }));

type Page = { default: ComponentType; metadata?: { description?: string } };
/** A page's visible text and meta description, as the build configured by NEXT_PUBLIC_CHAIN_ID renders it. */
async function page(route: "about" | "privacy" | "legal" | "guide" | "rules") {
  const module = await import(`../app/${route}/page.tsx`) as Page;
  const text = renderToStaticMarkup(createElement(module.default)).replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  return { text, description: module.metadata?.description };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", undefined);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://labx.example");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("legal and guide pages on a Sepolia build", () => {
  it("keeps every Sepolia statement and shows no counsel-pending label", async () => {
    const about = await page("about"), privacy = await page("privacy"), legal = await page("legal"), guide = await page("guide");
    expect(about.description).toBe("LABx is the Sepolia membership bench operated by Fantom Labs Pty Ltd. Escrowed pieces, membership packs, Chainlink VRF.");
    expect(about.text).toContain("LABx is being tested on Ethereum Sepolia, chain ID 11155111. The website only enables approved test deployments. Ethereum mainnet is blocked by the contract constructor.");
    expect(about.text).toContain("These pages are a product draft for counsel, not a legal opinion and not a consumer promotion.");
    expect(privacy.description).toBe("Privacy policy for the LABx Sepolia bench operated by Fantom Labs Pty Ltd.");
    for (const sentence of [
      "This notice describes records created when you use the LABx bench at labx.example. It is a product draft for counsel, not a legal opinion.",
      "LABx is operated by Fantom Labs Pty Ltd (ABN 56 702 056 166, ACN 702 056 166). This Sepolia deployment is a test bench. It is not a mainnet product and it is not a consumer promotion.",
      "This Sepolia bench",
      "Version 3 is intended for Ethereum Sepolia only. The website refuses a mainnet wallet and enables actions only for a reviewed deployment. Do not send real-value assets or treat Sepolia balances as cash.",
      "reasonably necessary for the current Sepolia site: connecting a wallet when you ask, showing existing account records, saving your local email preference, recovering pending transactions without accidental repeat submissions, stopping automated abuse, and keeping the wallet gate on Sepolia.",
      "Anything you send to Ethereum Sepolia is public.",
      "a wallet you install, and public Sepolia infrastructure including Chainlink VRF.",
      "We may update this notice as the Sepolia bench changes.",
      "Last updated 7 October 2026."
    ]) expect(privacy.text).toContain(sentence);
    expect(legal.description).toBe("LABx membership terms for the Ethereum Sepolia bench operated by Fantom Labs Pty Ltd.");
    expect(legal.text).toContain("The v3 contract blocks Ethereum mainnet chain 1. The website permits only approved Sepolia or isolated local deployments. Sepolia is a test network.");
    expect(legal.text).toContain("labx-membership-2026-10-07-v3");
    expect(guide.text).toContain("Sepolia test networkEvery listing and action requires an approved deployment.");
    for (const { text } of [about, privacy, legal, guide]) expect(text).not.toContain("Pending counsel review");
  });
});

describe("legal and guide pages on a mainnet build", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1"); });

  it("states Ethereum mainnet facts and no Sepolia facts", async () => {
    const about = await page("about"), privacy = await page("privacy"), legal = await page("legal"), guide = await page("guide"), rules = await page("rules");
    expect(about.description).toBe("LABx is the Ethereum membership bench operated by Fantom Labs Pty Ltd. Escrowed pieces, membership packs, Chainlink VRF.");
    expect(about.text).toContain("LABx runs on Ethereum mainnet, chain ID 1. The website only enables approved Ethereum mainnet deployments.");
    expect(privacy.description).toBe("Privacy policy for the LABx Ethereum bench operated by Fantom Labs Pty Ltd.");
    for (const sentence of [
      "This deployment runs on Ethereum mainnet.",
      "This Ethereum bench",
      "Version 3 is intended for Ethereum mainnet only. The website refuses a wallet on any other network and enables actions only for a reviewed deployment. Assets on Ethereum have real value, and a confirmed transaction cannot be reversed.",
      "reasonably necessary for the current Ethereum site:",
      "and keeping the wallet gate on Ethereum.",
      "Anything you send to Ethereum is public.",
      "public Ethereum infrastructure including Chainlink VRF.",
      "We may update this notice as the Ethereum bench changes.",
      "Last updated 19 October 2026."
    ]) expect(privacy.text).toContain(sentence);
    expect(legal.description).toBe("LABx membership terms for the Ethereum bench operated by Fantom Labs Pty Ltd.");
    expect(legal.text).toContain("These terms describe the LABx v3 contract on Ethereum mainnet, chain ID 1. The website permits only approved Ethereum mainnet deployments. Ethereum mainnet is not a test network.");
    expect(legal.text).toContain("labx-membership-2026-10-19-mainnet-v1");
    expect(guide.text).toContain("Ethereum mainnetEvery listing and action requires an approved deployment.");
    // The Terms page's counsel note names the Sepolia terms it was derived from; nothing else may mention Sepolia.
    const legalFacts = legal.text.replace(/Pending counsel review: These Ethereum mainnet terms[^”]*”/, "");
    expect(rules.text).toContain("Draw and recovery controls stay disabled unless a reviewed v3 deployment is configured.");
    for (const { text, description } of [about, privacy, { ...legal, text: legalFacts }, guide, rules]) {
      expect(`${text} ${description ?? ""}`).not.toMatch(/Sepolia|11155111|blocked by the contract constructor|refuses a mainnet wallet|not a mainnet product/);
    }
  });

  it("keeps each legal characterization under a counsel-pending label", async () => {
    const about = await page("about"), privacy = await page("privacy"), legal = await page("legal");
    expect(about.text).toContain("Pending counsel review: These pages are a product draft for counsel, not a legal opinion and not a consumer promotion.");
    expect(privacy.text).toContain("Pending counsel review: It is a product draft for counsel, not a legal opinion.");
    expect(privacy.text).toContain("Pending counsel review: This deployment is a test bench. It is not a consumer promotion.");
    expect(legal.text).toContain("Pending counsel review: These Ethereum mainnet terms keep every legal characterization of the Sepolia terms, including “These terms are a product draft for counsel, not a legal opinion.”");
    expect(legal.text).toContain("These terms are a product draft for counsel, not a legal opinion.");
  });
});
