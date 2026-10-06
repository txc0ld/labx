import { describe, expect, it } from "vitest";
import { formatUsdcInput, parseUsdc } from "../components/workflow/format";
import { loadPrivateRecordBatches } from "../components/workflow/record-batches";
import type { HistoryItem } from "../lib/chain/types";
describe("reviewed workflow repair boundaries", () => {
  it("roundtrips large exact membership prices through editable decimal inputs", () => {
    for (const amount of [1000000000n,1234567890n,1000000000000n]) expect(parseUsdc(formatUsdcInput(amount))).toBe(amount);
    expect(formatUsdcInput(1234500000n)).toBe("1234.5");
  });
  it("loads more than thirty distinct raffles/purchases without exceeding either API bound", async () => {
    const purchases: HistoryItem[] = Array.from({length:65},(_,i)=>({raffleId:BigInt(i+1),event:"PackPurchased",transactionHash:`0x${(i+1).toString(16).padStart(64,"0")}`,logIndex:0,blockNumber:1n,account:"0x1111111111111111111111111111111111111111",principal:1n,fee:1n,quantity:1,bonusEntries:1}));
    const sizes: number[]=[];
    const result=await loadPrivateRecordBatches(purchases,async input=>{expect(input.raffleIds.length).toBeLessThanOrEqual(30);expect(input.purchases.length).toBeLessThanOrEqual(30);sizes.push(input.purchases.length);return{agreements:input.raffleIds.map(raffleId=>({raffleId,recorded:true,at:null})),receipts:input.purchases.map(item=>({...item,status:"missing"}))};});
    expect(sizes).toEqual([30,30,5]);expect(result.agreements).toHaveLength(65);expect(result.receipts).toHaveLength(65);
  });
});
