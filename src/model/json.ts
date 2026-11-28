import type { z } from "zod";

// Shared by every adapter: classify answers are read from plain text, never
// from a vendor's structured-output mode (see the Caching section of the README).

/** Every top-level balanced {...} span in the text, in order. Braces inside strings are skipped. */
export function jsonObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth++ === 0) start = i;
    } else if (ch === "}" && depth > 0) {
      if (--depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

/**
 * The last object in the text that matches the schema, so a code fence, a
 * sentence, or an echoed template around the answer doesn't matter.
 */
export function lastMatchingObject<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false } {
  for (const candidate of jsonObjects(text).reverse()) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
  }
  return { ok: false };
}
