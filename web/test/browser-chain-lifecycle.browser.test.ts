import { describe, expect, it } from "vitest";
import { browserChain } from "./fixtures/browser-chain";
import { localChain } from "./fixtures/local-chain";

const run = process.env.RUN_BROWSER_FIXTURE_LIFECYCLE === "1" ? describe : describe.skip;

function processExists(id: number) {
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

run("browser chain fixture lifetime", () => {
  it("closes its listener and complete owned process tree", async () => {
    const chain = await localChain();
    let fixture: Awaited<ReturnType<typeof browserChain>> | undefined;
    try {
      fixture = await browserChain(chain);
      const response = await fixture.page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      expect(await fetch(fixture.baseUrl)).toHaveProperty("status", 200);

      const processId = fixture.serverProcessId;
      const processGroupId = fixture.serverProcessGroupId;
      expect(processId).toBeTypeOf("number");
      expect(processExists(processGroupId === null ? processId! : -processGroupId!)).toBe(true);

      await fixture.close();
      await fixture.close();

      await expect(fetch(fixture.baseUrl, { signal: AbortSignal.timeout(1_000) })).rejects.toBeInstanceOf(Error);
      expect(processExists(processGroupId === null ? processId! : -processGroupId!)).toBe(false);
    } finally {
      await fixture?.close();
      chain.close();
    }
  }, 60_000);
});
