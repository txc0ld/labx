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
import { STANDARD_MEMBERSHIP_TIERS, type MembershipTierName } from "@/lib/membership-tiers";
import { canApplyWalletNftSelection, fetchWalletNfts, mergeWalletNftItems, nftTitle, shouldAutofillWalletNftTitle, type WalletNft } from "@/lib/wallet-nfts";
import { captureCreateGeneration, assertCreateGeneration, advanceCreateGeneration, retireUnsentCreate, recoverCreateTransaction, createStorageKey, decodeDraft, encodeDraft, finishCreate, readCreateRecord, serializeCreateRecord, writeCreateRecord, retireCompletedCreate, type CreateRecord } from "@/lib/chain/create-flow";
import { recoverPreparation } from "@/lib/chain/api";
import { CreateRecoveryControls } from "./CreateRecoveryControls";
import { TransactionFlow } from "./TransactionFlow";
import { CREATE_STEPS, createStepMessage } from "./create-progress";
import { localDeadlineInput, localDeadlineSeconds } from "./deadline";
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

/** Editable starting values for each standard tier. Prices stay blank for the seller to set. */
const SUGGESTED_TIER_ECONOMICS: Record<MembershipTierName, Pick<PackDraft, "bonusEntries" | "maxSupply">> = {
  Entry: { bonusEntries: "1", maxSupply: "100" },
  Bronze: { bonusEntries: "3", maxSupply: "50" },
  Silver: { bonusEntries: "5", maxSupply: "25" },
  Gold: { bonusEntries: "10", maxSupply: "10" },
  Platinum: { bonusEntries: "25", maxSupply: "5" }
};

const INITIAL: FormDraft = {
  nft: "",
  tokenId: "",
  title: "",
  closing: "",
  packs: STANDARD_MEMBERSHIP_TIERS.map((name) => ({ id: `standard-${name.toLowerCase()}`, name, price: "", ...SUGGESTED_TIER_ECONOMICS[name] }))
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
  if (!form.nft && !form.tokenId) throw new Error("Choose the NFT for this raffle.");
  if (!isAddress(form.nft)) throw new Error("Enter a valid NFT contract address.");
  if (!/^\d{1,78}$/.test(form.tokenId) || BigInt(form.tokenId) >= 2n ** 256n) throw new Error("Enter a valid NFT token ID.");
  const title = form.title.trim();
  if (!title) throw new Error("Enter a title.");
  if (new TextEncoder().encode(title).length > 80) throw new Error("Title is too long (80 characters max).");
  const closeSeconds = localDeadlineSeconds(form.closing);
  if (closeSeconds === null) throw new Error(form.closing ? DEADLINE_SKIPPED : "Choose when sales end.");
  if (closeSeconds * 1000 <= Date.now()) throw new Error("Choose a future closing date.");
  if (form.packs.length < 1 || form.packs.length > 8) throw new Error("Configure 1–8 memberships.");
  return {
    nft: form.nft,
    tokenId: BigInt(form.tokenId),
    title,
    salesEnd: BigInt(closeSeconds),
    packs: form.packs.map((pack) => {
      const name = pack.name;
      if (!name || new TextEncoder().encode(name).length > 32) throw new Error("Each membership name must contain 1–32 UTF-8 bytes.");
      return { name, priceUsdc: parseUsdc(pack.price), bonusEntries: positiveInteger(pack.bonusEntries, `${name} bonus entries`, 10_000), maxSupply: positiveInteger(pack.maxSupply, `${name} supply`, 4_294_967_295) };
    })
  };
}

const UNSUPPORTED_BROWSER = "This browser isn't supported. Try a current Chrome, Safari or Firefox.";
const DEADLINE_SKIPPED = "That time doesn't exist in your time zone because of a clock change. Choose another time.";

