"use client";

import { useEffect, useState } from "react";
import type { RaffleService } from "@/lib/chain/ports";
import type { RaffleSnapshot } from "@/lib/chain/types";

type RevealTime = { service: RaffleService; id: bigint; seenAt: bigint; eventAt: bigint | null };

/**
 * The block time LABx's finish step is timed from once a drawn raffle's draw is confirmed and the draw runner is on: the block time
 * of the raffle's Revealed event. Until that read succeeds, and whenever it fails, it is the block time at which this view first saw
 * the draw confirmed with this service, which is never earlier. A failed read is tried again with the next raffle read. Undefined
 * when LABx has no finish step to time.
 */
export function useRevealTime(service: RaffleService | null, snapshot: RaffleSnapshot | null, runner: boolean): bigint | undefined {
  const [state, setState] = useState<RevealTime | null>(null);
  const timed = runner && service !== null && snapshot !== null && snapshot.raffle.phase === 4 && snapshot.raffle.revealed ? { service, snapshot } : null;
  const current = timed && state?.service === timed.service && state.id === timed.snapshot.id ? state : null;
  if (timed && !current) setState({ service: timed.service, id: timed.snapshot.id, seenAt: timed.snapshot.block.timestamp, eventAt: null });
  const read = timed && current?.eventAt == null ? timed : null;
  useEffect(() => {
    if (!read) return;
    const { service, snapshot } = read;
    let active = true;
    service.readRevealTime({ id: snapshot.id, block: snapshot.block }).then(eventAt => {
      if (active) setState(value => value?.service === service && value.id === snapshot.id ? { ...value, eventAt } : value);
    }, () => { /* The time this view first saw the draw confirmed stays in use. */ });
    return () => { active = false; };
    // One read per raffle block until one succeeds, with the service that read the raffle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read?.service, read?.snapshot.id, read?.snapshot.block.hash]);
  if (!timed) return undefined;
  return current?.eventAt ?? current?.seenAt ?? timed.snapshot.block.timestamp;
}
