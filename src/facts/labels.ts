import type { PublicFactSheet } from "./schema.js";

type Practitioner = PublicFactSheet["collections"]["practitioners"][number];

/** "Dr. Priya Nair, chiropractor" or "Hannah Brooks, registered massage therapist (RMT)". */
export function practitionerLabel(p: Practitioner): string {
  const title = p.displayTitle.charAt(0).toLowerCase() + p.displayTitle.slice(1);
  const name = p.honorific ? `${p.honorific} ${p.name}` : p.name;
  return `${name}, ${title}`;
}

/** A clinic fact's value. The fact sheet schema guarantees the required ones exist. */
export function clinicFact(facts: PublicFactSheet, slug: string): string | undefined {
  return facts.collections.clinicFacts.find((f) => f.slug === slug)?.value;
}
