import type { ClientConfigInput } from "../../src/config/schema.js";
import factSheet from "./fact-sheet.json" with { type: "json" };

// Upland is a made-up clinic, the concept case study for this product.
// fact-sheet.json is a snapshot of the portfolio's docs/case-study-2/fact-sheet.json
// (as of portfolio PR #90). #82 replaces it with the live Webflow CMS.

export default {
  id: "upland",
  name: "Upland Physio, Chiro & Massage",
  facts: { kind: "local-json", data: factSheet },
  // Placeholder until the demo inbox exists (portfolio #83).
  frontDeskInbox: "frontdesk@upland.example",
  // Placeholder until Upland's brand is set in its Figma file.
  brandColour: "#2f6f5e",
  model: { provider: "anthropic", id: "claude-opus-5-5", effort: "low" },
} satisfies ClientConfigInput;
