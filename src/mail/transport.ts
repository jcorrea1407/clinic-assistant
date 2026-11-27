// The mail seam. Only src/mail/resend.ts imports a mail provider's SDK.

export interface MailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  /** Sends one email. Resolves with the provider's id, or throws MailError. */
  send(message: MailMessage): Promise<{ id: string }>;
}

/** Never carries message content, so it is safe to log. */
export class MailError extends Error {
  override name = "MailError";
}

/** Prints the email instead of sending it. Local development only. */
export const logTransport: MailTransport = {
  async send(message) {
    console.log(`\n--- email (not sent: MAIL_LOG_ONLY=1) ---\n${JSON.stringify(message, null, 2)}\n---`);
    return { id: "local-log" };
  },
};

const notConfigured: MailTransport = {
  async send() {
    throw new MailError("RESEND_API_KEY is not set, so handoffs can't be sent");
  },
};

type Env = Record<string, string | undefined>;

/**
 * With a key, sends through Resend. Without one it fails closed, so a visitor
 * is never told a message was sent when it wasn't. MAIL_LOG_ONLY=1 prints the
 * email instead, for local development; it is ignored on Vercel.
 */
export async function mailTransportFromEnv(env: Env = process.env): Promise<MailTransport> {
  if (env.RESEND_API_KEY) {
    const { createResendTransport } = await import("./resend.js");
    return createResendTransport(env.RESEND_API_KEY);
  }
  return env.MAIL_LOG_ONLY === "1" && !env.VERCEL ? logTransport : notConfigured;
}
