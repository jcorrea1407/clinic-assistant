import OpenAI from "openai";
import type { z } from "zod";
import { lastMatchingObject } from "./json.js";
import type { ClassifyResult, ModelProvider, ModelRequest, StreamEvent, Usage } from "./provider.js";

// The OpenAI adapter, added for the model comparison (portfolio #76). It uses
// the Responses API and mirrors the Anthropic adapter: the system prompt goes
// first, the conversation next, and the note last as a developer message, so
// the cached prefix stays the same between the classify and reply calls.
// OpenAI has no server-side refusal fallback, so a refusal ends the turn with
// the fixed "can't help" text.

export interface OpenAIProviderOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** For tests. By default the SDK reads OPENAI_API_KEY. */
  client?: OpenAI;
}

type Response = OpenAI.Responses.Response;

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  const { model, effort } = options;
  // Created on first use, so loading config never needs credentials.
  let client = options.client;
  const sdk = () => (client ??= new OpenAI());

  function baseParams({ system, messages, note }: ModelRequest) {
    const breakpoint = { mode: "explicit" as const };
    const last = messages.length - 1;
    return {
      model,
      // Explicit breakpoints only, placed as in the Anthropic adapter: after the
      // system prompt, and on the latest visitor message so the reply call reads
      // the conversation the classify call wrote. Without explicit mode OpenAI
      // adds its own breakpoint at the end, after the note, which never repeats.
      prompt_cache_options: { mode: "explicit" as const },
      input: [
        { role: "system" as const, content: [{ type: "input_text" as const, text: system, prompt_cache_breakpoint: breakpoint }] },
        ...messages.map((m, i) =>
          i === last && m.role === "user"
            ? { role: m.role, content: [{ type: "input_text" as const, text: m.content, prompt_cache_breakpoint: breakpoint }] }
            : { role: m.role, content: m.content },
        ),
        { role: "developer" as const, content: note },
      ],
      reasoning: { effort },
      // Nothing is stored on OpenAI's side between turns: the widget resends the conversation.
      store: false,
    };
  }

  return {
    async classify<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<ClassifyResult<T>> {
      // No `text.format`: as with the Anthropic adapter, the note asks for JSON
      // and the schema is checked here.
      const response = await sdk().responses.create({ ...baseParams(request), max_output_tokens: 4_000 });
      const usage = usageOf(response);
      if (refused(response)) return { ok: false, reason: "refusal", usage };
      const value = lastMatchingObject(response.output_text, schema);
      return value.ok ? { ok: true, value: value.value, usage } : { ok: false, reason: "invalid", usage };
    },

    async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      const events = await sdk().responses.create({ ...baseParams(request), max_output_tokens: 16_000, stream: true });
      let final: Response | undefined;
      let refusal = false;
      for await (const event of events) {
        if (event.type === "response.output_text.delta") yield { type: "text", text: event.delta };
        else if (event.type === "response.refusal.delta") refusal = true;
        else if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response;
        else if (event.type === "response.failed") throw new Error(`OpenAI response failed: ${event.response.error?.code ?? "unknown"}`);
        else if (event.type === "error") throw new Error(`OpenAI stream error: ${event.code ?? event.message}`);
      }
      if (!final) throw new Error("OpenAI stream ended without a final response");
      yield { type: "end", stopReason: refusal || refused(final) ? "refusal" : stopReason(final), usage: usageOf(final) };
    },
  };
}

function refused(response: Response): boolean {
  if (response.incomplete_details?.reason === "content_filter") return true;
  return response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"));
}

function stopReason(response: Response): "end_turn" | "max_tokens" | "other" {
  if (response.status === "completed") return "end_turn";
  if (response.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return "other";
}

function usageOf(response: Response): Usage {
  const u = response.usage;
  const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    model: response.model,
    // OpenAI's input_tokens includes cached and cache-written tokens; Usage
    // counts them separately, as the Anthropic API does.
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cacheRead - cacheWrite),
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
