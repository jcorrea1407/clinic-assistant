import { z } from "zod";
import { practitionerLabel } from "../facts/labels.js";
import type { PublicFactSheet } from "../facts/schema.js";
import type { ChatMessage, ModelProvider, Usage } from "../model/provider.js";

// One visitor turn, in two model calls:
//   1. classify the latest message into a tier (JSON, checked against a schema)
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
    /**
     * The concern this message is about, if it matches one. Lenient on purpose:
     * a missing or unknown slug becomes null, so a bad concern can never sink a
     * red-flag tier.
     */
    concern: z.enum(concerns).nullable().catch(null),
  });
}

export function classifyNote(facts: PublicFactSheet): string {
  const triggers = facts.collections.redFlagTriggers.map((t) => `- ${t.name}: ${t.examplePhrases}`).join("\n");
  const concerns = facts.collections.concerns.map((c) => c.slug).join(", ");
  return `Classify the visitor's latest message, reading it in the context of the conversation. Don't reply to the visitor.

tier:
- "red-flag": anything that may be an emergency or need urgent care, including thoughts of self-harm. These examples are a guide, not a full list:
${triggers}
  If you're unsure whether something is a red flag, choose "red-flag".
- "advice-request": asks what to do about a symptom or injury, which treatment, exercise or medication, ice or heat, whether to rest, or what's wrong with them.
- "concern": describes a problem or injury and wants to know who can help or whether the clinic treats it.
- "question": anything else, such as hours, prices, billing, insurance, location, the practitioners, or off-topic messages.

concern: the slug of the concern from the fact sheet that the message is about, or null if none fits. The slugs: ${concerns}.

Answer with only this JSON object, no code fence and no other text:
{"tier": "red-flag" | "advice-request" | "concern" | "question", "concern": "<slug>" | null}`;
}

export function practitionersFor(facts: PublicFactSheet, concernSlug: string | null): PractitionerLink[] {
  if (!concernSlug) return [];
  const concern = facts.collections.concerns.find((c) => c.slug === concernSlug);
  if (!concern) return [];
  return concern.whoTreats.flatMap((slug) => {
    const p = facts.collections.practitioners.find((x) => x.slug === slug);
    if (!p) return [];
    return [{ slug: p.slug, label: practitionerLabel(p), bookingUrl: p.bookingUrl }];
  });
}

// Booking buttons appear only when the note lists practitioners. Every other
// note says so, or the model points the visitor to buttons that aren't there
// (the most common failure in the model comparison, portfolio #76).
const NO_BUTTONS =
  "No booking buttons are shown with this reply, so don't mention buttons. If the visitor wants to book, offer to pass a question to the front desk.";

function replyNote(tier: Exclude<Tier, "red-flag">, practitioners: PractitionerLink[], concern: string | null): string {
  const list = practitioners.map((p) => `- ${p.label}`).join("\n");
  switch (tier) {
    case "concern":
      return practitioners.length
        ? `This message is a concern ("${concern}"). The practitioners for it, shown to the visitor as booking buttons:\n${list}`
        : `This message is a concern that doesn't match any concern in the fact sheet. Say you can't assess symptoms, and offer to pass the question to the front desk. ${NO_BUTTONS}`;
    case "advice-request":
      return practitioners.length
        ? `This message asks for treatment advice. Decline, then offer booking. The practitioners for it ("${concern}"), shown as booking buttons:\n${list}`
        : `This message asks for treatment advice. Decline, then offer to pass a question to the front desk. ${NO_BUTTONS}`;
    case "question":
      return `This message is a question. Answer it from the fact sheet only. ${NO_BUTTONS}`;
  }
}

async function classifyOnce({ facts, systemPrompt, provider, messages }: TurnInput) {
  try {
    return await provider.classify(
      { system: systemPrompt, messages, note: classifyNote(facts) },
      classificationSchema(facts),
    );
  } catch (error) {
    console.error("classify failed", error);
    return undefined;
  }
}

export async function* runTurn(input: TurnInput): AsyncGenerator<ChatEvent> {
  const { facts, systemPrompt, provider, messages, onUsage } = input;
  const redFlagMessage = clinicFact(facts, "red-flag-message");
  const phone = clinicFact(facts, "phone");
  // Shown when classification fails, so the message might have been an emergency.
  const failure = `Sorry, something went wrong on my side. If this may be an emergency, call 911. Otherwise, please call the front desk at ${phone}.`;

  // "Then stop": once the fixed message has been shown, the conversation is over.
  if (messages.some((m) => m.role === "assistant" && m.content === redFlagMessage)) {
    yield { type: "tier", tier: "red-flag", practitioners: [] };
    yield { type: "text", text: redFlagMessage };
    yield { type: "done", ended: true };
    return;
  }

  // Two tries: output that didn't parse, or a thrown error, gets one retry.
  // A refusal doesn't, since asking again won't change it.
  let classification: Awaited<ReturnType<typeof classifyOnce>> | undefined;
  for (let attempt = 0; attempt < 2 && !classification?.ok; attempt++) {
    classification = await classifyOnce(input);
    if (classification?.usage) onUsage?.("classify", classification.usage);
    if (classification && !classification.ok && classification.reason === "refusal") break;
  }
  if (!classification?.ok) {
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
