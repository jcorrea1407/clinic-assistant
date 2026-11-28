import { describe, expect, it } from "vitest";
import health from "../api/health.js";

describe("GET /api/health", () => {
  it("reports each client's id and model", async () => {
    const response = await health.fetch(new Request("https://example.test/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      clients: [{ id: "upland", model: "gpt-6.2-sol" }],
    });
  });

  it("only answers GET", async () => {
    const response = await health.fetch(new Request("https://example.test/api/health", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
