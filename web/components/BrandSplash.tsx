"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./BrandSplash.module.css";

const SESSION_KEY = "labx:brand-intro:shown";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const PORTRAIT_QUERY = "(orientation: portrait)";
const STARTUP_TIMEOUT_MS = 5_000;

type SessionStatus = "fresh" | "handled" | "unavailable";
type VideoSource = "/brand/labx-intro-wide.mp4" | "/brand/labx-intro-tall.mp4";
type SplashState =
  | { kind: "checking" }
  | { kind: "hidden" }
  | { kind: "showing"; source: VideoSource };

let handledInThisPage = false;

export function shouldShowBrandSplash({
  hasHashTarget,
  pathname,
  reducedMotion,
  saveData,
  sessionStatus
}: {
  hasHashTarget: boolean;
  pathname: string;
  reducedMotion: boolean;
  saveData: boolean;
  sessionStatus: SessionStatus;
}) {
  return pathname === "/" && !hasHashTarget && !reducedMotion && !saveData && sessionStatus === "fresh";
}

export function brandSplashVideoSource(portrait: boolean): VideoSource {
  return portrait ? "/brand/labx-intro-tall.mp4" : "/brand/labx-intro-wide.mp4";
}

function sessionStatus(): SessionStatus {
  if (handledInThisPage) return "handled";

  try {
    return window.sessionStorage.getItem(SESSION_KEY) === "1" ? "handled" : "fresh";
  } catch {
    return "unavailable";
  }
}

function markSessionHandled() {
  handledInThisPage = true;
  try {
    window.sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    // Storage can be unavailable in privacy modes. The in-memory guard still
    // prevents a late client-side navigation from opening the intro.
  }
}

function dataSaverEnabled() {
  if (!("connection" in navigator)) return false;
  const connection = navigator.connection;
  return typeof connection === "object"
    && connection !== null
    && "saveData" in connection
    && connection.saveData === true;
}

function focusPageContent() {
  window.requestAnimationFrame(() => {
    document.getElementById("content")?.focus({ preventScroll: true });
  });
}

export function BrandSplash() {
  const pathname = usePathname();
  const initialPathname = useRef(pathname);
  const eligibilityChecked = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const startupTimer = useRef<number | null>(null);
  const [state, setState] = useState<SplashState>({ kind: "checking" });
  const [muted, setMuted] = useState(true);

  const clearStartupTimer = useCallback(() => {
    if (startupTimer.current !== null) {
      window.clearTimeout(startupTimer.current);
      startupTimer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearStartupTimer();
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setState({ kind: "hidden" });
    focusPageContent();
  }, [clearStartupTimer]);

  useEffect(() => {
    if (eligibilityChecked.current) return;
    eligibilityChecked.current = true;

    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
    const status = sessionStatus();
    markSessionHandled();

    if (!shouldShowBrandSplash({
      hasHashTarget: window.location.hash.length > 1,
      pathname: initialPathname.current,
      reducedMotion,
      saveData: dataSaverEnabled(),
      sessionStatus: status
    })) {
      setState({ kind: "hidden" });
      return;
    }

    setState({
      kind: "showing",
      source: brandSplashVideoSource(window.matchMedia(PORTRAIT_QUERY).matches)
    });
  }, []);

  useEffect(() => {
    if (state.kind !== "showing") return;

    const dialog = dialogRef.current;
    const video = videoRef.current;
    if (!dialog || !video) {
      dismiss();
      return;
    }

    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleMotionChange = (event: MediaQueryListEvent) => {
      if (event.matches) dismiss();
    };

    if (typeof dialog.showModal !== "function") {
      dismiss();
      return;
    }
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      dismiss();
      return;
    }

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    reducedMotion.addEventListener("change", handleMotionChange);
    startupTimer.current = window.setTimeout(dismiss, STARTUP_TIMEOUT_MS);
    void video.play().then(clearStartupTimer).catch(dismiss);

    return () => {
      if (startupTimer.current !== null) {
        window.clearTimeout(startupTimer.current);
        startupTimer.current = null;
      }
      reducedMotion.removeEventListener("change", handleMotionChange);
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      if (dialog.open) dialog.close();
    };
  }, [clearStartupTimer, dismiss, state]);

  useEffect(() => {
    if (state.kind === "showing" && pathname !== "/") dismiss();
  }, [dismiss, pathname, state.kind]);

  if (state.kind !== "showing") return null;

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setMuted(nextMuted);
    if (video.paused) void video.play().catch(dismiss);
  };

  return (
    <dialog
      aria-label="LABx introduction"
      className={styles.dialog}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      ref={dialogRef}
    >
      <div className={styles.stage}>
        <video
          aria-hidden="true"
          autoPlay
          className={styles.video}
          muted={muted}
          onEnded={dismiss}
          onError={dismiss}
          onPlaying={clearStartupTimer}
          playsInline
          poster="/brand/labx-intro-poster.webp"
          preload="auto"
          ref={videoRef}
          src={state.source}
        />
        <div className={styles.controls}>
          <button autoFocus className={`${styles.control} ${styles.skip}`} onClick={dismiss} type="button">
            Skip intro
          </button>
          <button
            aria-pressed={!muted}
            className={styles.control}
            onClick={toggleSound}
            type="button"
          >
            {muted ? "Sound on" : "Mute"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
