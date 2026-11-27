import { z } from "zod";

// The fact sheet mirrors the Webflow CMS collections (ADR 0001 in the portfolio).
// Every line is either a public rule (an Alberta rule with a primary source) or a
// clinic policy (the clinic's own choice).

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words joined by hyphens");
const text = z.string().trim().min(1);
const kind = z.enum(["public-rule", "clinic-policy"]);
const internalNote = z.string().nullable();
const reviewBy = z.iso.date().nullable();
const sourceTitle = z.string().min(1).nullable();
const sourceUrl = z.url({ protocol: /^https$/ }).nullable();

const sourced = {
  kind,
  sourceTitle,
  sourceUrl,
};

const ClinicFact = z.strictObject({
  name: text,
  slug,
  category: slug,
  value: text,
  ...sourced,
  reviewBy,
  internalNote,
});

const Concern = z.strictObject({
  name: text,
  slug,
  summary: text,
  commonExamples: text,
  whoTreats: z.array(slug).min(1),
  startWith: text,
  kind,
  internalNote,
});

const Practitioner = z.strictObject({
  name: text,
  slug,
  honorific: z.string().min(1).nullable(),
  profession: z.enum(["physiotherapist", "chiropractor", "massage-therapist"]),
  displayTitle: text,
  areasOfPractice: text,
  bio: text,
  concerns: z.array(slug).min(1),
  languages: text,
  bookingUrl: z.string().min(1),
  portraitAlt: text,
  kind,
  internalNote,
});

const Faq = z.strictObject({
  name: text,
  slug,
  category: slug,
  answer: text,
  ...sourced,
  reviewBy,
  internalNote,
});

const RedFlagTrigger = z.strictObject({
  name: text,
  slug,
  examplePhrases: text,
  ...sourced,
  internalNote,
});

const Collections = z.strictObject({
  clinicFacts: z.array(ClinicFact).min(1),
  concerns: z.array(Concern).min(1),
  practitioners: z.array(Practitioner).min(1),
  faq: z.array(Faq),
  redFlagTriggers: z.array(RedFlagTrigger).min(1),
});

export const FactSheetSchema = z
  .strictObject({
    meta: z.looseObject({ clinic: text }),
    collections: Collections,
  })
  .superRefine((sheet, ctx) => {
    const { collections } = sheet;

    // The chat endpoint prints these itself, so every sheet must have them.
    for (const required of ["red-flag-message", "phone"]) {
      if (!collections.clinicFacts.some((f) => f.slug === required)) {
        ctx.addIssue({
          code: "custom",
          path: ["collections", "clinicFacts"],
          message: `Missing the required clinic fact "${required}"`,
        });
      }
    }

    // A public rule must say where it comes from. Concerns and practitioners have
    // no source fields, so they can only be clinic policy.
    for (const [name, lines] of Object.entries(collections)) {
      lines.forEach((line, i) => {
        if (line.kind !== "public-rule") return;
        if (!("sourceUrl" in line) || !line.sourceUrl) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", name, i, "sourceUrl"],
            message: `"${line.slug}" is a public-rule, so it needs a sourceUrl`,
          });
        }
      });
    }

    for (const [name, lines] of Object.entries(collections)) {
      const seen = new Set<string>();
      lines.forEach((line, i) => {
        if (seen.has(line.slug)) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", name, i, "slug"],
            message: `Duplicate slug "${line.slug}" in ${name}`,
          });
        }
        seen.add(line.slug);
      });
    }

    // Concerns and practitioners point at each other. Both directions must agree,
    // or the assistant would route a concern to someone who doesn't list it.
    const practitioners = new Map(collections.practitioners.map((p) => [p.slug, p]));
    const concerns = new Map(collections.concerns.map((c) => [c.slug, c]));

    collections.concerns.forEach((concern, i) => {
      concern.whoTreats.forEach((who, j) => {
        const practitioner = practitioners.get(who);
        if (!practitioner) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", "concerns", i, "whoTreats", j],
            message: `"${concern.slug}" lists unknown practitioner "${who}"`,
          });
        } else if (!practitioner.concerns.includes(concern.slug)) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", "concerns", i, "whoTreats", j],
            message: `"${concern.slug}" lists "${who}", but "${who}" doesn't list "${concern.slug}"`,
          });
        }
      });
    });

    collections.practitioners.forEach((practitioner, i) => {
      practitioner.concerns.forEach((slug, j) => {
        const concern = concerns.get(slug);
        if (!concern) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", "practitioners", i, "concerns", j],
            message: `"${practitioner.slug}" lists unknown concern "${slug}"`,
          });
        } else if (!concern.whoTreats.includes(practitioner.slug)) {
          ctx.addIssue({
            code: "custom",
            path: ["collections", "practitioners", i, "concerns", j],
            message: `"${practitioner.slug}" lists "${slug}", but "${slug}" doesn't list "${practitioner.slug}"`,
          });
        }
      });
    });
  });

export type FactSheet = z.infer<typeof FactSheetSchema>;
type Collections = FactSheet["collections"];

type WithoutNote<T> = { [K in keyof T]: Omit<T[K] extends (infer L)[] ? L : never, "internalNote">[] };

/** What the assistant is allowed to see: every line minus its editor-only note. */
export interface PublicFactSheet {
  clinic: string;
  collections: WithoutNote<Collections>;
}

export function toPublic(sheet: FactSheet): PublicFactSheet {
  const strip = <L extends { internalNote: string | null }>(lines: L[]): Omit<L, "internalNote">[] =>
    lines.map(({ internalNote: _note, ...line }) => line);

  const c = sheet.collections;
  return {
    clinic: sheet.meta.clinic,
    collections: {
      clinicFacts: strip(c.clinicFacts),
      concerns: strip(c.concerns),
      practitioners: strip(c.practitioners),
      faq: strip(c.faq),
      redFlagTriggers: strip(c.redFlagTriggers),
    },
  };
}
