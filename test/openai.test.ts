import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAIProvider } from "../src/model/openai.js";
import type { ModelRequest, StreamEvent } from "../src/model/provider.js";

// A stand-in for the SDK client, so these tests never call the API.
const usage = {
  input_tokens: 9_100,
  output_tokens: 20,
  input_tokens_details: { cached_tokens: 9_000, cache_write_tokens: 60 },
};
const message = (parts: object[]) => ({ type: "message", content: parts });

function response(overrides: object = {}) {
  return {
    model: "gpt-6.2-sol",
    status: "completed",
    incomplete_details: null,
    output: [message([{ type: "output_text", text: '{"tier":"question"}' }])],
    output_text: '{"tier":"question"}',
    usage,
    ...overrides,
  };
}

function fakeClient({ created = {}, events }: { created?: object; events?: object[] } = {}) {
  const create = vi.fn().mockImplementation(async (params: { stream?: boolean }) => {
    if (!params.stream) return response(created);
    const streamed = events ?? [
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: response() },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* streamed;
      },
    };
  });
  const client = { responses: { create } } as unknown as OpenAI;
  return { create, client };
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
const provider = (client: OpenAI) => createOpenAIProvider({ model: "gpt-6.2-sol", effort: "low", client });

async function collect(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("OpenAI provider", () => {
  it("sends the model and effort, caches the system prompt and the latest message, and puts the note last", async () => {
    const { create, client } = fakeClient();
    await provider(client).classify(request, schema);

    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "gpt-6.2-sol",
      reasoning: { effort: "low" },
      store: false,
      prompt_cache_options: { mode: "explicit" },
    });
    expect(params).not.toHaveProperty("text");
    const breakpoint = { mode: "explicit" };
    expect(params.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "Facts…", prompt_cache_breakpoint: breakpoint }] },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: [{ type: "input_text", text: "Hours?", prompt_cache_breakpoint: breakpoint }] },
      { role: "developer", content: "Classify it." },
    ]);
  });

  it("returns the parsed classification, counting cached tokens apart from input", async () => {
    const { client } = fakeClient();
    expect(await provider(client).classify(request, schema)).toEqual({
      ok: true,
      value: { tier: "question" },
      usage: { model: "gpt-6.2-sol", inputTokens: 40, outputTokens: 20, cacheReadTokens: 9_000, cacheWriteTokens: 60 },
    });
  });

  it("reports output that doesn't match the schema as invalid", async () => {
    const { client } = fakeClient({ created: { output_text: '{"tier":"emergency"}' } });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reports a refusal", async () => {
    const { client } = fakeClient({
      created: { output: [message([{ type: "refusal", refusal: "No." }])], output_text: "" },
    });
    expect(await provider(client).classify(request, schema)).toMatchObject({ ok: false, reason: "refusal" });
  });

  it("streams text, then ends with the stop reason and usage", async () => {
    const { create, client } = fakeClient();
    const events = await collect(provider(client).stream(request));

    expect(create.mock.calls[0]![0]).toMatchObject({ stream: true, max_output_tokens: 16_000 });
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "end",
        stopReason: "end_turn",
        usage: { model: "gpt-6.2-sol", inputTokens: 40, outputTokens: 20, cacheReadTokens: 9_000, cacheWriteTokens: 60 },
      },
    ]);
  });

  it("ends with max_tokens when the reply is cut off", async () => {
    const cut = response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const { client } = fakeClient({ events: [{ type: "response.incomplete", response: cut }] });
    const events = await collect(provider(client).stream(request));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "max_tokens" });
  });

  it("ends with refusal when the model declines mid-stream", async () => {
    const { client } = fakeClient({
      events: [
        { type: "response.output_text.delta", delta: "Sure" },
        { type: "response.refusal.delta", delta: "I can't" },
        { type: "response.completed", response: response() },
      ],
    });
    const events = await collect(provider(client).stream(request));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "refusal" });
  });

  it("throws when the response fails, so the turn shows the fixed failure text", async () => {
    const { client } = fakeClient({
      events: [{ type: "response.failed", response: response({ status: "failed", error: { code: "server_error" } }) }],
    });
    await expect(collect(provider(client).stream(request))).rejects.toThrow("server_error");
  });
});
