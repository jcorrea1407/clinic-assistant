import type { z } from "zod";
import type { ModelConfig } from "../config/schema.js";
import { createAnthropicProvider } from "./anthropic.js";

// The one seam between the assistant and a model vendor. Nothing outside
// src/model knows which SDK is in use, so an OpenAI adapter (for the model
// comparison in ADR 0002) only adds a file here.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  /** Identical on every request for a client, so it can be cached. */
  system: string;
  /** The conversation so far, ending with the visitor's latest message. */
  messages: ChatMessage[];
  /** An operator instruction for this turn only, placed after the conversation. */
  note: string;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ClassifyResult<T> =
  | { ok: true; value: T; usage: Usage }
  /** "refusal": the model (and any fallback) declined. "invalid": the output didn't match the schema. */
  | { ok: false; reason: "refusal" | "invalid"; usage: Usage };

export type StreamEvent =
  | { type: "text"; text: string }
  /** Always last. On "refusal", discard the text already streamed. */
  | { type: "end"; stopReason: "end_turn" | "max_tokens" | "refusal" | "other"; usage: Usage };

export interface ModelProvider {
  /** Returns structured output that matches `schema`. */
  classify<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<ClassifyResult<T>>;
  /** Streams a plain-text reply. */
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
}

export function providerFor(model: ModelConfig): ModelProvider {
  switch (model.provider) {
    case "anthropic":
      return createAnthropicProvider({ model: model.id, effort: model.effort });
  }
}
