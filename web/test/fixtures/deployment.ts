import type { DeploymentManifest } from "../../lib/chain/types";
import { PUBLISHED_TERMS_HASH } from "../../lib/published-terms";

export const fixtureTrust = {
  expectedOwner: "0x1111111111111111111111111111111111111111",
  expectedPolicy: {
    coordinator: "0x2222222222222222222222222222222222222222",
    treasury: "0x3333333333333333333333333333333333333333",
    termsHash: PUBLISHED_TERMS_HASH, keyHash: PUBLISHED_TERMS_HASH,
    subscriptionId: 1n, callbackGasLimit: 500_000, requestConfirmations: 3,
    nativePayment: false, buyerFeeBps: 200, sellerFeeBps: 200, minBuyerFeeUsdc: 2_500_000n
  }
} satisfies Pick<DeploymentManifest, "expectedOwner" | "expectedPolicy">;