function formFromSnapshot(snapshot?: RaffleSnapshot): FormDraft {
  if (!snapshot) return INITIAL;
  return {
    nft: snapshot.raffle.nft,
    tokenId: snapshot.raffle.tokenId.toString(),
    title: snapshot.raffle.title,
    closing: localDeadlineInput(snapshot.raffle.salesEnd),
    packs: snapshot.packs.map((pack, index) => ({ id: `existing-pack-${index + 1}`, name: pack.name, price: formatUsdcInput(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() }))
  };
}

export function SellerDraftForm({ service, wallet, saveCommitment, existing, onConfirmed, onCreatingChange }: {
  service: RaffleService;
  wallet: WalletSessionPort;
  saveCommitment: SaveCommitment;
  existing?: RaffleSnapshot;
  onConfirmed?: () => void | Promise<void>;
  /** Reports whether a Create activation is running or has just finished. */
  onCreatingChange?: (creating: boolean) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormDraft>(() => formFromSnapshot(existing));
  const [localDateFormatter, setLocalDateFormatter] = useState<Intl.DateTimeFormat | null>(null);
  const [state, setState] = useState<DraftState>({ kind: "editing" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
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
  const walletPickerReady = walletSnapshot.kind === "connected" && walletSnapshot.chainId === 11155111 && service.manifest.chainId === 11155111;
  // A new raffle starts on the wallet gallery; drafts keep their entered NFT and offer the gallery on request.
  const galleryFirst = !existing && walletPickerReady;
  const galleryOpen = galleryFirst || pickerOpen;
  const pickerId = useId();
  const manualId = useId();
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
  const progressHeading = useRef<HTMLHeadingElement>(null);
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

  const closingSeconds = localDeadlineSeconds(form.closing);
  const deadlineNote = !form.closing ? "" : closingSeconds === null ? DEADLINE_SKIPPED : `(${formatDate(BigInt(closingSeconds))} UTC)`;
  const deadline = (salesEnd: bigint) => {
    const milliseconds = Number(salesEnd) * 1000;
    return <>{localDateFormatter ? <><time dateTime={new Date(milliseconds).toISOString()}>{localDateFormatter.format(milliseconds)}</time> </> : null}({formatDate(salesEnd)} UTC)</>;
  };

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

  useEffect(() => {
    // The wallet-epoch reset above returns the gallery to idle; a new raffle reloads it for the current wallet.
    if (galleryFirst && inventory.kind === "idle") void loadInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryFirst, inventory.kind]);

  const creating = creation.kind === "busy" || creation.kind === "done";
  useEffect(() => { onCreatingChange?.(creating); }, [creating, onCreatingChange]);

  useEffect(() => {
    // Keep the wallet step in view: the long form collapses into this short status while Create runs.
    if (creation.kind !== "busy" || existing) return;
    progressHeading.current?.focus({ preventScroll: true });
    progressHeading.current?.scrollIntoView({ block: "center" });
  }, [creation.kind, existing]);

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
      if (version !== inventoryGeneration.current || serviceRef.current !== service || !galleryOpen && cursor !== undefined) return;
      const requestedCursors = cursor === undefined ? [] : [...priorRequested, cursor];
      const merged = mergeWalletNftItems({ current: previous, incoming: page.items, append });
      const repeated = page.nextCursor !== null && (page.nextCursor === cursor || requestedCursors.includes(page.nextCursor));
      const capped = merged.capped || merged.items.length >= 240 && page.nextCursor !== null;
      const message = capped
        ? "Showing the first 240 NFTs. Enter the contract and token ID for another one."
        : repeated
          ? "More NFTs couldn't be loaded. Enter the contract and token ID instead."
          : merged.items.length === 0 && page.nextCursor === null
            ? "No NFTs found in this wallet. Enter the contract and token ID instead."
            : "";
      const nextCursor = capped || repeated ? null : page.nextCursor;
      if (append && nextCursor === null && loadMoreFocus.current === document.activeElement) refreshFocus.current?.focus();
      setInventory({ kind: "ready", items: merged.items, nextCursor, requestedCursors, message });
    } catch {
      if (controller.signal.aborted || version !== inventoryGeneration.current) return;
      if (append && loadMoreFocus.current === document.activeElement) refreshFocus.current?.focus();
      setInventory({ kind: "error", items: previous, message: "Your NFTs couldn't be loaded. Press Refresh, or enter the contract and token ID." });
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
      setSelectionStatus(`Selected ${generatedTitle}.`);
      setState({ kind: "editing" });
    } catch (error) {
      if (version === selectionGeneration.current) {
        setSelectionStatus("");
        setSelectionError(error instanceof Error && error.message === "owner-mismatch"
          ? "This wallet no longer owns that NFT. Press Refresh or choose another."
          : "Couldn't check that this wallet owns the NFT. Try again, or enter the contract and token ID.");
      }
    } finally {
      if (version === selectionGeneration.current) setPendingNft(null);
    }
  }

  async function create(event?: FormEvent, recoveryHash?: Hex) {
    event?.preventDefault();
    const mode = recoveryHash ? "recover" : event ? "new" : "resume";
    const displayed = savedCreation;
    const lifetime = createLifetime.current;
    if (lifetime.busy) return;
    lifetime.busy = true;
    const operation = ++lifetime.operation;
    const generation = lifetime.generation;
    const session = wallet.getSnapshot();
    const assertIntent = () => {
      if (!lifetime.mounted || lifetime.generation !== generation || wallet.getSnapshot().revision !== session.revision) throw new Error("Something changed. Press Create to continue.");
    };
    const status = (message: string) => { assertIntent(); setCreation({ kind: "busy", message }); };
    try {
      if (session.kind !== "connected" || session.chainId !== service.manifest.chainId) throw new Error("Connect the seller wallet on the configured network.");
      if (!navigator.locks) throw new Error(UNSUPPORTED_BROWSER);
      const key = createStorageKey(service, session.account);
      const clicked = captureCreateGeneration(localStorage, key);
      await navigator.locks.request(key, async () => {
        assertIntent();
        assertCreateGeneration(localStorage, key, clicked);
        let record = readCreateRecord(localStorage, key);
        if ((record ? serializeCreateRecord(record) : null) !== (displayed ? serializeCreateRecord(displayed) : null)) {
          setSavedCreation(record);
          throw new Error("Creation changed in another tab. Review its saved state before clicking Create again.");
        }
        if (mode === "recover" && (record?.kind !== "draft" || !record.pending)) throw new Error("There is no saved creation transaction to recover. Review the saved creation before continuing.");
        if (mode !== "new" && !record) throw new Error("The saved creation is no longer available. Review your raffles before creating another.");
        const persist = (next: CreateRecord) => { writeCreateRecord(localStorage, key, next); record = next; if (lifetime.mounted && lifetime.generation === generation && wallet.getSnapshot().revision === session.revision) setSavedCreation(next); };
        if (!record) {
          if (await service.pending({ wallet })) throw new Error("Finish your pending wallet transaction first.");
          assertIntent();
          if (recoveryHash) throw new Error("There is no saved creation transaction to recover.");
          advanceCreateGeneration(localStorage, key);
          const action = actionFromForm(formRef.current);
          const input = prepareAutomaticCommitment(action.nft, action.tokenId).input;
          const data = encodeDraft({ ...action, reserveNonce: zeroHash, reserveCommit: zeroHash });
          persist({ kind: "preparing", data, requestIdentity: null });
          status(CREATE_STEPS.saveSetup);
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
            throw new Error("Couldn't save the raffle setup. Press Create to try again.");
          }
        } else if (record.kind === "preparing") {
          if (record.requestIdentity === null) throw new Error("Your raffle setup wasn't saved. Open Advanced recovery to start over and edit details.");
          const draft = decodeDraft(record.data);
          status(CREATE_STEPS.restoreSetup);
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
        const savedDraft = decodeDraft(saved.data);
        const result = await finishCreate({ service, wallet, draft: savedDraft, record: saved, save: persist, assertIntent, onStep: step => status(createStepMessage(step, savedDraft.tokenId)) });
        assertIntent();
        const completed = readCreateRecord(localStorage, key);
        if (completed?.kind !== "draft" || completed.id !== result.id.toString() || completed.pending !== null || completed.data !== saved.data) throw new Error("Creation recovery changed before completion.");
        assertIntent();
        retireCompletedCreate(localStorage, key, completed, result.id);
        setSavedCreation(null);
        setCreation({ kind: "done", id: result.id });
        try { await onConfirmed?.(); }
        catch { /* Canonical completion remains final if the optional view refresh fails. */ }
        assertIntent();
        router.push(`/seller/${result.id.toString()}`);
      });
    } catch (error) {
      if (lifetime.mounted && lifetime.generation === generation) setCreation(current => current.kind === "done" ? current : { kind: "error", message: isWalletRequestRejected(error) ? "The wallet request was cancelled. Press Create to continue when you're ready." : error instanceof Error ? error.message : "Creation stopped. Recover the saved stage before trying again." });
    } finally {
      if (lifetime.operation === operation) {
        lifetime.busy = false;
        if (lifetime.mounted && lifetime.generation !== generation) setCreation(current => current.kind === "busy" ? { kind: "error", message: "Something changed. Press Create to continue." } : current);
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
      if (!navigator.locks) throw new Error(UNSUPPORTED_BROWSER);
      const key = createStorageKey(service, session.account);
      const clicked = captureCreateGeneration(localStorage, key);
      await navigator.locks.request(key, async () => {
        assertCreateGeneration(localStorage, key, clicked);
        await retireUnsentCreate({ service, wallet, storage: localStorage, key, expected, assertIntent });
        assertIntent();
        const draft = decodeDraft(expected.data);
        invalidateSelection(); invalidateInventory();
        replaceForm(() => ({ nft: draft.nft, tokenId: draft.tokenId.toString(), title: draft.title, closing: localDeadlineInput(draft.salesEnd), packs: draft.packs.map((pack, index) => ({ id: `recovered-${index}`, name: pack.name, price: formatUsdcInput(pack.priceUsdc), bonusEntries: pack.bonusEntries.toString(), maxSupply: pack.maxSupply.toString() })) }));
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

  if (!existing && (savedCreation !== null || creation.kind === "busy" || creation.kind === "done")) {
    const busy = creation.kind === "busy";
    return <section className={`${formStyles.progress} stack`} aria-live="polite">
      <h2 className={formStyles.stageHeading} ref={progressHeading} tabIndex={-1}>{creation.kind === "done" ? "Raffle created" : busy ? "Creating your raffle" : "Finish creating your raffle"}</h2>
      {creation.kind === "done" ? <p>Opening your raffle…</p> : <>
        <p role={creation.kind === "error" ? "alert" : "status"}>{busy || creation.kind === "error" ? creation.message : "You have an unfinished raffle. Press Create to continue."}</p>
        <button className="btn" type="button" disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Create"}</button>
        {/* Hidden, not unmounted, while a step runs, so an open recovery panel keeps its state. */}
        {savedCreation ? <div hidden={busy}><CreateRecoveryControls disabled={busy} onRecover={savedCreation.kind === "draft" && savedCreation.pending ? hash => void create(undefined, hash) : undefined} onEdit={savedCreation.kind === "preparing" || savedCreation.id === null && savedCreation.creationHash === null && savedCreation.pending === null ? () => void editSavedCreation() : undefined} /></div> : null}
      </>}
    </section>;
  }

  if (state.kind === "retained" && existing) return <div className={`${formStyles.review} studio-review stack`}><h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>Save raffle changes</h2><p className="notice" role="status">Your saved draw setup stays the same, so no signature is needed. Saving sends your raffle back to LABx for review.</p><dl className="review-list"><div><dt>Title</dt><dd>{state.action.title}</dd></div><div><dt>Sales deadline</dt><dd>{deadline(state.action.salesEnd)}</dd></div>{state.action.packs.map((pack, index) => <div key={index}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl><TransactionFlow service={service} wallet={wallet} action={{ kind: "updateDraft", id: existing.id, draft: state.action }} label="Save changes" formatUsdc={formatUsdc} onConfirmed={onConfirmed} /><button className="btn btn-dark" type="button" onClick={returnToEdit}>Edit draft</button></div>;

  if (state.kind === "review" || state.kind === "saving" || state.kind === "committed") {
    const { action } = state;
    return (
      <div className={`${formStyles.review} studio-review stack`}>
        <h2 className={formStyles.stageHeading} ref={reviewFocus} tabIndex={-1}>{existing ? "Save raffle changes" : "Create raffle"}</h2>
        <p className="notice" role="status">Check these details. Your wallet will ask you to sign to save the draw setup for this NFT. Signing doesn't send a transaction.{existing ? " Saving sends your raffle back to LABx for review." : ""}</p>
        <dl className="review-list"><div><dt>Title</dt><dd>{action.title}</dd></div><div><dt>NFT</dt><dd>{shortAddress(action.nft)} · token #{action.tokenId.toString()}</dd></div><div><dt>Sales deadline</dt><dd>{deadline(action.salesEnd)}</dd></div><div><dt>Memberships</dt><dd>{action.packs.length}</dd></div>{action.packs.map((pack, index) => <div key={`${index}-${pack.name}`}><dt>{pack.name}</dt><dd>{formatUsdc(pack.priceUsdc)} USDC · {pack.bonusEntries} bonus entries · {pack.maxSupply} supply</dd></div>)}</dl>
        {state.kind === "committed" ? (
          <>
            <div className="notice ok stack" role="status"><strong>Draw setup saved</strong><span>{existing ? "Save your changes next." : "Create the raffle next."}</span></div>
            <TransactionFlow prepareOnMount={!existing} service={service} wallet={wallet} action={existing ? { kind: "updateDraft", id: existing.id, draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } } : { kind: "createDraft", draft: { ...action, reserveNonce: state.reserve.nonce, reserveCommit: state.reserve.commit } }} label={existing ? "Save changes" : "Create raffle draft"} formatUsdc={formatUsdc} onConfirmed={onConfirmed} />
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

  const showManualEntry = !galleryFirst || manualOpen;

  return (
    <form className={`${formStyles.form} studio-form`} onSubmit={existing ? review : event => void create(event)}>
      <fieldset className={formStyles.formSection} ref={editStage}>
        <legend><span>01</span> Raffle details</legend>
        <div className={`${formStyles.fieldGrid} ${formStyles.detailsGrid}`}>
          <label htmlFor="draft-title">Raffle title<input ref={editFocus} id="draft-title" value={form.title} onChange={(event) => update("title", event.target.value)} required /></label>
          <div className={formStyles.describedField}><label htmlFor="draft-close">Sales deadline (your time)<input id="draft-close" type="datetime-local" value={form.closing} onChange={(event) => update("closing", event.target.value)} aria-describedby="deadline-note" required /></label><small id="deadline-note" className={formStyles.localDeadline}>{deadlineNote}</small></div>
        </div>
      </fieldset>

      <fieldset className={formStyles.formSection}>
        <legend><span>02</span> Prize NFT</legend>
        <div className={formStyles.nftIntro}><p className={formStyles.sectionHelp}>Pick an NFT from your wallet, or enter its contract address and token ID.</p>{existing && !identityLocked ? <button className="btn btn-dark" type="button" aria-controls={pickerId} aria-expanded={pickerOpen} disabled={!walletPickerReady} onClick={pickerOpen ? closePicker : openPicker}>{pickerOpen ? "Close wallet NFTs" : "Choose from wallet"}</button> : null}</div>
        {service.manifest.chainId !== 11155111 ? <p className={formStyles.inventoryNote}>Automatic NFT discovery is disabled for isolated local-chain fixtures. Manual entry remains available.</p> : null}
        {galleryOpen ? <div id={pickerId} className={formStyles.picker} role="region" aria-label="Wallet NFTs" aria-busy={inventoryBusy || pendingNft !== null}>
          <div className={formStyles.pickerHeading}><strong>Your NFTs</strong><button ref={refreshFocus} className={`btn btn-dark ${formStyles.refreshButton}`} type="button" aria-disabled={inventoryBusy} aria-busy={inventoryBusy} onClick={() => { if (inventoryBusy) return; invalidateInventory(); setInventory({ kind: "idle" }); setSelectionError(""); void loadInventory(); }}>Refresh</button></div>
          <p className={formStyles.inventoryNote} role="status" aria-live="polite" aria-atomic="true">{inventoryStatus}</p>
          {inventory.kind !== "idle" && inventory.items.length > 0 ? <ul className={formStyles.nftGallery}>{inventory.items.map((item) => {
            const key = `${item.contract.toLowerCase()}:${item.tokenId}`;
            const pending = pendingNft === key;
            const selected = selectedNft?.contract.toLowerCase() === item.contract.toLowerCase() && selectedNft.tokenId === item.tokenId;
            const label = `${item.name || item.collection || "NFT"}, contract ${item.contract}, token ${item.tokenId}`;
            const accessibleLabel = pending ? `Verifying ownership for ${label}` : selected ? `Selected ${label}` : `Select ${label}. Use this NFT.`;
            return <li key={key}><button type="button" className={formStyles.nftCard} data-selected={selected} aria-disabled={pending} aria-busy={pending} aria-label={accessibleLabel} onClick={() => { if (!pending) void chooseNft(item); }}><NftPreview item={item} /><span><strong>{item.name || item.collection || `NFT #${item.tokenId}`}</strong><small>{shortAddress(item.contract)} · token #{item.tokenId}</small><em>{pending ? "Checking ownership…" : selected ? "Selected" : "Use this NFT"}</em></span></button></li>;
          })}</ul> : null}
          {inventory.kind === "error" ? <p className="notice warning" role="alert">{inventory.message}</p> : null}
          <p className={formStyles.inventoryNote} role="status" aria-live="polite" aria-atomic="true">{selectionStatus}</p>
          {selectionError ? <p className="notice warning" role="alert">{selectionError}</p> : null}
          {loadMoreCursor !== null ? <button ref={loadMoreFocus} className="btn btn-dark" type="button" aria-disabled={inventoryBusy} aria-busy={inventoryBusy} onClick={() => { if (!inventoryBusy) void loadInventory(loadMoreCursor); }}>Load more wallet NFTs</button> : null}
        </div> : null}
        {galleryFirst ? <button className="text-link" type="button" aria-controls={manualId} aria-expanded={manualOpen} onClick={() => setManualOpen(open => !open)}>Enter contract and token ID instead</button> : null}
        {showManualEntry ? <div id={manualId} className={`${formStyles.fieldGrid} ${formStyles.nftGrid}`}>
          <label htmlFor="draft-nft">NFT contract<input id="draft-nft" spellCheck={false} autoCapitalize="none" autoCorrect="off" value={form.nft} disabled={existing?.raffle.escrowed} onChange={(event) => update("nft", event.target.value.trim())} required /></label>
          <label htmlFor="draft-token">Token ID<input id="draft-token" inputMode="numeric" value={form.tokenId} disabled={existing?.raffle.escrowed} onChange={(event) => update("tokenId", event.target.value.trim())} required /></label>
        </div> : null}
      </fieldset>

      <fieldset className={`${formStyles.formSection} ${formStyles.packSection}`}>
        <legend><span>03</span> Membership packs</legend>
        <div className={formStyles.sectionIntro}><p className={formStyles.sectionHelp}>{existing ? "Edit the price, bonus entries and supply for each pack. Packs can't be added or removed." : "Set a price for each tier. Bonus entries and supply are suggestions you can change."}</p>{existing ? <span>{`${form.packs.length} existing membership${form.packs.length === 1 ? "" : "s"}`}</span> : null}</div>
        <div className={formStyles.packList}>{form.packs.map((pack, index) => <fieldset className={formStyles.packCard} key={pack.id} aria-label={`Membership ${index + 1}: ${pack.name}`}><legend><strong>{pack.name}</strong></legend><div className={formStyles.packFields}><label>Price in USDC<input inputMode="decimal" value={pack.price} onChange={(event) => updatePack(pack.id, "price", event.target.value)} required /></label><label>Bonus entries<input inputMode="numeric" value={pack.bonusEntries} onChange={(event) => updatePack(pack.id, "bonusEntries", event.target.value)} required /></label><label>Supply<input inputMode="numeric" value={pack.maxSupply} onChange={(event) => updatePack(pack.id, "maxSupply", event.target.value)} required /></label></div></fieldset>)}</div>
      </fieldset>

      {!existing && creation.kind === "error" ? <p className="notice error" role="alert">{creation.message}</p> : null}
      {state.kind === "error" ? <p className={`${formStyles.formError} notice error`} role="alert">{state.message}</p> : null}
      <div className={formStyles.reviewAction}><div><strong>{existing ? "Ready to save?" : "Ready to create?"}</strong><span>{existing ? "Saving sends your raffle back to LABx for review." : "Create locks your NFT for the raffle. Your wallet will ask for 1 signature and up to 3 confirmations."}</span></div><button className="btn" type="submit">{existing ? "Save changes" : "Create"}</button></div>
    </form>
  );
}
