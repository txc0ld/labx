import { describe, expect, it } from "vitest";
import { readRaffleFrom } from "../components/workflow/RaffleWorkspace";
import type { RaffleSnapshot } from "../lib/chain/types";

/** A service whose successive raffle reads are pinned to `blocks`, as a load-balanced RPC answers from nodes at different heights. */
function serviceAt(blocks: readonly bigint[]) {
  let reads = 0;
  const waits: number[] = [];
  return {
    service: { readRaffle: async ({ id }: { id: bigint }) => ({ id, block: { number: blocks[Math.min(reads++, blocks.length - 1)] } }) as RaffleSnapshot },
    wait: async (ms: number) => { waits.push(ms); },
    reads: () => reads,
    waits
  };
}

describe("raffle read after a confirmed transaction", () => {
  it("shows the first read when the page has confirmed nothing", async () => {
    const node = serviceAt([40n]);
    expect((await readRaffleFrom(node.service, 7n, 0n, node.wait)).block.number).toBe(40n);
    expect(node.reads()).toBe(1);
    expect(node.waits).toEqual([]);
  });

  it("reads again until the raffle is at or after the confirmed block", async () => {
    // The approval confirmed in block 42; two reads come from a node still at block 41.
    const node = serviceAt([41n, 41n, 43n]);
    const snapshot = await readRaffleFrom(node.service, 7n, 42n, node.wait);
    expect(snapshot.block.number).toBe(43n);
    expect(node.reads()).toBe(3);
    expect(node.waits).toEqual([2_000, 2_000]);
  });

  it("accepts a read at the confirmed block itself", async () => {
    const node = serviceAt([42n]);
    expect((await readRaffleFrom(node.service, 7n, 42n, node.wait)).block.number).toBe(42n);
    expect(node.reads()).toBe(1);
  });

  it("fails after five reads behind the confirmed block instead of showing the older raffle", async () => {
    const node = serviceAt([41n]);
    await expect(readRaffleFrom(node.service, 7n, 42n, node.wait)).rejects.toThrow("The network hasn’t caught up with your confirmed transaction yet. Try again in a moment.");
    expect(node.reads()).toBe(5);
    expect(node.waits).toEqual([2_000, 2_000, 2_000, 2_000]);
  });
});
