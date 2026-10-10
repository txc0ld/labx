import type { Page } from "playwright";

/** For a transaction request: its call, the latest block when the wallet was asked, and the hash it returned. */
export type WalletRequest = { method: string; to?: string; data?: string; block?: string; hash?: string };
type Recorder = { reviews: number; requests: WalletRequest[]; reject: string[] };
type Provider = { request(input: { method: string; params?: readonly unknown[] }): Promise<unknown> };
type Scope = Window & { __labxWalletWatch?: Recorder; ethereum: Provider };

/**
 * Until the page navigates, records each website review that renders and each wallet transaction or signature request,
 * so a test can show that a seller step reached the wallet with its exact call and no website review in between.
 * reject(prefix) makes the next transaction request whose calldata starts with prefix fail with the standard 4001 rejection.
 */
export async function watchWallet(page: Page) {
  await page.evaluate(() => {
    const scope = window as unknown as Scope;
    if (scope.__labxWalletWatch) {
      Object.assign(scope.__labxWalletWatch, { reviews: 0, requests: [], reject: [] });
      return;
    }
    const recorder: Recorder = { reviews: 0, requests: [], reject: [] };
    scope.__labxWalletWatch = recorder;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches("section.transaction-review") || node.querySelector("section.transaction-review"))) recorder.reviews += 1;
      }
    }).observe(document.body, { childList: true, subtree: true });
    const provider = scope.ethereum, original = provider.request.bind(provider);
    provider.request = async input => {
      if (input.method === "personal_sign") recorder.requests.push({ method: input.method });
      if (input.method === "eth_sendTransaction") {
        const call = input.params?.[0] as { to?: string; data?: string } | undefined;
        const data = call?.data?.toLowerCase();
        const request: WalletRequest = { method: input.method, to: call?.to?.toLowerCase(), data, block: BigInt(String(await original({ method: "eth_blockNumber" }))).toString() };
        recorder.requests.push(request);
        const rejected = data === undefined ? -1 : recorder.reject.findIndex(prefix => data.startsWith(prefix));
        if (rejected >= 0) {
          recorder.reject.splice(rejected, 1);
          throw Object.assign(new Error("Rejected in the test wallet"), { code: 4001 });
        }
        const result = await original(input);
        request.hash = String(result);
        return result;
      }
      return original(input);
    };
  });
  return {
    reviews: () => page.evaluate(() => (window as unknown as Scope).__labxWalletWatch?.reviews ?? 0),
    requests: () => page.evaluate(() => (window as unknown as Scope).__labxWalletWatch?.requests ?? []),
    reject: (prefix: string) => page.evaluate((value: string) => { (window as unknown as Scope).__labxWalletWatch?.reject.push(value.toLowerCase()); }, prefix)
  };
}
