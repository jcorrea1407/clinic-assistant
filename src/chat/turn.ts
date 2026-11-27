import { z } from "zod";
import type { PublicFactSheet } from "../facts/schema.js";
import type { ChatMessage, ModelProvider, Usage } from "../model/provider.js";

// One visitor turn, in two model calls:
//   1. classify the latest message into a tier (structured output)
//   2. for every tier except red-flag, stream the reply
// A red flag never reaches step 2: code sends the fixed 911/811 message and
// the conversation ends. The model never writes emergency text.

export type Tier = "red-flag" | "advice-request" | "concern" | "question";

export interface PractitionerLink {
  slug: string;
  /** e.g. "Dr. Priya Nair, chiropractor" */
  label: string;
  bookingUrl: string;
}

export type ChatEvent =
  | { type: "tier"; tier: Tier; practitioners: PractitionerLink[] }
  | { type: "text"; text: string }
  /** Replaces all text sent so far this turn (the reply was declined mid-stream). */
  | { type: "replace"; text: string }
  | { type: "error"; text: string }
  /** `ended`: the conversation is over and the widget should stop taking input. */
  | { type: "done"; ended: boolean };

export interface TurnInput {
  facts: PublicFactSheet;
  systemPrompt: string;
  provider: ModelProvider;
  messages: ChatMessage[];
  onUsage?: (step: "classify" | "reply", usage: Usage) => void;
}

function clinicFact(facts: PublicFactSheet, slug: string): string {
  const fact = facts.collections.clinicFacts.find((f) => f.slug === slug);
  if (!fact) throw new Error(`Fact sheet has no clinic fact "${slug}"`);
  return fact.value;
}

export function classificationSchema(facts: PublicFactSheet) {
  const concerns = facts.collections.concerns.map((c) => c.slug) as [string, ...string[]];
  return z.object({
    tier: z.enum(["red-flag", "advice-request", "concern", "question"]),
    /** The concern this message is about, if it matches one. */
    concern: z.enum(concerns).nullable(),
  });
}

export function classifyNote(facts: PublicFactSheet): string {
  const triggers = facts.collections.redFlagTriggers.map((t) => `- ${t.name}: ${t.examplePhrases}`).join("\n");
  return `Classify the visitor's latest message, reading it in the context of the conversation. Don't reply to the visitor.

tier:
- "red-flag": anything that may be an emergency or need urgent care, including thoughts of self-harm. These examples are a guide, not a full list:
${triggers}
  If you're unsure whether something is a red flag, choose "red-flag".
- "advice-request": asks what to do about a symptom or injury, which treatment, exercise or medication, ice or heat, whether to rest, or what's wrong with them.
- "concern": describes a problem or injury and wants to know who can help or whether the clinic treats it.
- "question": anything else, such as hours, prices, billing, insurance, location, the practitioners, or off-topic messages.

concern: the slug of the concern from the fact sheet that the message is about, or null if none fits.`;
}

export function practitionersFor(facts: PublicFactSheet, concernSlug: string | null): PractitionerLink[] {
  if (!concernSlug) return [];
  const concern = facts.collections.concerns.find((c) => c.slug === concernSlug);
  if (!concern) return [];
  return concern.whoTreats.flatMap((slug) => {
    const p = facts.collections.practitioners.find((x) => x.slug === slug);
    if (!p) return [];
    const title = p.displayTitle.charAt(0).toLowerCase() + p.displayTitle.slice(1);
    const name = p.honorific ? `${p.honorific} ${p.name}` : p.name;
    return [{ slug: p.slug, label: `${name}, ${title}`, bookingUrl: p.bookingUrl }];
  });
}

function replyNote(tier: Exclude<Tier, "red-flag">, practitioners: PractitionerLink[], concern: string | null): string {
  const list = practitioners.map((p) => `- ${p.label}`).join("\n");
  switch (tier) {
    case "concern":
      return practitioners.length
        ? `This message is a concern ("${concern}"). The practitioners for it, shown to the visitor as booking buttons:\n${list}`
        : "This message is a concern that doesn't match any concern in the fact sheet. Say you can't assess symptoms, and offer to pass the question to the front desk.";
    case "advice-request":
      return practitioners.length
        ? `This message asks for treatment advice. Decline, then offer booking. The practitioners for it ("${concern}"), shown as booking buttons:\n${list}`
        : "This message asks for treatment advice. Decline, then offer to book an appointment or to pass a question to the front desk.";
    case "question":
      return "This message is a question. Answer it from the fact sheet only.";
  }
}

export async function* runTurn(input: TurnInput): AsyncGenerator<ChatEvent> {
  const { facts, systemPrompt, provider, messages, onUsage } = input;
  const redFlagMessage = clinicFact(facts, "red-flag-message");
  const phone = clinicFact(facts, "phone");
  const failure = `Sorry, something went wrong on my side. Please call the front desk at ${phone}.`;

  // "Then stop": once the fixed message has been shown, the conversation is over.
  if (messages.some((m) => m.role === "assistant" && m.content === redFlagMessage)) {
    yield { type: "tier", tier: "red-flag", practitioners: [] };
    yield { type: "text", text: redFlagMessage };
    yield { type: "done", ended: true };
    return;
  }

  let classification;
  try {
    classification = await provider.classify(
      { system: systemPrompt, messages, note: classifyNote(facts) },
      classificationSchema(facts),
    );
  } catch (error) {
    console.error("classify failed", error);
    yield { type: "error", text: failure };
    yield { type: "done", ended: false };
    return;
  }
  onUsage?.("classify", classification.usage);
  if (!classification.ok) {
    yield { type: "error", text: failure };
    yield { type: "done", ended: false };
    return;
  }

  const { tier, concern } = classification.value;
  if (tier === "red-flag") {
    yield { type: "tier", tier, practitioners: [] };
    yield { type: "text", text: redFlagMessage };
    yield { type: "done", ended: true };
    return;
  }

  const practitioners = tier === "question" ? [] : practitionersFor(facts, concern);
  yield { type: "tier", tier, practitioners };

  const declined = `Sorry, I can't help with that here. You can ask the front desk at ${phone}.`;
  const cutShort = `Sorry, my answer was cut short. You can ask the front desk at ${phone}.`;
  try {
    for await (const event of provider.stream({
      system: systemPrompt,
      messages,
      note: replyNote(tier, practitioners, concern),
    })) {
      if (event.type === "text") {
        yield event;
      } else if (event.type === "restart") {
        // Clear the declined model's partial text; the fallback's text appends after.
        yield { type: "replace", text: "" };
      } else {
        onUsage?.("reply", event.usage);
        if (event.stopReason === "refusal") yield { type: "replace", text: declined };
        // A cut-off answer can mislead (half a price list), so it never stands.
        else if (event.stopReason === "max_tokens") yield { type: "replace", text: cutShort };
      }
    }
  } catch (error) {
    console.error("reply failed", error);
    yield { type: "replace", text: failure };
  }
  yield { type: "done", ended: false };
}
