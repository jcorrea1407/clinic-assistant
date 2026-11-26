import Anthropic from "@anthropic-ai/sdk";
import type { Completion, CompletionRequest, ModelProvider } from "./provider.js";

export interface AnthropicProviderOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** For tests. By default the SDK reads ANTHROPIC_API_KEY or an `ant auth login` profile. */
  client?: Anthropic;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const { model, effort, maxTokens = 16_000 } = options;
  // Created on first use, so loading config never needs credentials.
  let client = options.client;

  return {
    async complete({ system, messages }: CompletionRequest): Promise<Completion> {
      client ??= new Anthropic();

      const response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        output_config: { effort },
        // If a safety classifier declines, the API re-runs the request on a
        // fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The system prompt (the whole fact sheet, from #72) is identical on
        // every turn, so cache it.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
      });

      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");

      return {
        text,
        stopReason:
          response.stop_reason === "end_turn" ||
          response.stop_reason === "max_tokens" ||
          response.stop_reason === "refusal"
            ? response.stop_reason
            : "other",
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
