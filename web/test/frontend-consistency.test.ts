import { describe, expect, it } from "vitest";
import { readFromBlock, newestRead } from "../components/workflow/RaffleWorkspace";

/** A read whose successive answers are pinned to `blocks`, as a load-balanced RPC answers from nodes at different heights. */
function nodeAt(blocks: readonly bigint[]) {
  let reads = 0;
  const waits: number[] = [];
  return {
    read: async () => ({ block: { number: blocks[Math.min(reads++, blocks.length - 1)] } }),
    wait: async (ms: number) => { waits.push(ms); },
    reads: () => reads,
    waits
  };
}

describe("read after a confirmed transaction", () => {
  it("shows the first read when the page has confirmed nothing", async () => {
    const node = nodeAt([40n]);
    expect((await readFromBlock(node.read, 0n, node.wait)).block.number).toBe(40n);
    expect(node.reads()).toBe(1);
    expect(node.waits).toEqual([]);
  });

  it("reads again until the read is at or after the confirmed block", async () => {
    // The approval confirmed in block 42; two reads come from a node still at block 41.
    const node = nodeAt([41n, 41n, 43n]);
    const snapshot = await readFromBlock(node.read, 42n, node.wait);
    expect(snapshot.block.number).toBe(43n);
    expect(node.reads()).toBe(3);
    expect(node.waits).toEqual([2_000, 2_000]);
  });

  it("accepts a read at the confirmed block itself", async () => {
    const node = nodeAt([42n]);
    expect((await readFromBlock(node.read, 42n, node.wait)).block.number).toBe(42n);
    expect(node.reads()).toBe(1);
  });

  it("fails after five reads behind the confirmed block instead of returning the older state", async () => {
    const node = nodeAt([41n]);
    await expect(readFromBlock(node.read, 42n, node.wait)).rejects.toThrow("The network hasn’t caught up yet. Try again in a moment.");
    expect(node.reads()).toBe(5);
    expect(node.waits).toEqual([2_000, 2_000, 2_000, 2_000]);
  });
});

describe("order of background reads", () => {
  it("drops a read older than one already seen, even when the newer one changed nothing visible", () => {
    const seen = { current: 0n };
    // Two overlapping re-reads from blocks 51 and 52 finish newest first.
    expect(newestRead(seen, 52n)).toBe(true);
    expect(newestRead(seen, 51n)).toBe(false);
    expect(newestRead(seen, 52n)).toBe(true);
    expect(newestRead(seen, 53n)).toBe(true);
    expect(seen.current).toBe(53n);
  });
});
