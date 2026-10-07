import { describe, expect, it } from "vitest";
import { isWalletRequestRejected } from "../lib/chain/wallet-errors";

describe("definite wallet request rejection", () => {
  it.each([4001, 5000])("accepts only the direct numeric code %s", code => {
    expect(isWalletRequestRejected({ code })).toBe(true);
    expect(isWalletRequestRejected(Object.assign(new Error("Rejected"), { code }))).toBe(true);
  });
  it.each([undefined, null, "user rejected", new Error("User cancelled"), { code: "4001" }, { code: "5000" }, { cause: { code: 4001 } }, { error: { code: 5000 } }, { code: -32603, data: { code: 4001 } }, { code: 4900 }])("retains uncertainty for %j", error => {
    expect(isWalletRequestRejected(error)).toBe(false);
  });
});
