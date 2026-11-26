import { z } from "zod";
import { FactSheetSchema, toPublic, type PublicFactSheet } from "./schema.js";

/**
 * Where a client's facts come from. The rest of the app only sees the
 * validated, note-free sheet, so swapping the source (local JSON now, the
 * Webflow CMS in #82) changes nothing downstream.
 */
export interface FactSource {
  load(): Promise<PublicFactSheet>;
}

export class FactSheetError extends Error {
  override name = "FactSheetError";
}

/** Validates a sheet and strips internal notes. Throws FactSheetError. */
export function parseFactSheet(raw: unknown): PublicFactSheet {
  const result = FactSheetSchema.safeParse(raw);
  if (!result.success) {
    throw new FactSheetError(z.prettifyError(result.error));
  }
  return toPublic(result.data);
}

/** A fact sheet bundled with the deploy, e.g. `clients/upland/fact-sheet.json`. */
export function localJsonSource(raw: unknown): FactSource {
  return {
    async load() {
      return parseFactSheet(raw);
    },
  };
}
