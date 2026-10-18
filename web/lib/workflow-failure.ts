/** A signed workflow request the server refuses: an expired or invalid signature, or a wallet, deployment or NFT that does not match. */
export class WorkflowRefusal extends Error {}

/** How far a signed workflow route got: reading the request, checking the deployment, then the signed step with its chain and storage reads. */
export type WorkflowStage = "request" | "deployment" | "records";

/**
 * 400 for a malformed request, 401 for a refusal, and 503 when the deployment check, a chain read or storage failed, which
 * a retry can fix. Logs one line of fixed labels, because the request and error text can carry a signature or private commitment.
 */
export function workflowFailure(route: string, stage: WorkflowStage, error: unknown, messages: { invalid: string; refused: string; unavailable: string }): Response {
  const failure = error instanceof WorkflowRefusal ? { status: 401, reason: "refused", message: messages.refused }
    : stage === "request" ? { status: 400, reason: "invalid-request", message: messages.invalid }
    : { status: 503, reason: `${stage}-unavailable`, message: messages.unavailable };
  console.error(`workflow-request ${route} ${failure.status} ${failure.reason}`);
  return Response.json({ ok: false, error: failure.message }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
}
