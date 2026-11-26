import type { ClassifyResult, ModelProvider, ModelRequest, StreamEvent, Usage } from "../src/model/provider.js";

export const usage: Usage = { model: "fake", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A ModelProvider that returns scripted answers and records every call. */
export function fakeProvider(script: {
  classify?: ClassifyResult<unknown> | (() => never);
  reply?: string[];
  stopReason?: "end_turn" | "refusal";
}) {
  const calls = { classify: [] as ModelRequest[], stream: [] as ModelRequest[] };
  const provider: ModelProvider = {
    async classify<T>(request: ModelRequest) {
      calls.classify.push(request);
      const result = script.classify ?? { ok: true, value: { tier: "question", concern: null }, usage };
      if (typeof result === "function") result();
      return result as ClassifyResult<T>;
    },
    async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      calls.stream.push(request);
      for (const text of script.reply ?? ["Hi"]) yield { type: "text", text };
      yield { type: "end", stopReason: script.stopReason ?? "end_turn", usage };
    },
  };
  return { provider, calls };
}

export const classified = (tier: string, concern: string | null = null): ClassifyResult<unknown> => ({
  ok: true,
  value: { tier, concern },
  usage,
});
