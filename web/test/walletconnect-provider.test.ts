import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createWalletConnectProvider } from "../lib/chain/walletconnect-provider";

const sdk = vi.hoisted(() => ({ init: vi.fn(), create: vi.fn() }));
vi.mock("@walletconnect/ethereum-provider", () => ({ EthereumProvider: { init: sdk.init } }));
vi.mock("@reown/appkit/core", () => ({ createAppKit: sdk.create }));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const events = new EventEmitter();
  const approval = deferred();
  const pairingDisconnect = vi.fn(async () => {}), transportClose = vi.fn(async () => {}), stop = vi.fn();
  const revoke = vi.fn(async () => {});
  const states = new Set<(state: { open: boolean }) => void>();
  const modal = {
    ready: vi.fn(async () => {}),
    open: vi.fn(async () => { for (const state of states) state({ open: true }); }),
    close: vi.fn(async () => { for (const state of states) state({ open: false }); }),
    subscribeState: (state: (state: { open: boolean }) => void) => { states.add(state); return () => states.delete(state); }
  };
  let session: { topic: string } | undefined;
  const instance = {
    events,
    signer: { events: new EventEmitter(), client: { disconnect: revoke, core: {
      pairing: { getPairings: () => [{ topic: "pairing" }], disconnect: pairingDisconnect },
      relayer: { transportClose }, heartbeat: { stop }
    } } },
    get session() { return session; },
    request: vi.fn(async () => []),
    connect: vi.fn(() => { events.emit("display_uri", "wc:test-fixture"); return approval.promise.then(() => { session = { topic: "late-session" }; }); }),
    disconnect: vi.fn(async () => {}),
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => events.removeListener(event, listener)
  };
  sdk.init.mockResolvedValueOnce(instance);
  sdk.create.mockReturnValueOnce(modal);
  return { instance, approval, modal, states, revoke, pairingDisconnect, transportClose, stop };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("official WalletConnect adapter lifecycle", () => {
  it("initializes only when called, requests only Sepolia methods, and disables optional services", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const f = fixture();
    expect(sdk.init).not.toHaveBeenCalled();
    const remote = await createWalletConnectProvider("a".repeat(32));
    expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ chains: [11155111], optionalChains: [], methods: ["personal_sign", "eth_sendTransaction"], optionalMethods: [], showQrModal: false, telemetryEnabled: false }));
    expect(sdk.create).not.toHaveBeenCalled();
    const connecting = remote.connect(new AbortController().signal);
    await vi.waitFor(() => expect(f.modal.open).toHaveBeenCalledWith({ view: "ConnectingWalletConnectBasic", uri: "wc:test-fixture" }));
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ manualWCControl: true, enableReconnect: false, universalProvider: f.instance.signer, features: { analytics: false, email: false, socials: false, onramp: false, swaps: false } }));
    f.approval.resolve(); await connecting;
    expect(f.states.size).toBe(0);
    expect(f.instance.events.listenerCount("display_uri")).toBe(0);
    await remote.disconnect();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.transportClose).toHaveBeenCalledOnce();
    expect(f.pairingDisconnect).toHaveBeenCalledWith({ topic: "pairing" });
  });
  it("retires repeated cancelled attempts and revokes a late approval without closing the new modal", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = fixture();
      const remote = await createWalletConnectProvider("a".repeat(32));
      const abort = new AbortController();
      const connecting = remote.connect(abort.signal);
      const rejected = expect(connecting).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(old.modal.open).toHaveBeenCalledOnce());
      abort.abort();
      await rejected;
      await remote.disconnect();
      expect(old.stop).toHaveBeenCalledOnce();
      expect(old.transportClose).toHaveBeenCalledOnce();
      expect(old.states.size).toBe(0);
      expect(old.instance.events.eventNames()).toHaveLength(0);
      const next = fixture();
      const nextRemote = await createWalletConnectProvider("a".repeat(32));
      const nextConnect = nextRemote.connect(new AbortController().signal);
      await vi.waitFor(() => expect(next.modal.open).toHaveBeenCalledOnce());
      old.approval.resolve();
      await vi.waitFor(() => expect(old.revoke).toHaveBeenCalledWith({ topic: "late-session", reason: { code: 6000, message: "Connection cancelled" } }));
      expect(next.modal.close).not.toHaveBeenCalled();
      expect(next.instance.disconnect).not.toHaveBeenCalled();
      next.approval.resolve(); await nextConnect; await nextRemote.disconnect();
    }
  });
  it("treats QR dismissal as cancellation and allows the next explicit attempt", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const f = fixture();
    const remote = await createWalletConnectProvider("a".repeat(32));
    const connecting = remote.connect(new AbortController().signal);
    const rejected = expect(connecting).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(f.modal.open).toHaveBeenCalledOnce());
    for (const state of f.states) state({ open: false });
    await rejected; await remote.disconnect();
    expect(f.states.size).toBe(0);
    f.approval.resolve();
  });
  it("does not start pairing if cancellation occurs while the official modal initializes", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const f = fixture(), ready = deferred();
    f.modal.ready.mockImplementationOnce(() => ready.promise);
    const remote = await createWalletConnectProvider("a".repeat(32));
    const abort = new AbortController();
    const connecting = remote.connect(abort.signal);
    const rejected = expect(connecting).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(f.modal.ready).toHaveBeenCalledOnce());
    abort.abort(); ready.resolve();
    await rejected; await remote.disconnect();
    expect(f.instance.connect).not.toHaveBeenCalled();
    expect(f.modal.open).not.toHaveBeenCalled();
  });
  it("bounds uncancellable SDK approvals after repeated QR cancellation", async () => {
    vi.stubGlobal("window", { location: { origin: "https://labx.test" } });
    const cancelled = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = fixture();
      cancelled.push(f);
      const remote = await createWalletConnectProvider("a".repeat(32));
      const abort = new AbortController();
      const connecting = remote.connect(abort.signal);
      const rejected = expect(connecting).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(f.modal.open).toHaveBeenCalledOnce());
      abort.abort(); await rejected; await remote.disconnect();
    }
    const extra = fixture();
    const remote = await createWalletConnectProvider("a".repeat(32));
    await expect(remote.connect(new AbortController().signal)).rejects.toThrow(/still closing/);
    expect(extra.instance.connect).not.toHaveBeenCalled();
    await remote.disconnect();
    for (const f of cancelled) {
      f.approval.resolve();
      await vi.waitFor(() => expect(f.revoke).toHaveBeenCalledOnce());
    }
  });

});
