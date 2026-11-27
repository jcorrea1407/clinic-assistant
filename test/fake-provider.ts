import type { ClassifyResult, ModelProvider, ModelRequest, StreamEvent, Usage } from "../src/model/provider.js";

export const usage: Usage = { model: "fake", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A ModelProvider that returns scripted answers and records every call. */
export function fakeProvider(script: {
  /** One result for every call, or a list consumed one per call. */
  classify?: ClassifyResult<unknown> | (() => never) | (ClassifyResult<unknown> | (() => never))[];
  /** Text pieces, or a restart where a fallback model takes over. */
  reply?: (string | { type: "restart" })[];
  stopReason?: "end_turn" | "refusal" | "max_tokens";
}) {
  const calls = { classify: [] as ModelRequest[], stream: [] as ModelRequest[] };
  const provider: ModelProvider = {
    async classify<T>(request: ModelRequest) {
      calls.classify.push(request);
      const scripted = Array.isArray(script.classify) ? script.classify[calls.classify.length - 1] : script.classify;
      const result = scripted ?? { ok: true, value: { tier: "question", concern: null }, usage };
      if (typeof result === "function") result();
      return result as ClassifyResult<T>;
    },
    async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      calls.stream.push(request);
      for (const piece of script.reply ?? ["Hi"]) yield typeof piece === "string" ? { type: "text", text: piece } : piece;
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
