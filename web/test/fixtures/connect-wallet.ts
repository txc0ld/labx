import type { Locator, Page } from "playwright";

export async function connectWallet(page: Page, ready: Locator, timeout = 15_000) {
  const connect = page.getByRole("button", { name: "Connect wallet", exact: true });
  await connect.or(ready).waitFor({ state: "visible", timeout }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Wallet connection did not become ready.";
    throw new Error(`${message}\nRendered page:\n${await page.locator("#content").innerText().catch(() => page.locator("body").innerText())}`);
  });
  if (await connect.isVisible().catch(() => false)) await connect.click();
  await ready.waitFor({ state: "visible", timeout });
}
