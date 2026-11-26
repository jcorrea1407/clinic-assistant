import { z } from "zod";

const FactsSource = z.discriminatedUnion("kind", [
  // The sheet is imported into the client's config.ts, so it ships with the deploy.
  z.strictObject({ kind: z.literal("local-json"), data: z.unknown() }),
]);

const Model = z.strictObject({
  provider: z.literal("anthropic"),
  id: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
});

export const ClientConfigSchema = z.strictObject({
  /** Used in URLs and logs. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words joined by hyphens"),
  name: z.string().trim().min(1),
  facts: FactsSource,
  /** The one inbox that receives handoffs. Never a practitioner's own address. */
  frontDeskInbox: z.email(),
  /** Accent colour for the widget, as #rrggbb. */
  brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1f6f5c"),
  model: Model,
});

export type ClientConfigInput = z.input<typeof ClientConfigSchema>;
export type ClientConfig = z.output<typeof ClientConfigSchema>;
export type ModelConfig = ClientConfig["model"];
