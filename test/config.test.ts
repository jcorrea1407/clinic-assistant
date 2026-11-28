import { describe, expect, it } from "vitest";
import upland from "../clients/upland/config.js";
import { ConfigError, loadAllClients, loadClient } from "../src/config/load.js";

const config = (overrides: Record<string, unknown> = {}) => ({ ...structuredClone(upland), ...overrides });

describe("client config", () => {
  it("loads every registered client", async () => {
    const clients = await loadAllClients();
    expect(clients.map((c) => c.config.id)).toEqual(["upland"]);
    expect(clients[0]!.config.model).toEqual({ provider: "openai", id: "gpt-6.2-sol", effort: "low" });
  });

  it("rejects a malformed front-desk inbox and names the client", async () => {
    await expect(loadClient(config({ frontDeskInbox: "front desk" }))).rejects.toThrow(
      /Config for upland is invalid:[\s\S]*frontDeskInbox/,
    );
  });

  it("rejects a brand colour that isn't #rrggbb", async () => {
    await expect(loadClient(config({ brandColour: "green" }))).rejects.toThrow(ConfigError);
  });

  it("rejects an unknown model provider", async () => {
    const model = { provider: "mistral", id: "mistral-large", effort: "low" };
    await expect(loadClient(config({ model }))).rejects.toThrow(ConfigError);
  });

  it("accepts an OpenAI model", async () => {
    const model = { provider: "openai", id: "gpt-6.2-sol", effort: "low" };
    await expect(loadClient(config({ model }))).resolves.toMatchObject({ config: { model } });
  });

  it("reports a bad fact sheet as that client's error", async () => {
    const facts = { kind: "local-json", data: { meta: { clinic: "X" }, collections: {} } };
    await expect(loadClient(config({ facts }))).rejects.toThrow("Fact sheet for upland is invalid");
  });

  it("rejects two clients with the same id", async () => {
    await expect(loadAllClients([config(), config()])).rejects.toThrow('Two clients share the id "upland"');
  });

  it("reports every broken client, not just the first", async () => {
    const error = await loadAllClients([
      config({ id: "a", brandColour: "x" }),
      config({ id: "b", frontDeskInbox: "x" }),
    ]).catch((e: Error) => e);
    expect(String(error)).toContain("Config for a");
    expect(String(error)).toContain("Config for b");
  });
});
