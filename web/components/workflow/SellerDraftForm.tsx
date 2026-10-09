"use client";

import { useRouter } from "next/navigation";
import { PreparationNotDispatchedError } from "@/lib/chain/submission-errors";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isAddress, zeroHash, type Hex, type Address } from "viem";
import type { RaffleService, WalletSessionPort } from "@/lib/chain/ports";
import type { DraftInput, RaffleSnapshot } from "@/lib/chain/types";
import type { PublicReserve } from "@/lib/reserve";
import { automaticCommitmentKey, prepareAutomaticCommitment } from "@/lib/automatic-commitment";
import { isWalletRequestRejected } from "@/lib/chain/wallet-errors";
import { STANDARD_MEMBERSHIP_TIERS } from "@/lib/membership-tiers";
import { canApplyWalletNftSelection, fetchWalletNfts, mergeWalletNftItems, nftTitle, shouldAutofillWalletNftTitle, type WalletNft } from "@/lib/wallet-nfts";
import { captureCreateGeneration, assertCreateGeneration, advanceCreateGeneration, retireUnsentCreate, recoverCreateTransaction, createStorageKey, decodeDraft, encodeDraft, finishCreate, readCreateRecord, writeCreateRecord, retireCompletedCreate, type CreateRecord } from "@/lib/chain/create-flow";
import { recoverPreparation } from "@/lib/chain/api";
import { CreateRecoveryControls } from "./CreateRecoveryControls";
import { TransactionFlow } from "./TransactionFlow";
import { formatDate, formatUsdc, formatUsdcInput, parseUsdc, shortAddress } from "./format";
import { useWalletSnapshot } from "./WalletGate";
import formStyles from "./SellerDraftForm.module.css";

type PackDraft = { id: string; name: string; price: string; bonusEntries: string; maxSupply: string };
type PackEconomicsKey = "price" | "bonusEntries" | "maxSupply";
type FormDraft = { nft: string; tokenId: string; title: string; closing: string; packs: PackDraft[] };
type CommitmentPreparation = { key: string; input: { publicSummary: string; privateCommitment: string } };
type InventoryState =
  | { kind: "idle" }
  | { kind: "loading"; items: readonly WalletNft[]; nextCursor: string | null; requestedCursors: readonly string[]; append: boolean }
  | { kind: "ready"; items: readonly WalletNft[]; nextCursor: string | null; requestedCursors: readonly string[]; message: string }
  | { kind: "error"; items: readonly WalletNft[]; message: string };
