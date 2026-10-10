/** The four wallet prompts one Create activation can request, in order. Approval is skipped when the NFT is already approved. */
export const CREATE_STEPS = {
  saveSetup: "Step 1 of 4: sign in your wallet to save your raffle setup.",
  restoreSetup: "Step 1 of 4: sign in your wallet to restore your raffle setup.",
  createDraft: "Step 2 of 4: confirm in your wallet to create the raffle.",
  approveNft: (tokenId: bigint | string) => `Step 3 of 4: approve NFT #${tokenId.toString()} in your wallet.`,
  lockNft: "Step 4 of 4: confirm in your wallet to lock the NFT."
} as const;

/** Plain progress text for a step reported by `finishCreate`. Unrecognized steps pass through unchanged. */
export function createStepMessage(step: string, tokenId: bigint | string): string {
  switch (step) {
    case "Creating the on-chain draft…": return CREATE_STEPS.createDraft;
    case "Approve this NFT in your wallet…": return CREATE_STEPS.approveNft(tokenId);
    case "Locking the NFT in raffle custody…": return CREATE_STEPS.lockNft;
    default: return step;
  }
}

/** The same text without "Step N of 4: ", for finishing a raffle that already exists, which needs fewer wallet prompts. */
export function unnumberedStep(message: string): string {
  const text = message.replace(/^Step \d of 4: /, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
