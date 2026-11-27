import { clinicFact } from "../facts/labels.js";
import type { PublicFactSheet } from "../facts/schema.js";

// What the visitor reads around a handoff. The widget imports these so the
// words the visitor consents to live next to the code that sends the email.

export const askButtonLabel = "Ask the front desk";

export function consentLine(clinicName: string): string {
  return `We'll email your question, name and contact details to the front desk at ${clinicName} so they can reply. Nothing is kept on this site.`;
}

export function confirmation(facts: PublicFactSheet): string {
  const replyTime = clinicFact(facts, "reply-time") ?? "The front desk will reply as soon as they can.";
  return `Sent. ${replyTime} They can help with booking and questions about the clinic, not treatment advice.`;
}

export function sendFailed(facts: PublicFactSheet): string {
  return `Sorry, your message couldn't be sent. Please call the front desk at ${clinicFact(facts, "phone")}.`;
}