type DraftState =
  | { kind: "editing" }
  | { kind: "review"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "saving"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit"> }
  | { kind: "committed"; action: Omit<DraftInput, "reserveNonce" | "reserveCommit">; reserve: PublicReserve }
  | { kind: "retained"; action: DraftInput }
  | { kind: "error"; message: string };

const INITIAL: FormDraft = {
  nft: "",
  tokenId: "",
  title: "",
  closing: "",
  packs: STANDARD_MEMBERSHIP_TIERS.map((name) => ({ id: `standard-${name.toLowerCase()}`, name, price: "", bonusEntries: "", maxSupply: "" }))
};

function NftPreview({ item }: { item: WalletNft }) {
  const [broken, setBroken] = useState(false);
  return item.image && !broken
    ? <img src={item.image} alt="" loading="lazy" decoding="async" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <span className={formStyles.nftPlaceholder} aria-hidden="true">NFT</span>;
}

export type SaveCommitment = (input: { nft: Address; tokenId: string; publicSummary: string; privateCommitment: string }, options?: { assertIntent: () => void; beforeRequest: (identity: Hex) => void }) => Promise<PublicReserve>;

function positiveInteger(value: string, label: string, maximum: number) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} is outside the supported range.`);
  return parsed;
}

function actionFromForm(form: FormDraft): Omit<DraftInput, "reserveNonce" | "reserveCommit"> {
  if (!isAddress(form.nft)) throw new Error("Enter a valid NFT contract address.");
  if (!/^\d{1,78}$/.test(form.tokenId) || BigInt(form.tokenId) >= 2n ** 256n) throw new Error("Enter a valid NFT token ID.");
  const title = form.title.trim();
  if (!title || new TextEncoder().encode(title).length > 80) throw new Error("Title must contain 1–80 UTF-8 bytes.");
  const closeMilliseconds = Date.parse(`${form.closing}Z`);
  if (!Number.isFinite(closeMilliseconds) || closeMilliseconds <= Date.now()) throw new Error("Choose a future closing date.");
  if (form.packs.length < 1 || form.packs.length > 8) throw new Error("Configure 1–8 memberships.");
  return {
    nft: form.nft,
    tokenId: BigInt(form.tokenId),
    title,
    salesEnd: BigInt(Math.floor(closeMilliseconds / 1000)),
    packs: form.packs.map((pack) => {
      const name = pack.name;
      if (!name || new TextEncoder().encode(name).length > 32) throw new Error("Each membership name must contain 1–32 UTF-8 bytes.");
      return { name, priceUsdc: parseUsdc(pack.price), bonusEntries: positiveInteger(pack.bonusEntries, `${name} bonus entries`, 10_000), maxSupply: positiveInteger(pack.maxSupply, `${name} supply`, 4_294_967_295) };
    })
  };
}

function formFromSnapshot(snapshot?: RaffleSnapshot): FormDraft {
  if (!snapshot) return INITIAL;
  return {
    nft: snapshot.raffle.nft,
    tokenId: snapshot.raffle.tokenId.toString(),
    title: snapshot.raffle.title,
    closing: new Date(Number(snapshot.raffle.salesEnd) * 1000).toISOString().slice(0, 16),
    packs: snapshot.packs.map((pack, index) => ({ id: `existing-pack-${index + 1}`, name: pack.name, price: formatUsdcInput(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() }))
  };
}

export function SellerDraftForm({ service, wallet, saveCommitment, existing, onConfirmed }: {
  service: RaffleService;
  wallet: WalletSessionPort;
  saveCommitment: SaveCommitment;
  existing?: RaffleSnapshot;
  onConfirmed?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormDraft>(() => formFromSnapshot(existing));
  const [localDateFormatter, setLocalDateFormatter] = useState<Intl.DateTimeFormat | null>(null);
  const [state, setState] = useState<DraftState>({ kind: "editing" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inventory, setInventory] = useState<InventoryState>({ kind: "idle" });
  const [pendingNft, setPendingNft] = useState<string | null>(null);
  const [selectedNft, setSelectedNft] = useState<WalletNft | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [selectionStatus, setSelectionStatus] = useState("");
  const walletSnapshot = useWalletSnapshot(wallet);
  const [creation, setCreation] = useState<{ kind: "idle" } | { kind: "busy"; message: string } | { kind: "error"; message: string } | { kind: "done"; id: bigint }>({ kind: "idle" });
  const [savedCreation, setSavedCreation] = useState<CreateRecord | null>(null);
  const createLifetime = useRef({ mounted: false, generation: 0, busy: false, operation: 0, service, wallet, revision: walletSnapshot.revision });
  if (createLifetime.current.service !== service || createLifetime.current.wallet !== wallet || createLifetime.current.revision !== walletSnapshot.revision) {
    Object.assign(createLifetime.current, { service, wallet, revision: walletSnapshot.revision, generation: createLifetime.current.generation + 1 });
  }
  useEffect(() => {
    createLifetime.current.mounted = true;
    return () => { createLifetime.current.mounted = false; createLifetime.current.generation++; };
  }, []);
  useEffect(() => {
    if (existing || walletSnapshot.kind !== "connected") return;
    try { setSavedCreation(readCreateRecord(window.localStorage, createStorageKey(service, walletSnapshot.account))); }
    catch { setCreation({ kind: "error", message: "Saved creation could not be read. Recover wallet activity before continuing." }); }
  }, [service, existing, walletSnapshot]);

  const identityLocked = existing?.raffle.escrowed === true;
  const pickerId = useId();
  const formRef = useRef(form);
  const serviceRef = useRef(service);
  const identityLockedRef = useRef(identityLocked);
  identityLockedRef.current = identityLocked;
  const commitmentPreparation = useRef<CommitmentPreparation | null>(null);
  const commitmentInFlight = useRef(false);
  const focusAfterRender = useRef<"edit" | "review" | null>(null);
  const editFocus = useRef<HTMLInputElement>(null);
  const editStage = useRef<HTMLFieldSetElement>(null);
  const reviewFocus = useRef<HTMLHeadingElement>(null);
  const refreshFocus = useRef<HTMLButtonElement>(null);
  const loadMoreFocus = useRef<HTMLButtonElement>(null);
  const inventoryGeneration = useRef(0);
  const inventoryAbort = useRef<AbortController | null>(null);
  const selectionGeneration = useRef(0);
  const nftEditGeneration = useRef(0);
  const titleEditGeneration = useRef(0);
  const autoTitle = useRef<string | null>(null);

  useEffect(() => {
    setLocalDateFormatter(new Intl.DateTimeFormat(undefined, {
      day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short"
    }));
  }, []);

  const closingMilliseconds = Date.parse(`${form.closing}Z`);
  const localDeadline = localDateFormatter && Number.isFinite(closingMilliseconds)
    ? <time className={formStyles.localDeadline} dateTime={new Date(closingMilliseconds).toISOString()}>({localDateFormatter.format(closingMilliseconds)} your time)</time>
    : null;

  function replaceForm(update: (current: FormDraft) => FormDraft) {
    createLifetime.current.generation++;
    const next = update(formRef.current);
    formRef.current = next;
    setForm(next);
  }

  function invalidateInventory() {
    inventoryGeneration.current += 1;
    inventoryAbort.current?.abort();
    inventoryAbort.current = null;
  }

  function invalidateSelection() {
    selectionGeneration.current += 1;
    setPendingNft(null);
    setSelectionStatus("");
  }

  useEffect(() => {
    const stage = focusAfterRender.current;
    const target = stage === "review" ? reviewFocus.current : stage === "edit" ? editFocus.current : null;
    if (!target) return;
    const scrollTarget = stage === "edit" ? editStage.current : target;
    if (!scrollTarget) return;
    focusAfterRender.current = null;
    const frame = requestAnimationFrame(() => {
      scrollTarget.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.kind]);

  useEffect(() => {
    serviceRef.current = service;
    invalidateInventory();
    invalidateSelection();
    setPickerOpen(false);
    setInventory({ kind: "idle" });
    setSelectedNft(null);
    setSelectionError("");
    setSelectionStatus("");
    return () => {
      invalidateInventory();
      selectionGeneration.current += 1;
    };
    // Account, network and revision form one wallet epoch. Any change clears inventory and selection.
  }, [service, walletSnapshot.kind, walletSnapshot.kind === "connected" ? walletSnapshot.account : "", walletSnapshot.kind === "connected" ? walletSnapshot.chainId : 0, walletSnapshot.revision]);

  useEffect(() => {
    invalidateSelection();
    if (identityLocked) {
      invalidateInventory();
      setPickerOpen(false);
      setInventory({ kind: "idle" });
      setSelectedNft(null);
      setSelectionError("");
      setSelectionStatus("");
    }
  }, [identityLocked, existing?.raffle.nft, existing?.raffle.tokenId]);

  function update<K extends keyof Omit<FormDraft, "packs">>(key: K, value: FormDraft[K]) {
    if (key === "nft" || key === "tokenId") {
      nftEditGeneration.current += 1;
      invalidateSelection();
      setSelectedNft(null);
      setSelectionError("");
      setSelectionStatus("");
      const trackedAutomaticTitle = autoTitle.current;
      autoTitle.current = null;
      replaceForm((current) => {
        const staleAutoTitle = trackedAutomaticTitle !== null && current.title === trackedAutomaticTitle;
        return { ...current, [key]: value, ...(staleAutoTitle ? { title: "" } : {}) };
      });
    } else {
      if (key === "title") { autoTitle.current = null; titleEditGeneration.current += 1; }
      replaceForm((current) => ({ ...current, [key]: value }));
    }
    setState({ kind: "editing" });
  }

  function updatePack(id: string, key: PackEconomicsKey, value: string) {
    replaceForm((current) => ({ ...current, packs: current.packs.map((pack) => pack.id === id ? { ...pack, [key]: value } : pack) }));
    setState({ kind: "editing" });
  }

  async function loadInventory(cursor?: string) {
    const snapshot = wallet.getSnapshot();
    if (snapshot.kind !== "connected" || snapshot.chainId !== 11155111 || service.manifest.chainId !== 11155111) {
      setInventory({ kind: "error", items: [], message: "Automatic NFT discovery is available for a connected Ethereum Sepolia wallet. You can still enter the NFT manually." });
      return;
    }
    const version = ++inventoryGeneration.current;
    inventoryAbort.current?.abort();
    const controller = new AbortController();
    inventoryAbort.current = controller;
    const append = cursor !== undefined;
    const previous = append && (inventory.kind === "ready" || inventory.kind === "loading" || inventory.kind === "error") ? inventory.items : [];
    const priorRequested = append && (inventory.kind === "ready" || inventory.kind === "loading") ? inventory.requestedCursors : [];
    setSelectionError("");
    setInventory({ kind: "loading", items: previous, nextCursor: append ? cursor ?? null : null, requestedCursors: priorRequested, append });
    try {
      const page = await fetchWalletNfts({ owner: snapshot.account, ...(cursor === undefined ? {} : { cursor }), signal: controller.signal });
      await wallet.assertCurrent(snapshot);
      if (version !== inventoryGeneration.current || serviceRef.current !== service || !pickerOpen && cursor !== undefined) return;
      const requestedCursors = cursor === undefined ? [] : [...priorRequested, cursor];
      const merged = mergeWalletNftItems({ current: previous, incoming: page.items, append });
      const repeated = page.nextCursor !== null && (page.nextCursor === cursor || requestedCursors.includes(page.nextCursor));
      const capped = merged.capped || merged.items.length >= 240 && page.nextCursor !== null;
      const message = capped
        ? "The display limit of 240 NFTs was reached. Enter another NFT manually if it is not shown."
        : repeated
          ? "Inventory pagination stopped because the provider repeated a cursor. Manual entry remains available."
          : merged.items.length === 0 && page.nextCursor === null
            ? "No supported ERC-721 NFTs were found on this page. Manual entry remains available."
            : "Wallet inventory is point-in-time information. LABx approval still requires a separate human review.";
      const nextCursor = capped || repeated ? null : page.nextCursor;
      if (append && nextCursor === null && loadMoreFocus.current === document.activeElement) refreshFocus.current?.focus();
      setInventory({ kind: "ready", items: merged.items, nextCursor, requestedCursors, message });
    } catch {
      if (controller.signal.aborted || version !== inventoryGeneration.current) return;
      if (append && loadMoreFocus.current === document.activeElement) refreshFocus.current?.focus();
      setInventory({ kind: "error", items: previous, message: "Wallet NFT inventory is unavailable. Enter the NFT manually or try again." });
    } finally {
      if (version === inventoryGeneration.current) inventoryAbort.current = null;
    }
  }

  function openPicker() {
    if (identityLockedRef.current) return;
    setPickerOpen(true);
    setInventory({ kind: "idle" });
    setSelectionError("");
    setSelectionStatus("");
    void loadInventory();
  }

  function closePicker() {
    invalidateInventory();
    invalidateSelection();
    setPickerOpen(false);
    setInventory({ kind: "idle" });
    setSelectionError("");
    setSelectionStatus("");
  }

  async function chooseNft(item: WalletNft) {
    if (identityLockedRef.current) return;
    const snapshot = wallet.getSnapshot();
    if (snapshot.kind !== "connected" || snapshot.chainId !== service.manifest.chainId || snapshot.chainId !== 11155111) {
      setSelectionError("Reconnect the same Ethereum Sepolia wallet before selecting an NFT.");
      return;
    }
    const version = ++selectionGeneration.current;
    const fieldVersion = nftEditGeneration.current;
    const titleVersion = titleEditGeneration.current;
    const key = `${item.contract.toLowerCase()}:${item.tokenId}`;
    setPendingNft(key);
    setSelectionError("");
    setSelectionStatus(`Verifying ownership of ${nftTitle(item)}…`);
    try {
      await wallet.assertCurrent(snapshot);
      const ownership = await service.readNftOwner({ nft: item.contract, tokenId: BigInt(item.tokenId) });
      const ownerMismatch = ownership.owner.toLowerCase() !== snapshot.account.toLowerCase();
      if (ownerMismatch) throw new Error("owner-mismatch");
      await wallet.assertCurrent(snapshot);
      if (!canApplyWalletNftSelection({
        capturedSelectionGeneration: version,
        currentSelectionGeneration: selectionGeneration.current,
        capturedNftEditGeneration: fieldVersion,
        currentNftEditGeneration: nftEditGeneration.current,
        sameService: serviceRef.current === service,
        identityLocked: identityLockedRef.current
      })) return;
      const generatedTitle = nftTitle(item);
      const currentForm = formRef.current;
      const mayAutofill = shouldAutofillWalletNftTitle({ currentTitle: currentForm.title, trackedAutomaticTitle: autoTitle.current, titleUnchanged: titleVersion === titleEditGeneration.current });
      if (mayAutofill) autoTitle.current = generatedTitle;
      replaceForm((current) => {
        return { ...current, nft: item.contract, tokenId: item.tokenId, title: mayAutofill ? generatedTitle : current.title };
      });
      setSelectedNft(item);
      setSelectionStatus(`Selected ${generatedTitle}. NFT contract and token ID updated.`);
      setState({ kind: "editing" });
    } catch (error) {
      if (version === selectionGeneration.current) {
        setSelectionStatus("");
        setSelectionError(error instanceof Error && error.message === "owner-mismatch"
          ? "This wallet no longer owns that NFT. Refresh the inventory or enter another NFT manually."
          : "NFT ownership could not be verified for the current wallet and network. Enter the NFT manually or try again.");
      }
    } finally {
      if (version === selectionGeneration.current) setPendingNft(null);
    }
  }

  async function create(event?: FormEvent, recoveryHash?: Hex) {
    event?.preventDefault();
    const lifetime = createLifetime.current;
    if (lifetime.busy) return;
    lifetime.busy = true;
    const operation = ++lifetime.operation;
    const generation = lifetime.generation;
    const session = wallet.getSnapshot();
    const assertIntent = () => {
      if (!lifetime.mounted || lifetime.generation !== generation || wallet.getSnapshot().revision !== session.revision) throw new Error("This creation intent is no longer active. Click Create again to resume.");
    };
    const status = (message: string) => { assertIntent(); setCreation({ kind: "busy", message }); };
    try {
      if (session.kind !== "connected" || session.chainId !== service.manifest.chainId) throw new Error("Connect the seller wallet on the configured network.");
      if (!navigator.locks) throw new Error("Creation recovery requires a browser with secure Web Locks.");
      const key = createStorageKey(service, session.account);
      const clicked = captureCreateGeneration(localStorage, key);
      await navigator.locks.request(key, async () => {
        assertIntent();
        assertCreateGeneration(localStorage, key, clicked);
        let record = readCreateRecord(localStorage, key);
        const persist = (next: CreateRecord) => { writeCreateRecord(localStorage, key, next); record = next; if (lifetime.mounted && lifetime.generation === generation && wallet.getSnapshot().revision === session.revision) setSavedCreation(next); };
        if (record?.kind === "preparing" && record.requestIdentity === null) { localStorage.removeItem(key); record = null; }
        if (!record) {
          if (await service.pending({ wallet })) throw new Error("Recover the unresolved wallet transaction before creating.");
          assertIntent();
          if (recoveryHash) throw new Error("There is no saved creation transaction to recover.");
          advanceCreateGeneration(localStorage, key);
          const action = actionFromForm(formRef.current);
          const input = prepareAutomaticCommitment(action.nft, action.tokenId).input;
          const data = encodeDraft({ ...action, reserveNonce: zeroHash, reserveCommit: zeroHash });
          persist({ kind: "preparing", data, requestIdentity: null });
          status("Sign to securely save the draw setup…");
          try {
            const reserve = await saveCommitment({ nft: action.nft, tokenId: action.tokenId.toString(), ...input }, {
              assertIntent,
              beforeRequest: requestIdentity => { assertIntent(); persist({ kind: "preparing", data, requestIdentity }); }
            });
            if (reserve.nft.toLowerCase() !== action.nft.toLowerCase() || reserve.tokenId !== action.tokenId.toString() || reserve.seller.toLowerCase() !== session.account.toLowerCase() || reserve.labx.toLowerCase() !== service.manifest.address.toLowerCase() || reserve.chainId !== String(service.manifest.chainId) || reserve.publicSummary !== input.publicSummary) throw new Error("Saved draw setup differs from this NFT or seller.");
            persist({ kind: "draft", data: encodeDraft({ ...action, reserveNonce: reserve.nonce, reserveCommit: reserve.commit }), creationHash: null, id: null, pending: null });
          } catch (error) {
            if (error instanceof PreparationNotDispatchedError || isWalletRequestRejected(error)) { localStorage.removeItem(key); setSavedCreation(null); }
            if (isWalletRequestRejected(error)) throw error;
            throw new Error("The draw setup could not be prepared or saved. Click Create to recover the saved preparation.");
          }
        } else if (record.kind === "preparing") {
          if (record.requestIdentity === null) throw new Error("Preparation identity is unavailable.");
          const draft = decodeDraft(record.data);
          status("Recovering the saved draw setup…");
          const reserve = await recoverPreparation(wallet, { requestIdentity: record.requestIdentity, nft: draft.nft, tokenId: draft.tokenId.toString() }, assertIntent);
          persist({ kind: "draft", data: encodeDraft({ ...draft, reserveNonce: reserve.nonce, reserveCommit: reserve.commit }), creationHash: null, id: null, pending: null });
        }
        const saved = readCreateRecord(localStorage, key);
        if (saved?.kind !== "draft") throw new Error("Draw setup recovery is incomplete.");
        if (recoveryHash) {
          status("Checking the saved creation transaction…");
          await recoverCreateTransaction({ service, wallet, record: saved, save: persist, assertIntent, hash: recoveryHash });
          assertIntent(); setCreation({ kind: "idle" }); return;
        }
        const result = await finishCreate({ service, wallet, draft: decodeDraft(saved.data), record: saved, save: persist, assertIntent, onStep: status });
        assertIntent();
        const completed = readCreateRecord(localStorage, key);
        if (completed?.kind !== "draft" || completed.id !== result.id.toString() || completed.pending !== null || completed.data !== saved.data) throw new Error("Creation recovery changed before completion.");
        assertIntent();
        retireCompletedCreate(localStorage, key, completed, result.id);
        setSavedCreation(null);
        setCreation({ kind: "done", id: result.id });
        await onConfirmed?.();
        assertIntent();
        router.push(`/seller/${result.id.toString()}`);
      });
    } catch (error) {
      if (lifetime.mounted && lifetime.generation === generation) setCreation({ kind: "error", message: isWalletRequestRejected(error) ? "The wallet request was cancelled. Click Create to resume when ready." : error instanceof Error ? error.message : "Creation stopped. Recover the saved stage before trying again." });
    } finally {
      if (lifetime.operation === operation) {
        lifetime.busy = false;
        if (lifetime.mounted && lifetime.generation !== generation) setCreation(current => current.kind === "busy" ? { kind: "error", message: "The creation details changed. Click Create to resume the saved stage." } : current);
      }
    }
  }

  async function editSavedCreation() {
    const lifetime = createLifetime.current;
    if (lifetime.busy || !savedCreation) return;
    const expected = savedCreation, session = wallet.getSnapshot(), generation = lifetime.generation;
    if (session.kind !== "connected") return;
    lifetime.busy = true;
    const operation = ++lifetime.operation;
    const assertIntent = () => { if (!lifetime.mounted || lifetime.generation !== generation || wallet.getSnapshot().revision !== session.revision) throw new Error("This creation is no longer active."); };
    setCreation({ kind: "busy", message: "Checking saved creation recovery…" });
    try {
      if (!navigator.locks) throw new Error("Creation recovery requires secure Web Locks.");
      const key = createStorageKey(service, session.account);
      const clicked = captureCreateGeneration(localStorage, key);
      await navigator.locks.request(key, async () => {
        assertCreateGeneration(localStorage, key, clicked);
        await retireUnsentCreate({ service, wallet, storage: localStorage, key, expected, assertIntent });
        assertIntent();
        const draft = decodeDraft(expected.data);
        invalidateSelection(); invalidateInventory();
        replaceForm(() => ({ nft: draft.nft, tokenId: draft.tokenId.toString(), title: draft.title, closing: new Date(Number(draft.salesEnd) * 1000).toISOString().slice(0, 16), packs: draft.packs.map((pack, index) => ({ id: `recovered-${index}`, name: pack.name, price: formatUsdcInput(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() })) }));
        setSavedCreation(null); setCreation({ kind: "idle" }); setState({ kind: "editing" });
      });
    } catch (error) {
      if (lifetime.mounted && lifetime.generation === generation) setCreation({ kind: "error", message: error instanceof Error ? error.message : "Saved creation could not be retired." });
    } finally {
      if (lifetime.operation === operation) {
        lifetime.busy = false;
        if (lifetime.mounted && lifetime.generation !== generation) setCreation(current => current.kind === "busy" ? { kind: "error", message: "The wallet or creation details changed. Review the saved creation before trying again." } : current);
      }
    }
  }

  function review(event: FormEvent) {
    event.preventDefault();
    invalidateSelection();
    invalidateInventory();
    setPickerOpen(false);
    setInventory({ kind: "idle" });
    setSelectionError("");
    setSelectionStatus("");
    try {
      const action = actionFromForm(form);
      const key = automaticCommitmentKey(action.nft, action.tokenId);
      focusAfterRender.current = "review";
      if (existing && key === automaticCommitmentKey(existing.raffle.nft, existing.raffle.tokenId)) {
        setState({ kind: "retained", action: { ...action, reserveNonce: existing.raffle.reserveNonce, reserveCommit: existing.raffle.reserveCommit } });
        return;
      }
      let preparation = commitmentPreparation.current;
      if (!preparation || preparation.key !== key) {
        const generated = prepareAutomaticCommitment(action.nft, action.tokenId);
        preparation = generated;
        commitmentPreparation.current = preparation;
      }
      setState({ kind: "review", action });
    }
    catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "Draft details are invalid." }); }
  }

  async function commit(action: Omit<DraftInput, "reserveNonce" | "reserveCommit">) {
    if (commitmentInFlight.current) return;
    commitmentInFlight.current = true;
    setState({ kind: "saving", action });
    try {
      const key = automaticCommitmentKey(action.nft, action.tokenId);
      const preparation = commitmentPreparation.current;
      if (!preparation || preparation.key !== key) throw new Error("The prepared draw setup no longer matches this NFT.");
      const reserve = await saveCommitment({ nft: action.nft, tokenId: action.tokenId.toString(), ...preparation.input });
      if (reserve.nft.toLowerCase() !== action.nft.toLowerCase() || reserve.tokenId !== action.tokenId.toString() || reserve.publicSummary !== preparation.input.publicSummary) throw new Error("Saved commitment does not match this NFT.");
      commitmentPreparation.current = null;
      setState({ kind: "committed", action, reserve });
    } catch (error) {
      setState({ kind: "error", message: isWalletRequestRejected(error)
        ? "The wallet request was cancelled. No draft transaction was submitted. You can try again."
        : "The draw setup could not be prepared or saved. No draft transaction was submitted. Try again." });
    } finally {
      commitmentInFlight.current = false;
    }
  }

  function returnToEdit() {
    invalidateSelection();
    focusAfterRender.current = "edit";
    setState({ kind: "editing" });
  }

  if (!existing && (savedCreation !== null || creation.kind === "busy" || creation.kind === "done")) return <section className="stack" aria-live="polite"><h2>{creation.kind === "done" ? "Raffle created" : "Create your raffle"}</h2><p>The draw setup, draft and NFT custody are separate steps. Confirm each requested action in your wallet.</p>{creation.kind === "done" ? <p>Opening your raffle…</p> : <><p role={creation.kind === "error" ? "alert" : "status"}>{creation.kind === "busy" || creation.kind === "error" ? creation.message : "Your saved creation is ready to resume. Nothing is sent until you click Create."}</p><button className="btn" type="button" disabled={creation.kind === "busy"} onClick={() => void create()}>{creation.kind === "busy" ? "Creating…" : "Create"}</button>{savedCreation ? <CreateRecoveryControls disabled={creation.kind === "busy"} onRecover={savedCreation.kind === "draft" && savedCreation.pending ? hash => void create(undefined, hash) : undefined} onEdit={savedCreation.kind === "preparing" || savedCreation.id === null && savedCreation.creationHash === null && savedCreation.pending === null ? () => void editSavedCreation() : undefined} /> : null}</>}</section>;

  if (state.kind === "retained" && existing) return <div className={`${formStyles.review} studio-review stack`}><h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>Prepare raffle draft</h2><p className="notice">The saved draw setup for this NFT will be retained. No additional storage signature is needed.</p><p className="notice warning" role="status">Any successful draft update advances the review revision. LABx must approve the edited draft again before it can open, even if you later restore the old values.</p><dl className="review-list"><div><dt>Title</dt><dd>{state.action.title}</dd></div><div><dt>Deadline</dt><dd>{formatDate(state.action.salesEnd)} UTC{localDeadline}</dd></div>{state.action.packs.map((pack, index) => <div key={index}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl><TransactionFlow service={service} wallet={wallet} action={{ kind: "updateDraft", id: existing.id, draft: state.action }} label="Update raffle draft" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /><button className="btn btn-dark" type="button" onClick={returnToEdit}>Edit draft</button></div>;

  if (state.kind === "review" || state.kind === "saving" || state.kind === "committed") {
    const { action } = state;
    return (
      <div className={`${formStyles.review} studio-review stack`}>
        <h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>Prepare raffle draft</h2>
        <p className="notice warning" role="status">Check these raffle details. The next step asks your wallet to sign a request that saves the draw setup securely. This signature does not submit a transaction. Opening later fixes the economics and deadline.{existing ? " A successful edit requires fresh LABx approval before the raffle can open." : ""}</p>
        <dl className="review-list"><div><dt>Title</dt><dd>{action.title}</dd></div><div><dt>NFT</dt><dd>{shortAddress(action.nft)} · token #{action.tokenId.toString()}</dd></div><div><dt>Sales deadline</dt><dd>{formatDate(action.salesEnd)} UTC{localDeadline}</dd></div><div><dt>Memberships</dt><dd>{action.packs.length}</dd></div>{action.packs.map((pack, index) => <div key={`${index}-${pack.name}`}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl>
        {state.kind === "committed" ? (
          <>
            <div className="notice ok stack" role="status"><strong>Draw setup saved</strong><span>The setup is saved securely. Create or update the draft transaction next. You can recover the setup with your wallet when it is time to reveal.</span></div>
            <TransactionFlow prepareOnMount={!existing} service={service} wallet={wallet} action={existing ? { kind: "updateDraft", id: existing.id, draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } } : { kind: "createDraft", draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } }} label={existing ? "Update raffle draft" : "Create raffle draft"} formatUsdc={formatUsdc} onConfirmed={onConfirmed} />
          </>
        ) : <button className="btn" type="button" disabled={state.kind === "saving"} onClick={() => void commit(action)}>{state.kind === "saving" ? "Preparing raffle…" : "Sign to prepare raffle"}</button>}
        <button className="btn btn-dark" type="button" disabled={state.kind === "saving"} onClick={returnToEdit}>Edit draft</button>
      </div>
    );
  }

  const inventoryBusy = inventory.kind === "loading";
  const inventoryStatus = inventory.kind === "loading"
    ? "Loading wallet NFTs…"
    : inventory.kind === "ready"
      ? inventory.message
      : "";
  const loadMoreCursor = inventory.kind === "ready"
    ? inventory.nextCursor
    : inventory.kind === "loading" && inventory.append
      ? inventory.nextCursor
      : null;

  return (
    <form className={`${formStyles.form} studio-form`} onSubmit={existing ? review : event => void create(event)}>
      <p className={`${formStyles.privacyNotice} notice warning`}>{existing ? "Editing this draft requires LABx approval again before listing. An unchanged NFT keeps its saved draw setup." : "Create locks your NFT. After LABx approves the raffle, press List to open sales."}</p>

      <fieldset className={formStyles.formSection} ref={editStage}>
        <legend><span>01</span> Raffle details</legend>
        <p className={formStyles.sectionHelp}>Name the public raffle and choose when membership sales close.</p>
        <div className={`${formStyles.fieldGrid} ${formStyles.detailsGrid}`}>
          <label htmlFor="draft-title">Raffle title<input ref={editFocus} id="draft-title" value={form.title} onChange={(event) => update("title", event.target.value)} required /></label>
          <div className={formStyles.describedField}><label htmlFor="draft-close">Sales deadline in UTC<input id="draft-close" type="datetime-local" value={form.closing} onChange={(event) => update("closing", event.target.value)} aria-describedby="deadline-note" required /></label><small id="deadline-note">Enter the deadline as UTC, not local time.{localDeadline}</small></div>
        </div>
      </fieldset>

      <fieldset className={formStyles.formSection}>
        <legend><span>02</span> Prize NFT</legend>
        <div className={formStyles.nftIntro}><p className={formStyles.sectionHelp}>Choose a supported ERC-721 from the connected Sepolia wallet, or identify the exact collection contract and token manually.</p>{!identityLocked ? <button className="btn btn-dark" type="button" aria-controls={pickerId} aria-expanded={pickerOpen} disabled={walletSnapshot.kind !== "connected" || walletSnapshot.chainId !== 11155111 || service.manifest.chainId !== 11155111} onClick={pickerOpen ? closePicker : openPicker}>{pickerOpen ? "Close wallet NFTs" : "Choose from wallet"}</button> : null}</div>
        {service.manifest.chainId !== 11155111 ? <p className={formStyles.inventoryNote}>Automatic NFT discovery is disabled for isolated local-chain fixtures. Manual entry remains available.</p> : null}
        {pickerOpen ? <div id={pickerId} className={formStyles.picker} role="region" aria-label="Wallet NFTs" aria-busy={inventoryBusy || pendingNft !== null}>
          <div className={formStyles.pickerHeading}><div><strong>Connected wallet NFTs</strong><span>These results show reported wallet holdings. Selection does not approve the NFT for LABx, prove provenance, or sign a transaction.</span></div><button ref={refreshFocus} className={`btn btn-dark ${formStyles.refreshButton}`} type="button" aria-disabled={inventoryBusy} aria-busy={inventoryBusy} onClick={() => { if (inventoryBusy) return; invalidateInventory(); setInventory({ kind: "idle" }); setSelectionError(""); void loadInventory(); }}>Refresh</button></div>
          <p className={formStyles.inventoryNote} role="status" aria-live="polite" aria-atomic="true">{inventoryStatus}</p>
          {inventory.kind !== "idle" && inventory.items.length > 0 ? <ul className={formStyles.nftGallery}>{inventory.items.map((item) => {
            const key = `${item.contract.toLowerCase()}:${item.tokenId}`;
            const pending = pendingNft === key;
            const selected = selectedNft?.contract.toLowerCase() === item.contract.toLowerCase() && selectedNft.tokenId === item.tokenId;
            const label = `${item.name || item.collection || "NFT"}, contract ${item.contract}, token ${item.tokenId}`;
            const accessibleLabel = pending ? `Verifying ownership for ${label}` : selected ? `Selected ${label}` : `Select ${label}. Verify and use.`;
            return <li key={key}><button type="button" className={formStyles.nftCard} data-selected={selected} aria-disabled={pending} aria-busy={pending} aria-label={accessibleLabel} onClick={() => { if (!pending) void chooseNft(item); }}><NftPreview item={item} /><span><strong>{item.name || item.collection || `NFT #${item.tokenId}`}</strong><small>{shortAddress(item.contract)} · token #{item.tokenId}</small><em>{pending ? "Verifying ownership…" : selected ? "Selected" : "Verify and use"}</em></span></button></li>;
          })}</ul> : null}
          {inventory.kind === "error" ? <p className="notice warning" role="alert">{inventory.message}</p> : null}
          <p className={formStyles.inventoryNote} role="status" aria-live="polite" aria-atomic="true">{selectionStatus}</p>
          {selectionError ? <p className="notice warning" role="alert">{selectionError}</p> : null}
          {loadMoreCursor !== null ? <button ref={loadMoreFocus} className="btn btn-dark" type="button" aria-disabled={inventoryBusy} aria-busy={inventoryBusy} onClick={() => { if (!inventoryBusy) void loadInventory(loadMoreCursor); }}>Load more wallet NFTs</button> : null}
        </div> : null}
        <div className={`${formStyles.fieldGrid} ${formStyles.nftGrid}`}>
          <label htmlFor="draft-nft">NFT contract<input id="draft-nft" spellCheck={false} autoCapitalize="none" autoCorrect="off" value={form.nft} disabled={existing?.raffle.escrowed} onChange={(event) => update("nft", event.target.value.trim())} required /></label>
          <label htmlFor="draft-token">Token ID<input id="draft-token" inputMode="numeric" value={form.tokenId} disabled={existing?.raffle.escrowed} onChange={(event) => update("tokenId", event.target.value.trim())} required /></label>
        </div>
      </fieldset>

      <fieldset className={`${formStyles.formSection} ${formStyles.packSection}`}>
        <legend><span>03</span> Membership packs</legend>
        <div className={formStyles.sectionIntro}><p className={formStyles.sectionHelp}>{existing ? "This raffle keeps its existing membership names and order. Edit the price, bonus entries and supply for each pack; no pack is added or removed." : "Every new raffle uses the five standard tiers. Set the price, bonus entries and supply for each tier."}</p><span>{existing ? `${form.packs.length} existing membership${form.packs.length === 1 ? "" : "s"}` : "5 standard tiers"}</span></div>
        <div className={formStyles.packList}>{form.packs.map((pack, index) => <fieldset className={formStyles.packCard} key={pack.id} aria-label={`Membership ${index + 1}: ${pack.name}`}><legend><span>Membership {index + 1}</span><strong>{pack.name}</strong></legend><div className={formStyles.packFields}><label>Price in USDC<input inputMode="decimal" value={pack.price} onChange={(event) => updatePack(pack.id, "price", event.target.value)} required /></label><label>Bonus entries<input inputMode="numeric" value={pack.bonusEntries} onChange={(event) => updatePack(pack.id, "bonusEntries", event.target.value)} required /></label><label>Supply<input inputMode="numeric" value={pack.maxSupply} onChange={(event) => updatePack(pack.id, "maxSupply", event.target.value)} required /></label></div></fieldset>)}</div>
      </fieldset>

      {!existing && creation.kind === "error" ? <p className="notice error" role="alert">{creation.message}</p> : null}
      {state.kind === "error" ? <p className={`${formStyles.formError} notice error`} role="alert">{state.message}</p> : null}
      <div className={formStyles.reviewAction}><div><strong>{existing ? "Ready to save your changes?" : "Ready to create?"}</strong><span>{existing ? "You will review the details. An unchanged NFT needs no new storage signature; a changed NFT does." : "Follow the prompts in your wallet. Creating needs a signature and separate transaction confirmations."}</span></div><button className="btn" type="submit">{existing ? "Prepare raffle draft" : "Create"}</button></div>
    </form>
  );
}
