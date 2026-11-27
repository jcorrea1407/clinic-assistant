import { z } from "zod";

// One line: no control characters or Unicode line/paragraph separators,
// because these go into the email's subject.
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s), "Must be a single line");

/** A blank form input arrives as "" (or spaces): treat it as not given. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

export const HandoffBody = z
  .strictObject({
    client: z.string().min(1).max(64),
    /** The visitor ticked the consent box. Anything but `true` is rejected. */
    consent: z.literal(true),
    question: z.string().trim().min(1).max(2_000),
    name: line(100),
    email: optional(z.string().trim().pipe(z.email().max(254))),
    phone: optional(
      line(30).refine((s) => /^[+()\d\s.-]+$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7, "Enter a phone number"),
    ),
    preferredTime: optional(line(200)),
    /** The practitioner the chat suggested, by slug. Checked against the fact sheet. */
    practitioner: optional(z.string().trim().min(1).max(64)),
    /** The honeypot. The handler checks it before validating anything else. */
    website: z.unknown().optional(),
  })
  .refine((b) => b.email || b.phone, { message: "Give an email or a phone number", path: ["email"] });

export type HandoffRequest = z.output<typeof HandoffBody>;
