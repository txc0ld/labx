import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { raffleAddress, readRaffle, sendRaffle } from "../lib/wallet";

const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(tsx|ts|css|md|example)$/.test(name) || name === ".env.example") {
      out.push(full);
    }
  }
  return out;
}

function read(rel: string) {
  return readFileSync(path.join(webRoot, rel), "utf8");
}

function pageExists(rel: string) {
  return existsSync(path.join(webRoot, rel));
}

const STATIC_ROUTES = new Set([
  "/",
  "/fairness",
  "/rules",
  "/legal",
  "/privacy",
  "/about",
  "/terms",
  "/profile",
  "/seller"
]);

function routeFile(route: string) {
  if (route === "/") return "app/page.tsx";
  return `app${route}/page.tsx`;
}

describe("required marketing routes", () => {
  it("ships explore, fairness, rules, legal, privacy, about, terms, profile, and studio", () => {
    for (const route of STATIC_ROUTES) {
      expect(pageExists(routeFile(route)), `${route} is missing ${routeFile(route)}`).toBe(true);
    }
    expect(pageExists("app/piece/[id]/page.tsx")).toBe(true);
    expect(pageExists("app/not-found.tsx")).toBe(true);
  });

  it("keeps /terms as a Legal alias that resolves to /legal", () => {
    expect(read("app/terms/page.tsx")).toMatch(/redirect\(\s*["']\/legal["']\s*\)/);
  });

  it("names the operator on About, Privacy, and Terms", () => {
    const operator = read("lib/operator.ts");
    expect(operator).toContain("Fantom Labs Pty Ltd");
    expect(operator).toContain("56 702 056 166");
    expect(operator).toContain("702 056 166");
    for (const file of ["app/about/page.tsx", "app/privacy/page.tsx", "app/legal/page.tsx"]) {
      const text = `${read(file)}\n${operator}`;
      expect(text).toMatch(/OPERATOR_LINE|Fantom Labs Pty Ltd/);
      expect(text).toContain("56 702 056 166");
      expect(text).toContain("702 056 166");
      expect(text.toLowerCase()).toMatch(/sepolia/);
      expect(text.toLowerCase()).not.toMatch(/\btickets?\b/);
    }
  });

  it("gives Privacy a full policy, not a stub", () => {
    const text = read("app/privacy/page.tsx");
    expect(text.length).toBeGreaterThan(2500);
    for (const heading of [
      "Who we are",
      "What we collect",
      "Why we collect it",
      "How we store it",
      "Your rights",
      "Children"
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/Privacy Act 1988/);
    expect(text).not.toMatch(/TODO|FIXME|lorem ipsum|coming soon|TBD/i);
    expect(text).not.toMatch(/NEXT_PUBLIC_RAFFLE_ADDRESS\s*=\s*0x/i);
  });

  it("describes the lab and the Sepolia bench on About", () => {
    const text = read("app/about/page.tsx");
    expect(text).toMatch(/matte ceramic|enamel|fluoro chrome|NFT CONTAINER|capsule/i);
    expect(text).toMatch(/membership pack/i);
    expect(text).toMatch(/Mainnet/);
    expect(text).not.toMatch(/TODO|FIXME|lorem ipsum|coming soon|TBD/i);
  });

  it("keeps the 404 page on-brand and linked back to the bench", () => {
    const text = read("app/not-found.tsx");
    expect(text).toMatch(/href=["']\/["']/);
    expect(text).toMatch(/pearl|well|page-title/);
    expect(text).not.toMatch(/This page could not be found/);
    expect(text.toLowerCase()).not.toMatch(/\btickets?\b/);
  });
});

describe("chrome links", () => {
  it("covers About, Privacy, Terms, Fairness, and Draw rules in the footer", () => {
    const shell = read("components/Shell.tsx");
    for (const href of ["/about", "/privacy", "/legal", "/fairness", "/rules"]) {
      expect(shell).toContain(`href: "${href}"`);
    }
    expect(shell).toMatch(/Terms/);
    expect(shell).toMatch(/Privacy/);
    expect(shell).toMatch(/About/);
    expect(shell).toMatch(/Skip to content/);
    expect(shell).toMatch(/id="content"/);
  });

  it("resolves every in-app href to a real route, hash, or documented external", () => {
    const roots = ["app", "components", "lib"].map((dir) => path.join(webRoot, dir));
    const files = roots.flatMap((dir) => walk(dir));
    const hrefs = new Set<string>();
    const hrefRe = /href(?:=|:)\s*(?:\{`([^`]+)`\}|\{["']([^"']+)["']\}|["']([^"']+)["'])/g;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = hrefRe.exec(text))) {
        hrefs.add(match[1] || match[2] || match[3]);
      }
    }

    expect(hrefs.size).toBeGreaterThan(8);

    for (const href of hrefs) {
      if (href.startsWith("mailto:") || href.startsWith("https://") || href.startsWith("http://")) {
        expect(href === "https://labx.art" || href.startsWith("https://labx.art/")).toBe(true);
        continue;
      }
      if (href.startsWith("#")) {
        expect(["#content", "#bench"].includes(href)).toBe(true);
        continue;
      }
      const [pathname] = href.split("#");
      if (pathname === "/piece/${piece.id}" || pathname.startsWith("/piece/")) {
        expect(pageExists("app/piece/[id]/page.tsx")).toBe(true);
        continue;
      }
      if (pathname.startsWith("/fairness")) {
        expect(pageExists("app/fairness/page.tsx")).toBe(true);
        continue;
      }
      expect(STATIC_ROUTES.has(pathname), `unresolved href ${href}`).toBe(true);
      expect(pageExists(routeFile(pathname)), `missing page for ${href}`).toBe(true);
    }
  });
});

describe("on-chain soft disable", () => {
  const previous = process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;

  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
    else process.env.NEXT_PUBLIC_RAFFLE_ADDRESS = previous;
  });

  it("returns null for an unset or invalid raffle address and does not invent one", () => {
    delete process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
    expect(raffleAddress()).toBeNull();
    process.env.NEXT_PUBLIC_RAFFLE_ADDRESS = "";
    expect(raffleAddress()).toBeNull();
    process.env.NEXT_PUBLIC_RAFFLE_ADDRESS = "0xnotanaddress";
    expect(raffleAddress()).toBeNull();

    const envExample = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(envExample).toMatch(/NEXT_PUBLIC_RAFFLE_ADDRESS=\s*$/m);
    expect(envExample).toMatch(/soft-disable|not wired|Leave empty|unset/i);
    expect(envExample).not.toMatch(/NEXT_PUBLIC_RAFFLE_ADDRESS=0x[0-9a-fA-F]{40}/);
  });

  it("refuses on-chain reads and writes when the raffle address is missing", async () => {
    delete process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
    await expect(readRaffle(1n)).rejects.toThrow(/not wired|not set|not configured/i);
    await expect(sendRaffle("getRaffle", [1n], "0x00000000000000000000000000000000000b0b01")).rejects.toThrow(
      /not wired|not set|not configured/i
    );
  });

  it("keeps studio, profile, rules, and piece desks honest when the contract is unset", () => {
    const surfaces = [
      read("app/seller/page.tsx"),
      read("app/profile/page.tsx"),
      read("app/rules/page.tsx"),
      read("components/PieceDesk.tsx"),
      read("lib/bench.tsx")
    ].join("\n");
    expect(surfaces).toMatch(/raffleAddress|onChainReady|OnChainStatus/);
    expect(surfaces).toMatch(/not wired|bench only|this bench/i);
    expect(read("lib/bench.tsx")).toMatch(/raffleAddress\(\)/);
  });
});
