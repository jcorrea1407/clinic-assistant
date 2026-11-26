import type { ModelConfig } from "../config/schema.js";
import { createAnthropicProvider } from "./anthropic.js";

// The one seam between the assistant and a model vendor. Nothing outside
// src/model knows which SDK is in use, so an OpenAI adapter (for the model
// comparison in ADR 0002) only adds a file here.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
}

export interface Completion {
  text: string;
  /** "refusal" means the model (and any fallback) declined. Show a fixed message, not `text`. */
  stopReason: "end_turn" | "max_tokens" | "refusal" | "other";
  /** The model that produced the reply, which differs from the configured one after a fallback. */
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface ModelProvider {
  complete(request: CompletionRequest): Promise<Completion>;
}

export function providerFor(model: ModelConfig): ModelProvider {
  switch (model.provider) {
    case "anthropic":
      return createAnthropicProvider({ model: model.id, effort: model.effort });
  }
}
