import type { RafflePolicy } from "./types";
import { sameAddress } from "./validation";

export function requireExpectedPolicy(actual: RafflePolicy, expected: RafflePolicy): void {
  const matches = sameAddress(actual.coordinator, expected.coordinator) && sameAddress(actual.treasury, expected.treasury)
    && actual.termsHash.toLowerCase() === expected.termsHash.toLowerCase() && actual.keyHash.toLowerCase() === expected.keyHash.toLowerCase()
    && actual.subscriptionId === expected.subscriptionId && actual.callbackGasLimit === expected.callbackGasLimit
    && actual.requestConfirmations === expected.requestConfirmations && actual.nativePayment === expected.nativePayment
    && actual.buyerFeeBps === expected.buyerFeeBps && actual.sellerFeeBps === expected.sellerFeeBps
    && actual.minBuyerFeeUsdc === expected.minBuyerFeeUsdc;
  if (!matches) throw new Error("New approvals, openings or purchases are unavailable: this policy does not match the reviewed deployment.");
}
