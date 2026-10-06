"use client";

import { useRef, useState } from "react";

export type ClipboardWriter = { writeText(value: string): Promise<void> };

export async function copyPlaceholder(clipboard: ClipboardWriter | undefined) {
  if (!clipboard) return false;
  try {
    await clipboard.writeText("XXXX");
    return true;
  } catch {
    return false;
  }
}

export function DiscountCode() {
  const field = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("XXXX is a placeholder and cannot redeem this offer.");

  async function copy() {
    const copied = await copyPlaceholder(navigator.clipboard);
    if (copied) {
      setMessage("Placeholder copied. It cannot redeem the discount.");
      return;
    }
    field.current?.focus();
    field.current?.select();
    setMessage("Copy unavailable. Select XXXX and copy it manually.");
  }

  return (
    <div className="discount-code stack">
      <label htmlFor="discount-code">Discount code placeholder</label>
      <div className="discount-code-row">
        <input ref={field} id="discount-code" value="XXXX" readOnly aria-describedby="discount-code-note" />
        <button className="btn btn-dark" type="button" onClick={copy}>Copy placeholder</button>
      </div>
      <p id="discount-code-note" className="muted" role="status">{message}</p>
    </div>
  );
}
