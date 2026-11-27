import type { ClientConfig } from "../config/schema.js";
import type { MailMessage } from "../mail/transport.js";
import type { HandoffRequest } from "./schema.js";

/** The email the front desk receives. `practitioner` is the label, already checked. */
export function buildHandoffEmail(args: {
  config: ClientConfig;
  request: HandoffRequest;
  practitioner: string | null;
  to: string;
  from: string;
}): MailMessage {
  const { config, request, practitioner, to, from } = args;
  const { name, email, phone, preferredTime, question } = request;

  const contact = [
    `Name: ${name}`,
    email && `Email: ${email}`,
    phone && `Phone: ${phone}`,
    preferredTime && `Preferred time: ${preferredTime}`,
    `Suggested practitioner: ${practitioner ?? "none"}`,
  ].filter(Boolean);

  const howToReply = email ? `Reply to this email to answer ${name} directly.` : `${name} left no email. Call them at ${phone}.`;

  return {
    to,
    from,
    ...(email ? { replyTo: email } : {}),
    subject: `[${practitioner ?? "No practitioner"}] Website question from ${name}`,
    text: [
      `${name} asked a question on the ${config.name} website.`,
      "",
      "Question:",
      question,
      "",
      ...contact,
      "",
      howToReply,
      "",
      "--",
      "Sent with the visitor's consent by the website assistant. Not stored.",
    ].join("\n"),
  };
}
