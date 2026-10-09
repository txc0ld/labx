export class SubmissionNotDispatchedError extends Error {
  readonly code: number | undefined;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "The transaction was not sent to the wallet.", { cause });
    this.code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "number" ? cause.code : undefined;
    this.name = "SubmissionNotDispatchedError";
  }
}

export class PreparationNotDispatchedError extends SubmissionNotDispatchedError {
  constructor(cause: unknown) { super(cause); this.name = "PreparationNotDispatchedError"; }
}
