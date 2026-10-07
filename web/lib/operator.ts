export const OPERATOR = {
  name: "Fantom Labs Pty Ltd",
  abn: "56 702 056 166",
  acn: "702 056 166",
  brand: "LABx",
  network: "Ethereum Sepolia",
  chainId: 11155111
} as const;

export const OPERATOR_LINE = `${OPERATOR.name} (ABN ${OPERATOR.abn}, ACN ${OPERATOR.acn})`;

const DEFAULT_SITE_URL = "https://labx.art";

export function publicSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw && /^https:\/\/[^\s/]+/i.test(raw)) return raw.replace(/\/$/, "");
  return DEFAULT_SITE_URL;
}

export function publicSiteHost(): string {
  try {
    return new URL(publicSiteUrl()).host;
  } catch {
    return "labx.art";
  }
}
