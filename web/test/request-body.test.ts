import { describe, expect, it } from "vitest";
import { workflowRequestBody } from "../lib/chain/request-body";
describe("bounded workflow requests", () => {
  it("accepts JSON objects and refuses malformed/nonobject bodies", async () => {
    const post = (body: string) => new Request("http://localhost/api/workflow", { method: "POST", body });
    expect(await workflowRequestBody(post('{"id":"1"}'))).toEqual({ id: "1" });
    for (const value of ["null", "[]", "broken"]) await expect(workflowRequestBody(post(value))).rejects.toThrow();
  });
  it("enforces the actual stream size despite absent or dishonest content-length", async () => {
    for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
      const request = new Request("http://localhost/api/workflow", { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(70_000) }) });
      await expect(workflowRequestBody(request)).rejects.toThrow(/too large/);
    }
  });
});
