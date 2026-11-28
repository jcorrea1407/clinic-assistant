// Standard per-million-token prices, in US dollars, used to turn measured
// usage into cost. Check them before quoting a result:
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI:    https://developers.openai.com/api/docs/pricing (checked 2026-11-28)
// Anthropic cache writes (5-minute) are 1.25x input. OpenAI's 30-minute cache
// writes are listed separately.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const anthropic = (input: number, output: number, cacheRead = input * 0.1): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-sonnet-5-5": anthropic(2, 10, 0.1),
  "claude-haiku-5-5": anthropic(0.1, 0.5),
  "claude-fable-5-2": anthropic(8, 40, 0.2),
  "gpt-6.2-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

export interface UsageFields {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Cost in dollars, or undefined when the model has no known price (never guessed as $0). */
export function costOf(model: string, usage: UsageFields): number | undefined {
  const price = PRICES[model] ?? Object.entries(PRICES).find(([id]) => model.startsWith(`${id}-`))?.[1];
  if (!price) return undefined;
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite) /
    1_000_000
  );
}
