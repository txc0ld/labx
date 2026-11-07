import type { Locator, Page } from "playwright";

export async function connectWallet(page: Page, ready: Locator, timeout = 15_000) {
  const connect = page.getByRole("button", { name: "Connect wallet", exact: true });
  await connect.or(ready).waitFor({ state: "visible", timeout }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Wallet connection did not become ready.";
    throw new Error(`${message}\nRendered page:\n${await page.locator("#content").innerText().catch(() => page.locator("body").innerText())}`);
  });
  if (await connect.isVisible().catch(() => false)) {
    // Wallet restoration can finish and remove the button between the check above and the click. The expected account is
    // then ready, so that counts as connected. A click that fails while the account is not ready still fails below.
    const clicked = connect.click({ timeout }).then(() => "clicked" as const, () => "click-failed" as const);
    const shown = ready.waitFor({ state: "visible", timeout }).then(() => "ready" as const, () => "not-ready" as const);
    await Promise.race([clicked, shown]);
  }
  await ready.waitFor({ state: "visible", timeout });
}
