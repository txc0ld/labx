export class AmoeRequestError extends Error {}
export async function issueAmoeClaim(): Promise<never> {
  throw new AmoeRequestError("Complimentary entry is retired. Membership purchases are required.");
}
