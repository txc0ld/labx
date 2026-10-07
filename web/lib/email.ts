export type Receipt = {
  to: string;
  piece: string;
  pack: string;
  entries: number;
  priceUsdc: number | string;
  feeUsdc: number | string;
};

export function receiptBody(input: Receipt): { subject: string; html: string; text: string } {
  const subject = `LABx membership pack — ${input.piece}`;
  const text = [
    `Membership pack: ${input.pack}`,
    `Piece: ${input.piece}`,
    `Bonus entries: ${input.entries}`,
    `Pack price: ${input.priceUsdc} USDC`,
    `Nonrefundable processing fee: ${input.feeUsdc} USDC`,
    "If this raffle is cancelled, only the pack price is refundable.",
    "Bonus entries expire 12 months after they are recorded.",
    "This note is a membership receipt."
  ].join("\n");
  const html = `<p>Your <strong>${escapeHtml(input.pack)}</strong> membership pack for <strong>${escapeHtml(input.piece)}</strong> is recorded.</p>
<p>${input.entries} bonus entries. Pack price ${input.priceUsdc} USDC. Nonrefundable processing fee ${input.feeUsdc} USDC.</p>
<p>If this raffle is cancelled, only the pack price is refundable.</p>
<p>Bonus entries expire 12 months after they are recorded.</p>`;
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
