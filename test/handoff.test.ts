import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandoffHandler } from "../src/handoff/handler.js";
import { consentLine } from "../src/handoff/copy.js";
import { createResendTransport } from "../src/mail/resend.js";
import { logTransport, MailError, mailTransportFromEnv, type MailMessage, type MailTransport } from "../src/mail/transport.js";

const visitor = {
  client: "upland",
  consent: true,
  question: "Can I book a Saturday appointment for my back?",
  name: "Sam Visitor",
  email: "sam.visitor@example.com",
  phone: "403-555-0199",
  preferredTime: "Saturday morning",
  practitioner: "priya-nair",
};

const post = (body: unknown) =>
  new Request("https://example.test/api/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function fakeTransport(fail?: Error) {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    async send(message) {
      if (fail) throw fail;
      sent.push(message);
      return { id: "email_123" };
    },
  };
  return { transport, sent };
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

/** Fails if anything the visitor typed reached the logs. */
function expectNoVisitorDataLogged() {
  const all = logged.join("\n");
  for (const value of [visitor.question, visitor.name, "Sam", visitor.email, visitor.phone, visitor.preferredTime]) {
    expect(all).not.toContain(value);
  }
}

describe("POST /api/handoff", () => {
  it("emails the front desk, tagged with the practitioner, and confirms with the reply time", async () => {
    const { transport, sent } = fakeTransport();
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(visitor));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      message:
        "Sent. The front desk replies to messages within one business day. They can help with booking and questions about the clinic, not treatment advice.",
    });
    expect(sent).toHaveLength(1);
    const email = sent[0]!;
    expect(email.to).toBe("frontdesk@upland.example");
    expect(email.replyTo).toBe(visitor.email);
    expect(email.subject).toBe("[Dr. Priya Nair, chiropractor] Website question from Sam Visitor");
    for (const value of [visitor.question, visitor.phone, visitor.preferredTime]) expect(email.text).toContain(value);
    expect(email.text).toContain("Sent with the visitor's consent by the website assistant. Not stored.");
  });

  it("logs only the client, the outcome and the email id", async () => {
    const { transport } = fakeTransport();
    await createHandoffHandler({ transport, env: {} }).fetch(post(visitor));
    expect(logged).toEqual([JSON.stringify({ client: "upland", ok: true, emailId: "email_123" })]);
  });

  it("works with only a phone number, and says so in the email", async () => {
    const { transport, sent } = fakeTransport();
    const { email: _email, practitioner: _p, ...phoneOnly } = visitor;
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(phoneOnly));

    expect(response.status).toBe(200);
    expect(sent[0]!.replyTo).toBeUndefined();
    expect(sent[0]!.subject).toBe("[No practitioner] Website question from Sam Visitor");
    expect(sent[0]!.text).toContain("Call them at 403-555-0199");
  });

  it("sends to HANDOFF_TO_OVERRIDE and from MAIL_FROM when they're set", async () => {
    const { transport, sent } = fakeTransport();
    const env = { HANDOFF_TO_OVERRIDE: "demo@inbox.test", MAIL_FROM: "Upland <assistant@mail.test>" };
    await createHandoffHandler({ transport, env }).fetch(post(visitor));
    expect(sent[0]).toMatchObject({ to: "demo@inbox.test", from: "Upland <assistant@mail.test>" });
  });

  it.each([
    ["not JSON", "{"],
    ["no consent", { ...visitor, consent: undefined }],
    ["consent as a string", { ...visitor, consent: "true" }],
    ["consent false", { ...visitor, consent: false }],
    ["no email and no phone", { ...visitor, email: undefined, phone: undefined }],
    ["a bad email", { ...visitor, email: "sam@" }],
    ["a phone with letters", { ...visitor, phone: "call me maybe" }],
    ["a name with a line break", { ...visitor, name: "Sam\r\nBcc: x@y.z" }],
    ["a name with a Unicode line separator", { ...visitor, name: "Sam Urgent" }],
    ["no name", { ...visitor, name: undefined }],
    ["an empty question", { ...visitor, question: "   " }],
    ["a question over 2,000 characters", { ...visitor, question: "x".repeat(2001) }],
    ["an unknown field", { ...visitor, notes: "hi" }],
    ["an unknown practitioner", { ...visitor, practitioner: "dr-nobody" }],
  ])("rejects %s with a 400 and sends nothing", async (_name, body) => {
    const { transport, sent } = fakeTransport();
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(body));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("treats blank optional fields, as an HTML form sends them, as not given", async () => {
    const { transport, sent } = fakeTransport();
    const body = { ...visitor, email: " ", preferredTime: "", practitioner: "", website: "" };
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(body));
    expect(response.status).toBe(200);
    expect(sent[0]!.replyTo).toBeUndefined();
    expect(sent[0]!.subject).toBe("[No practitioner] Website question from Sam Visitor");
  });

  it("trims an autofilled email", async () => {
    const { transport, sent } = fakeTransport();
    await createHandoffHandler({ transport, env: {} }).fetch(post({ ...visitor, email: " sam.visitor@example.com " }));
    expect(sent[0]!.replyTo).toBe("sam.visitor@example.com");
  });

  it("returns 404 for an unknown client", async () => {
    const { transport } = fakeTransport();
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post({ ...visitor, client: "nope" }));
    expect(response.status).toBe(404);
  });

  it("only answers POST", async () => {
    const response = await createHandoffHandler({ env: {} }).fetch(new Request("https://example.test/api/handoff"));
    expect(response.status).toBe(405);
  });

  it.each([
    ["a valid body", { ...visitor, website: "spam.example" }],
    ["an unknown client and practitioner", { ...visitor, client: "nope", practitioner: "x", website: "spam.example" }],
    ["a non-string honeypot", { website: 12345 }],
  ])("gives a bot that fills the hidden field a success with %s, and sends nothing", async (_name, body) => {
    const { transport, sent } = fakeTransport();
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(sent).toHaveLength(0);
    expectNoVisitorDataLogged();
  });

  it("tells the visitor to call when sending fails, and logs nothing they typed", async () => {
    const { transport } = fakeTransport(new Error(`smtp said no to ${visitor.email}`));
    const response = await createHandoffHandler({ transport, env: {} }).fetch(post(visitor));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Sorry, your message couldn't be sent. Please call the front desk at 403-555-0142.",
    });
    expectNoVisitorDataLogged();
  });

  it.each([
    ["on Vercel", { VERCEL: "1" }],
    ["anywhere else", {}],
    ["on Vercel even with MAIL_LOG_ONLY", { VERCEL: "1", MAIL_LOG_ONLY: "1" }],
  ])("fails closed %s when RESEND_API_KEY is missing", async (_name, env) => {
    const response = await createHandoffHandler({ env }).fetch(post(visitor));
    expect(response.status).toBe(502);
    expect(logged.join("\n")).toContain("RESEND_API_KEY is not set");
    expectNoVisitorDataLogged();
  });
});

