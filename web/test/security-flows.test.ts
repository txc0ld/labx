import { describe, expect, it } from "vitest";
import { receiptBody } from "../lib/email";

describe("receipt email HTML", () => {
  it("escapes every interpolated value, so no field can add markup", () => {
    const hostile = `<img src=x onerror="alert('1')">&`;
    const escaped = "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;";
    const { html } = receiptBody({ to: "buyer@example.com", piece: hostile, pack: hostile, entries: 2, priceUsdc: hostile, feeUsdc: hostile });
    expect(html).not.toContain("<img");
    expect(html.split(escaped).length - 1).toBe(4);
    expect(html).toContain("<p>2 bonus entries.");
  });
});
