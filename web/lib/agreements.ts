export type AgreementInput = {
  address: string;
  terms: boolean;
  rules: boolean;
  age: boolean;
  pieceId?: string;
};

export function assertAgreements(input: AgreementInput): void {
  if (!input.address) throw new Error("A wallet is required.");
  if (!input.terms || !input.rules || !input.age) {
    throw new Error("All three agreements are required.");
  }
}
