"use client";

import { useSyncExternalStore } from "react";
import { formatDate, formatLocalDate, formatShortDate } from "./format";

const noChanges = () => () => {};

/** A contract timestamp in the viewer's time zone with UTC in brackets. The server and the hydrating render show UTC only, so their markup matches. */
export function LocalTime({ at, short = false }: { at: bigint; short?: boolean }) {
  const hydrated = useSyncExternalStore(noChanges, () => true, () => false);
  const date = new Date(Number(at) * 1000);
  return (
    <time dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}>
      {hydrated ? formatLocalDate(at, short) : short ? formatShortDate(at) : `${formatDate(at)} UTC`}
    </time>
  );
}