describe("mail transport from env", () => {
  it("prints instead of sending only when MAIL_LOG_ONLY=1, off Vercel", async () => {
    expect(await mailTransportFromEnv({ MAIL_LOG_ONLY: "1" })).toBe(logTransport);
  });

  it.each([
    ["no settings", {}],
    ["Vercel", { VERCEL: "1" }],
  ])("refuses to send without a key, with %s", async (_name, env) => {
    const transport = await mailTransportFromEnv(env);
    await expect(transport.send({ to: "a@b.c", from: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(MailError);
  });
});

describe("the Resend transport", () => {
  const message: MailMessage = { to: "desk@x.test", from: "a@x.test", replyTo: "sam@x.test", subject: "s", text: "t" };

  it("sends the message and returns Resend's id", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "re_1" }, error: null, headers: null });
    const { id } = await createResendTransport("key", { send }).send(message);
    expect(id).toBe("re_1");
    expect(send).toHaveBeenCalledWith({ to: "desk@x.test", from: "a@x.test", replyTo: "sam@x.test", subject: "s", text: "t" });
  });

  it("turns Resend's error into a MailError that doesn't quote the addresses", async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Invalid `to`: desk@x.test", statusCode: 422 },
      headers: null,
    });
    const failure = createResendTransport("key", { send }).send(message);
    await expect(failure).rejects.toThrow(MailError);
    await expect(failure).rejects.not.toThrow(/desk@x\.test/);
  });
});

describe("the consent line", () => {
  it("says what is sent, to whom, and that nothing is kept", () => {
    expect(consentLine("Upland Physio, Chiro & Massage")).toBe(
      "We'll email your question, name and contact details to the front desk at Upland Physio, Chiro & Massage so they can reply. Nothing is kept on this site.",
    );
  });
});
