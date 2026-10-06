import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brandSplashVideoSource, shouldShowBrandSplash } from "../components/BrandSplash";

const webRoot = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(webRoot, file), "utf8");

describe("brand splash eligibility", () => {
  it("shows only for a fresh, motion-enabled homepage arrival", () => {
    const eligible = {
      hasHashTarget: false,
      pathname: "/",
      reducedMotion: false,
      saveData: false,
      sessionStatus: "fresh"
    } satisfies Parameters<typeof shouldShowBrandSplash>[0];
    expect(shouldShowBrandSplash(eligible)).toBe(true);
    expect(shouldShowBrandSplash({ ...eligible, pathname: "/profile" })).toBe(false);
    expect(shouldShowBrandSplash({ ...eligible, hasHashTarget: true })).toBe(false);
    expect(shouldShowBrandSplash({ ...eligible, reducedMotion: true })).toBe(false);
    expect(shouldShowBrandSplash({ ...eligible, saveData: true })).toBe(false);
    expect(shouldShowBrandSplash({ ...eligible, sessionStatus: "handled" })).toBe(false);
    expect(shouldShowBrandSplash({ ...eligible, sessionStatus: "unavailable" })).toBe(false);
  });

  it("selects the initial video for the viewport orientation", () => {
    expect(brandSplashVideoSource(false)).toBe("/brand/labx-intro-wide.mp4");
    expect(brandSplashVideoSource(true)).toBe("/brand/labx-intro-tall.mp4");
  });
});

describe("brand splash integration", () => {
  it("mounts in the root layout and keeps media behind eligibility", () => {
    const layout = read("app/layout.tsx");
    const component = read("components/BrandSplash.tsx");

    expect(layout).toMatch(/<BrandSplash \/>/);
    expect(component).toMatch(/state\.kind !== "showing"\) return null/);
    expect(component).toMatch(/<dialog/);
    expect(component).toMatch(/object-fit: contain|styles\.video/);
    expect(component).toMatch(/onEnded=\{dismiss\}/);
    expect(component).toMatch(/onError=\{dismiss\}/);
    expect(component).toMatch(/onCancel=/);
    expect(component).toMatch(/STARTUP_TIMEOUT_MS = 5_000/);
    expect(component).toMatch(/focus\(\{ preventScroll: true \}\)/);
    expect(component).toMatch(/typeof dialog\.showModal !== "function"/);
    expect(component).toMatch(/try \{\s+if \(!dialog\.open\) dialog\.showModal\(\)/);
  });

  it("ships visible, touch-sized controls and reduced-motion handling", () => {
    const component = read("components/BrandSplash.tsx");
    const css = read("components/BrandSplash.module.css");

    expect(component).toMatch(/Skip intro/);
    expect(component).toMatch(/Sound on/);
    expect(component).toMatch(/Mute/);
    expect(component).toMatch(/addEventListener\("change", handleMotionChange\)/);
    expect(css).toMatch(/min-width: 44px/);
    expect(css).toMatch(/min-height: 44px/);
    expect(css).toMatch(/safe-area-inset-top/);
    expect(css).toMatch(/focus-visible/);
  });
});
