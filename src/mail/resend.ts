import { Resend } from "resend";
import { MailError, type MailTransport } from "./transport.js";

type EmailsApi = Pick<Resend["emails"], "send">;

// Resend's error messages can quote the addresses, so only error names ever
// make it into a MailError (and from there into the logs).

export function createResendTransport(apiKey: string, emails: EmailsApi = new Resend(apiKey).emails): MailTransport {
  return {
    async send(message) {
      let result: Awaited<ReturnType<EmailsApi["send"]>>;
      try {
        result = await emails.send({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        });
      } catch (error) {
        throw new MailError(`Resend request failed (${error instanceof Error ? error.name : "unknown"})`);
      }
      const { data, error } = result;
      if (error || !data) throw new MailError(`Resend refused the email (${error?.name ?? "no data"})`);
      return { id: data.id };
    },
  };
}
