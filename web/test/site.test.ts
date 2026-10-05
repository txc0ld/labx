import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnChainStatus } from "../components/OnChainStatus";
import { raffleAddress, readRaffle, sendRaffle } from "../lib/wallet";
import { roundedOrtho } from "../lib/tubes";

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
  "/profile",
  "/seller"
]);
const ALIAS_ROUTES = new Set(["/terms"]);

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
    expect(read("next.config.ts")).toMatch(/source:\s*["']\/terms["']/);
    expect(read("next.config.ts")).toMatch(/destination:\s*["']\/legal["']/);
    expect(read("next.config.ts")).toMatch(/permanent:\s*true/);
  });

  it("names the operator on About, Privacy, and Terms", () => {
    const operator = read("lib/operator.ts");
    expect(operator).toContain("Fantom Labs Pty Ltd");
    expect(operator).toContain("56 702 056 166");
    expect(operator).toContain("702 056 166");
    expect(operator).toMatch(/publicSiteUrl|NEXT_PUBLIC_SITE_URL/);
    expect(operator).toContain("labx-two.vercel.app");
    for (const file of ["app/about/page.tsx", "app/privacy/page.tsx", "app/legal/page.tsx"]) {
      const text = read(file);
      expect(text).toMatch(/import \{[^}]*OPERATOR_LINE[^}]*\} from "@\/lib\/operator"/);
      expect(text).toContain("{OPERATOR_LINE}");
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
    expect(text).toMatch(/Australian Privacy Principle 3|APP 3/);
    expect(text).toMatch(/Australian Privacy Principle 6|APP 6/);
    expect(text).toMatch(/privacy contact via the site operator/i);
    expect(text).toContain("https://www.oaic.gov.au/");
    expect(text).not.toMatch(/legitimate need|lawful bas/i);
    expect(text).not.toMatch(/lorem ipsum|coming soon/i);
    expect(text).not.toMatch(/NEXT_PUBLIC_RAFFLE_ADDRESS\s*=\s*0x/i);
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("states settle flips phase and claims pull prize, proceeds, and fee", () => {
    for (const file of ["app/legal/page.tsx", "app/rules/page.tsx"]) {
      const text = read(file);
      expect(text).toMatch(/claimPrize/);
      expect(text).toMatch(/claimProceeds/);
      expect(text).toMatch(/claimFee/);
      expect(text).toMatch(/settled phase|flips the (piece|phase)|phase to settled/i);
    }
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
        expect(
          href.startsWith("https://www.oaic.gov.au") ||
            href.startsWith("https://labx-two.vercel.app") ||
            href === "https://labx.art" ||
            href.startsWith("https://labx.art/")
        ).toBe(true);
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
      if (ALIAS_ROUTES.has(pathname)) {
        expect(read("next.config.ts")).toMatch(/source:\s*["']\/terms["']/);
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
    expect(read("lib/bench.tsx")).toMatch(/onChainReady\(\)|raffleAddress\(\)/);
    expect(read("lib/bench.tsx")).toMatch(/saltedPrivateHash|generatePrivateKey/);
  });

  it.each([undefined, "0x0000000000000000000000000000000000000001"])(
    "keeps browser-demo disclosures visible with raffle address %s",
    (address) => {
      if (address === undefined) delete process.env.NEXT_PUBLIC_RAFFLE_ADDRESS;
      else process.env.NEXT_PUBLIC_RAFFLE_ADDRESS = address;
      for (const surface of ["studio", "profile", "rules", "piece"] as const) {
        const markup = renderToStaticMarkup(createElement(OnChainStatus, { surface }));
        expect(markup).toContain('role="status"');
        expect(markup).toContain("bench only");
        expect(markup).toMatch(/browser demo|browser\. It does not transfer/);
        if (address) expect(markup).toContain("these controls still do not submit transactions");
      }
    }
  );
});

describe("hub laboratory tubing", () => {
  it("fillets orthogonal elbows instead of drawing flat H/V", () => {
    const d = roundedOrtho(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 80, y: 60 }
      ],
      16
    );
    expect(d).toMatch(/Q /);
    expect(d).not.toMatch(/ H | V /);
  });

  it("renders the desktop lab-tube stack and hides it over stacked mobile content", () => {
    const tubes = read("components/BenchTubes.tsx");
    const css = read("app/globals.css");
    expect(tubes).toMatch(/function TubeFitting/);
    expect(tubes).toMatch(/fitting-groove/);
    expect(tubes).toMatch(/lab-tube-glow/);
    expect(tubes).toMatch(/lab-tube-rim/);
    expect(tubes).toMatch(/lab-tube-glass/);
    expect(tubes).toMatch(/lab-tube-liquid/);
    expect(tubes).toMatch(/lab-tube-specular/);
    expect(tubes).toMatch(/lab-tube-reflect/);
    expect(tubes).toMatch(/lab-tube-flow/);
    expect(tubes).toMatch(/ResizeObserver/);
    expect(tubes).toMatch(/aria-hidden/);
    expect(tubes).toMatch(/roundedOrtho/);
    expect(tubes.toLowerCase()).not.toMatch(/head|face|human|figure/);
    expect(css).toMatch(/--tube-glow-w:\s*26px/);
    expect(css).toMatch(/--tube-rim-w:\s*16px/);
    expect(css).toMatch(/--tube-glass-w:\s*13px/);
    expect(css).toMatch(/--tube-liquid-w:\s*9px/);
    expect(css).toMatch(/--tube-bend-r:\s*24px/);
    expect(css).toMatch(/--lab-tube-lime:\s*#b9ff87/i);
    expect(css).toMatch(/--lab-tube-pink:\s*#ff79c0/i);
    expect(css).toMatch(/--lab-tube-mint:\s*#8fffb6/i);
    expect(css).toMatch(/--lab-tube-purple:\s*#8049ff/i);
    expect(css).not.toMatch(/\.tube-shell/);
    expect(css).not.toMatch(/\.tube-body/);
    expect(css).not.toMatch(/\.tube-shine/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*\.bench-tubes \{ display: none/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*\.lab-tube-reflect[\s\S]*display:\s*none/);
    expect(css).toMatch(/data-tube-state="disabled"[\s\S]*lab-tube-flow[\s\S]*animation:\s*none/);
    expect(css).toMatch(/data-tube-state="disabled"[\s\S]*#9aa0a8/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lab-tube-flow[\s\S]*animation:\s*none/);
  });
});

describe("responsive chrome and legal surfaces", () => {
  it("keeps legal-copy from painting button labels black", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.legal-copy a:not\(\.btn\)/);
    expect(css).toMatch(/\.legal-copy a\.btn[^{]*\{[^}]*var\(--on-purple\)/);
    expect(css).toMatch(/\.legal-copy a\.btn-dark[^{]*\{[^}]*var\(--on-dark\)/);
    expect(css).toMatch(/\.legal-copy a\.btn-lime/);
  });

  it("sizes nav, legal nav, footer, and buttons for 44px taps", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.nav a[\s\S]*min-height:\s*44px/);
    expect(css).toMatch(/\.legal-nav a[\s\S]*min-height:\s*44px/);
    expect(css).toMatch(/\.site-footer nav a[\s\S]*min-height:\s*44px/);
    expect(css).toMatch(/touch-action:\s*manipulation/);
    expect(css).toMatch(/safe-area-inset/);
    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/text-size-adjust:\s*100%/);
    expect(css).toMatch(/min-height:\s*100dvh/);
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*\.piece-grid/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.site-header/);
  });

  it("splits privacy and terms into operator, network, and data surfaces", () => {
    const privacy = read("app/privacy/page.tsx");
    const legal = read("app/legal/page.tsx");
    expect(privacy).toMatch(/className="pearl[^"]*legal-copy"/);
    expect(privacy).toMatch(/className="terminal[^"]*legal-copy"/);
    expect(privacy).toMatch(/className="well[^"]*legal-copy"/);
    expect(legal).toMatch(/className="pearl[^"]*legal-copy"/);
    expect(legal).toMatch(/className="terminal[^"]*legal-copy"/);
    expect(legal).toMatch(/className="well[^"]*legal-copy"/);
  });

  it("publishes OG, twitter, and theme-color from the env site URL", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/openGraph/);
    expect(layout).toMatch(/siteName:\s*"LABx"/);
    expect(layout).toMatch(/hero-linked-panels\.jpg/);
    expect(layout).toMatch(/twitter/);
    expect(layout).toMatch(/themeColor:\s*"#E6D8FA"/);
    expect(layout).toMatch(/viewportFit:\s*"cover"/);
  });

  it("uniques Plumbing chrome gradient ids", () => {
    const plumbing = read("components/Plumbing.tsx");
    expect(plumbing).toMatch(/useId/);
    expect(plumbing).not.toMatch(/id=["']chrome["']/);
  });

  it("demotes the About hero CTA so Explore and Fairness stay on the fold", () => {
    const hub = read("components/BenchHub.tsx");
    expect(hub).toMatch(/Explore the bench/);
    expect(hub).toMatch(/How a draw stays fair/);
    expect(hub).toMatch(/className="hero-about"/);
    expect(read("app/globals.css")).toMatch(/\.hero-about/);
  });

  it("marks OnChainStatus as bench-only with a lavender lamp", () => {
    const status = read("components/OnChainStatus.tsx");
    expect(status).toMatch(/lamp lavender/);
    expect(status).toMatch(/bench only/);
  });
});
