import type { Page } from "playwright";

export async function openWalletActivity(page: Page) {
  const activity = page.locator(".resume-transaction details").filter({ has: page.locator("summary", { hasText: /^Activity \(/ }) });
  await activity.waitFor({ state: "visible", timeout: 15_000 });
  if (!await activity.evaluate(element => element.hasAttribute("open"))) await activity.locator("summary").click();
}
