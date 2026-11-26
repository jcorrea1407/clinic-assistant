import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicProvider } from "../src/model/anthropic.js";
import type { ModelRequest, StreamEvent } from "../src/model/provider.js";

// A stand-in for the SDK client, so these tests never call the API.
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 8 };

function fakeClient({ parsed = {}, streamed = {} }: { parsed?: object; streamed?: object } = {}) {
  const parse = vi.fn().mockResolvedValue({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    parsed_output: { tier: "question" },
    usage,
    ...parsed,
  });
  const stream = vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
      yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
    },
    finalMessage: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage, ...streamed }),
  }));
  const client = { beta: { messages: { parse, stream } } } as unknown as Anthropic;
  return { parse, stream, client };
}

const request: ModelRequest = {
  system: "Facts…",
  messages: [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "Hours?" },
  ],
  note: "Classify it.",
};
const schema = z.object({ tier: z.enum(["question", "concern"]) });
const provider = (client: Anthropic) => createAnthropicProvider({ model: "claude-opus-5-5", effort: "low", client });

async function collect(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("Anthropic provider", () => {
  it("sends the model, effort and fallbacks, caches the system prompt and the latest message, and puts the note last", async () => {
    const { parse, client } = fakeClient();
    await provider(client).classify(request, schema);

    const params = parse.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: "Facts…", cache_control: { type: "ephemeral" } }],
    });
    expect(params.output_config.format).toBeDefined();
    expect(params.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: [{ type: "text", text: "Hours?", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "Classify it." },
    ]);
  });

  it("returns the parsed classification with usage", async () => {
    const { client } = fakeClient();
    expect(await provider(client).classify(request, schema)).toEqual({
      ok: true,
      value: { tier: "question" },
      usage: { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 2, cacheReadTokens: 9000, cacheWriteTokens: 8 },
    });
  });

  it("reports a refused classification", async () => {
    const { client } = fakeClient({ parsed: { stop_reason: "refusal", parsed_output: null } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: false, reason: "refusal" });
  });

  it("reports output that doesn't match the schema", async () => {
    const { client } = fakeClient({ parsed: { parsed_output: { tier: "nonsense" } } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("streams only text, then ends with the stop reason and the model that answered", async () => {
    const { stream, client } = fakeClient({ streamed: { model: "claude-opus-4-8" } });
    const events = await collect(provider(client).stream(request));

    expect(stream.mock.calls[0]![0].output_config).toEqual({ effort: "low" });
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "end", stopReason: "end_turn", usage: expect.objectContaining({ model: "claude-opus-4-8" }) },
    ]);
  });

  it("passes a mid-stream refusal through", async () => {
    const { client } = fakeClient({ streamed: { stop_reason: "refusal" } });
    const events = await collect(provider(client).stream(request));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "refusal" });
  });
});
