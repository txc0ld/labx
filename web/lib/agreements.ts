export type AgreementInput = {
  address: string;
  terms: boolean;
  rules: boolean;
  age: boolean;
  pieceId?: string;
};

export function assertAgreements(input: AgreementInput): void {
  if (!input || typeof input.address !== "string" || !input.address) throw new Error("A wallet is required.");
  if (input.terms !== true || input.rules !== true || input.age !== true) {
    throw new Error("All three agreements are required.");
  }
}
