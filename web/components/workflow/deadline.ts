const pad = (value: number) => String(value).padStart(2, "0");

/** A `datetime-local` value for the instant, in the browser's time zone, truncated to the minute. */
export function localDeadlineInput(seconds: number | bigint): string {
  const date = new Date(Number(seconds) * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Unix seconds for a `datetime-local` value read as the seller's local wall time.
 * Returns null for malformed values and for local times a clock change skips,
 * so the saved deadline is always the instant the seller sees.
 */
export function localDeadlineSeconds(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const seconds = new Date(year, month - 1, day, hour, minute).getTime() / 1000;
  return Number.isFinite(seconds) && localDeadlineInput(seconds) === value ? seconds : null;
}
