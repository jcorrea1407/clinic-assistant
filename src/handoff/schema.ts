import { z } from "zod";

// One line, no control characters: these go into the email's subject and headers.
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\p{Cc}]/u.test(s), "Must be a single line");

export const HandoffBody = z
  .strictObject({
    client: z.string().min(1).max(64),
    /** The visitor ticked the consent box. Anything but `true` is rejected. */
    consent: z.literal(true),
    question: z.string().trim().min(1).max(2_000),
    name: line(100),
    email: z.email().max(254).optional(),
    phone: line(30)
      .refine((s) => /^[+()\d\s.-]+$/.test(s) && (s.match(/\d/g)?.length ?? 0) >= 7, "Enter a phone number")
      .optional(),
    preferredTime: line(200).optional(),
    /** The practitioner the chat suggested, by slug. Checked against the fact sheet. */
    practitioner: z.string().min(1).max(64).optional(),
    /** Hidden from people. A bot that fills it gets a fake success and nothing is sent. */
    website: z.string().max(500).optional(),
  })
  .refine((b) => b.email || b.phone, { message: "Give an email or a phone number", path: ["email"] });

export type HandoffRequest = z.output<typeof HandoffBody>;
