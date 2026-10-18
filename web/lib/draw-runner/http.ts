import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Store } from "../points";
import { sameAddress } from "../chain/validation";
import { MIN_CRON_SECRET_LENGTH, validBearer } from "../notifications/http";
import { errorCategory, within } from "./errors";
import { FINISH_RESERVE_MS, RUN_MS, runDraw, type DrawChain, type RunReport } from "./run";

/** Reads the server-only runner key: 64 hex characters, with or without 0x, ignoring surrounding whitespace. Returns null for a missing or malformed key, which disables the runner. */
export function runnerAccount(value: string | undefined): PrivateKeyAccount | null {
  const hex = value?.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  if (!hex) return null;
  try { return privateKeyToAccount(`0x${hex}`); } catch { return null; }
}

export function createDrawCronHandler(dependencies: {
  store: () => Store;
  chain: (account: PrivateKeyAccount) => Promise<DrawChain>;
  now?: () => number;
}) {
  const now = dependencies.now ?? (() => Date.now());
  return async function GET(request: Request): Promise<Response> {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return refused("Draw runner cron is not configured.", {});
    if (!validBearer(request.headers.get("authorization"), secret)) return cronError("Draw runner authorization failed.", 401);
    const account = runnerAccount(process.env.LABX_KEEPER_PRIVATE_KEY);
    if (!account) return refused("The draw runner key is missing or invalid.", { key: process.env.LABX_KEEPER_PRIVATE_KEY ? "malformed" : "missing" });
    const deadline = now() + RUN_MS;

    let chain: DrawChain;
    try {
      chain = await within(dependencies.chain(account), deadline - FINISH_RESERVE_MS - now());
      const privileged = await within(chain.privilegedAddresses(), deadline - FINISH_RESERVE_MS - now());
      if (privileged.some(item => sameAddress(item, account.address))) {
        return refused("The draw runner key must not belong to the LABx owner, a Safe signer or the treasury.", { runner: account.address });
      }
    } catch (error) {
      return refused("The draw runner could not check the deployment.", { runner: account.address, category: errorCategory(error) });
    }

    let report: RunReport;
    try {
      report = await runDraw({ chain, store: dependencies.store(), now, deadline });
    } catch (error) {
      return refused("The draw runner did not complete.", { runner: account.address, category: errorCategory(error) });
    }
    console.info("draw-runner", report);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  };
}

/** A 503 that also leaves a log line, so a runner that never runs shows why. The detail is a fixed label or a public address, never the key or an error message. */
function refused(error: string, detail: Record<string, string>): Response {
  console.error("draw-runner", { ok: false, error, ...detail });
  return cronError(error, 503);
}

function cronError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}
