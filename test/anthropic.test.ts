import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicProvider } from "../src/model/anthropic.js";
import type { ModelRequest, StreamEvent } from "../src/model/provider.js";

// A stand-in for the SDK client, so these tests never call the API.
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 9000, cache_creation_input_tokens: 8 };

const text = (t: string) => ({ type: "text", text: t });
const delta = (t: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } });
const fallbackBlock = {
  type: "content_block_start",
  content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
};

function fakeClient({
  created = {},
  streamed = {},
  events = [delta("Hel"), { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } }, delta("lo")],
}: { created?: object; streamed?: object; events?: object[] } = {}) {
  const create = vi.fn().mockResolvedValue({
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [text('{"tier":"question"}')],
    usage,
    ...created,
  });
  const stream = vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    finalMessage: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage, ...streamed }),
  }));
  const client = { beta: { messages: { create, stream } } } as unknown as Anthropic;
  return { create, stream, client };
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
    const { create, client } = fakeClient();
    await provider(client).classify(request, schema);

    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: "Facts…", cache_control: { type: "ephemeral" } }],
    });
    // No format: it would change the cached prefix and split the cache from the reply call.
    expect(params.output_config).toEqual({ effort: "low" });
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
    const { client } = fakeClient({ created: { stop_reason: "refusal", content: [] } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: false, reason: "refusal" });
  });

  it.each([
    ["doesn't match the schema", [text('{"tier":"nonsense"}')]],
    ["isn't JSON", [text('{"tier":"ques')]],
    ["is empty", []],
  ])("reports output that %s as invalid, with usage", async (_name, content) => {
    const { client } = fakeClient({ created: { content, stop_reason: "max_tokens" } });
    expect(await provider(client).classify(request, schema)).toMatchObject({
      ok: false,
      reason: "invalid",
      usage: expect.objectContaining({ inputTokens: 10 }),
    });
  });

  it("reads JSON wrapped in a code fence", async () => {
    const { client } = fakeClient({ created: { content: [text('```json\n{"tier":"concern"}\n```')] } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: true, value: { tier: "concern" } });
  });

  it("reads the classification from after a fallback, not the declined model's partial JSON", async () => {
    const content = [text('{"tier":"conc'), { type: "fallback" }, text('{"tier":"concern"}')];
    const { client } = fakeClient({ created: { content, model: "claude-opus-4-8" } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: true, value: { tier: "concern" } });
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

  it("signals a restart when a fallback model takes over mid-reply", async () => {
    const { client } = fakeClient({ events: [delta("You could ice"), fallbackBlock, delta("Sorry, I can't advise.")] });
    const events = await collect(provider(client).stream(request));
    expect(events.slice(0, 3)).toEqual([
      { type: "text", text: "You could ice" },
      { type: "restart" },
      { type: "text", text: "Sorry, I can't advise." },
    ]);
  });

  it("passes a mid-stream refusal through", async () => {
    const { client } = fakeClient({ streamed: { stop_reason: "refusal" } });
    const events = await collect(provider(client).stream(request));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "refusal" });
  });
});
