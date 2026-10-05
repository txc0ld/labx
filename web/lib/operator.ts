export const OPERATOR = {
  name: "Fantom Labs Pty Ltd",
  abn: "56 702 056 166",
  acn: "702 056 166",
  brand: "LABx",
  site: "labx.art",
  network: "Ethereum Sepolia",
  chainId: 11155111
} as const;

export const OPERATOR_LINE = `${OPERATOR.name} (ABN ${OPERATOR.abn}, ACN ${OPERATOR.acn})`;
