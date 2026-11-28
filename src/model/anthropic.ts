import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { lastMatchingObject } from "./json.js";
import type { ClassifyResult, ModelProvider, ModelRequest, StreamEvent, Usage } from "./provider.js";

export { jsonObjects } from "./json.js";

export interface AnthropicProviderOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** For tests. By default the SDK reads ANTHROPIC_API_KEY or an `ant auth login` profile. */
  client?: Anthropic;
}

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

// Models the API offers server-side refusal fallbacks for. Sending `fallbacks`
// to any other model (Claude Haiku 5.5, for one) is an error.
const SERVER_FALLBACK_MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export function supportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model);
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const { model, effort } = options;
  // Created on first use, so loading config never needs credentials.
  let client = options.client;
  const sdk = () => (client ??= new Anthropic());

  function baseParams({ system, messages, note }: ModelRequest) {
    const last = messages.length - 1;
    const turns: Anthropic.Beta.Messages.BetaMessageParam[] = messages.map((m, i) =>
      // Cache breakpoint on the latest visitor message: the classify call writes
      // the conversation to the cache and the reply call reads it back.
      i === last && m.role === "user"
        ? { role: "user", content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
        : { role: m.role, content: m.content },
    );
    return {
      model,
      // If a safety classifier declines, the API re-runs the request on a
      // fallback model inside the same call. Without it, a refusal ends the
      // turn with the fixed "can't help" text.
      ...(supportsServerFallback(model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
      // The rules and the whole fact sheet: identical on every request, so cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      // The note goes after the conversation, so it never changes the cached prefix.
      messages: [...turns, { role: "system", content: note }],
    } satisfies Partial<Params>;
  }

  return {
    async classify<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<ClassifyResult<T>> {
      // No `output_config.format`: a schema there changes the cached prefix, so
      // classify and reply would each cache their own copy of the prompt. The
      // note asks for JSON and the schema is checked here instead. Measured with
      // `npm run try`: with a format, the reply call never read classify's cache.
      const response = await sdk().beta.messages.create({
        ...baseParams(request),
        max_tokens: 4_000,
        output_config: { effort },
      });
      const usage = usageOf(response);
      if (response.stop_reason === "refusal") return { ok: false, reason: "refusal", usage };
      const value = lastMatchingObject(finalText(response.content), schema);
      return value.ok ? { ok: true, value: value.value, usage } : { ok: false, reason: "invalid", usage };
    },

    async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      const stream = sdk().beta.messages.stream({
        ...baseParams(request),
        max_tokens: 16_000,
        output_config: { effort },
      });
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "fallback") {
          // The model declined partway; a fallback model starts over from here.
          yield { type: "restart" };
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const stop = final.stop_reason;
      yield {
        type: "end",
        stopReason: stop === "end_turn" || stop === "max_tokens" || stop === "refusal" ? stop : "other",
        usage: usageOf(final),
      };
    },
  };
}

/** The text written after the last fallback block: the answer from the model that finished. */
function finalText(content: Anthropic.Beta.Messages.BetaContentBlock[]): string {
  const start = content.findLastIndex((b) => b.type === "fallback") + 1;
  return content
    .slice(start)
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
}

function usageOf(message: Anthropic.Beta.Messages.BetaMessage): Usage {
  return {
    // The model that answered, which differs from the configured one after a fallback.
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}
