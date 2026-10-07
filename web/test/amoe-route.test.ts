import { describe, expect, it } from "vitest";
import { POST as challenge } from "../app/api/amoe/challenge/route";
import { POST as claim } from "../app/api/amoe/claim/route";

describe("retired free-entry issuance", () => {
  it.each([challenge, claim])("rejects requests without issuing a challenge or voucher", async (route) => {
    const response = await route();
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/retired/i);
    expect(body).not.toHaveProperty("signature");
    expect(body).not.toHaveProperty("challenge");
  });
});
