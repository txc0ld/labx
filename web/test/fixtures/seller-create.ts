import type { Page } from "playwright";

/** The `datetime-local` text the browser shows for an instant in its own time zone. */
export async function localDeadlineValue(page: Page, seconds: number | bigint): Promise<string> {
  return page.evaluate((value) => {
    const date = new Date(value * 1000);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, Number(seconds));
}

/** Waits for the Studio raffle scan, after which Create no longer opens by itself, then opens Create if it is closed. */
export async function openCreatePanel(page: Page): Promise<void> {
  await page.getByText(/^\d+ total$/).waitFor({ state: "visible", timeout: 15_000 });
  const panel = page.locator("section[aria-label='Create a raffle draft'] > details");
  if (!await panel.evaluate((details) => (details as HTMLDetailsElement).open)) await panel.locator("summary").click();
  await page.locator("section[aria-label='Create a raffle draft'] > details[open]").waitFor();
}
