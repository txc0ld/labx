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

/** Nothing was sent and no pending record remains. The message is one plain sentence a person can act on. */
export class NotSentError extends Error {
  constructor(message: string) { super(message); this.name = "NotSentError"; }
}

/** Whether an error, or the error a not-dispatched wrapper carries, is a NotSentError. */
export function isNotSent(error: unknown): boolean {
  return error instanceof NotSentError || error instanceof SubmissionNotDispatchedError && error.cause instanceof NotSentError;
}
