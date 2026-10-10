"use client";
import { useState } from "react";
import { isHex, type Hex } from "viem";

export function CreateRecoveryControls({ disabled, onRecover, onEdit }: {
  disabled: boolean; onRecover?: (hash: Hex) => void; onEdit?: () => void;
}) {
  const [hash, setHash] = useState("");
  return <details><summary>Advanced recovery</summary><div className="stack">
    {onRecover ? <><p>Paste the transaction hash from your wallet's activity to check it. Nothing new is sent.</p><label>Creation transaction hash<input value={hash} onChange={event => setHash(event.target.value.trim())} placeholder="0x…" spellCheck={false} autoCapitalize="none" /></label><button className="btn btn-dark" type="button" disabled={disabled || !isHex(hash, { strict: true }) || hash.length !== 66} onClick={() => { if (isHex(hash, { strict: true }) && hash.length === 66) onRecover(hash); }}>Recover creation transaction</button></> : null}
    {onEdit ? <><p>Start over to edit the details. This works only before the raffle is created and while no wallet transaction is pending.</p><button className="text-link" type="button" disabled={disabled} onClick={onEdit}>Start over and edit details</button></> : null}
  </div></details>;
}
