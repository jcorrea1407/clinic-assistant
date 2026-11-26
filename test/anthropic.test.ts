import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../src/model/anthropic.js";

// A stand-in for the SDK client, so these tests never call the API.
function fakeClient(response: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Hello" }],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 8 },
    ...response,
  });
  return { create, client: { beta: { messages: { create } } } as unknown as Anthropic };
}

describe("Anthropic provider", () => {
  it("sends the configured model and effort, with fallbacks on and the system prompt cached", async () => {
    const { create, client } = fakeClient({});
    const provider = createAnthropicProvider({ model: "claude-opus-5-5", effort: "low", client });

    await provider.complete({ system: "Facts…", messages: [{ role: "user", content: "Hi" }] });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-5-5",
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: "Facts…", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
  });

  it("returns the text and usage", async () => {
    const { client } = fakeClient({});
    const provider = createAnthropicProvider({ model: "claude-opus-5-5", effort: "low", client });

    const result = await provider.complete({ system: "s", messages: [{ role: "user", content: "Hi" }] });
    expect(result).toEqual({
      text: "Hello",
      stopReason: "end_turn",
      model: "claude-opus-5-5",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 8 },
    });
  });

  it("passes a refusal through, so the caller can show a fixed message", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    const provider = createAnthropicProvider({ model: "claude-opus-5-5", effort: "low", client });

    const result = await provider.complete({ system: "s", messages: [{ role: "user", content: "Hi" }] });
    expect(result.stopReason).toBe("refusal");
    expect(result.text).toBe("");
  });

  it("reports the model that actually answered after a fallback", async () => {
    const { client } = fakeClient({ model: "claude-opus-4-8" });
    const provider = createAnthropicProvider({ model: "claude-opus-5-5", effort: "low", client });

    const result = await provider.complete({ system: "s", messages: [{ role: "user", content: "Hi" }] });
    expect(result.model).toBe("claude-opus-4-8");
  });
});
