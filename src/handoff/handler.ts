import { z } from "zod";
import { getClients } from "../config/load.js";
import { practitionerLabel } from "../facts/labels.js";
import { MailError, mailTransportFromEnv, type MailTransport } from "../mail/transport.js";
import { confirmation, sendFailed } from "./copy.js";
import { buildHandoffEmail } from "./email.js";
import { HandoffBody } from "./schema.js";

// POST /api/handoff
// Emails the visitor's question to the client's front desk, with their consent.
// Never calls the model, stores nothing, and logs no field the visitor typed:
// only { client, ok, emailId }.

type Env = Record<string, string | undefined>;

/** Resend's shared test sender. It only delivers to the Resend account's own address. */
const defaultFrom = "Clinic assistant <onboarding@resend.dev>";

export function createHandoffHandler(options: { transport?: MailTransport; env?: Env } = {}) {
  const env = options.env ?? process.env;
  let transport: Promise<MailTransport> | undefined = options.transport && Promise.resolve(options.transport);

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
      }

      let json: unknown;
      try {
        json = await request.json();
      } catch {
        return Response.json({ error: "Body must be JSON" }, { status: 400 });
      }
      const body = HandoffBody.safeParse(json);
      if (!body.success) {
        return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });
      }

      let client;
      try {
        client = (await getClients()).find((c) => c.config.id === body.data.client);
      } catch (error) {
        console.error(error);
        return Response.json({ error: "Client config failed validation" }, { status: 500 });
      }
      if (!client) return Response.json({ error: "Unknown client" }, { status: 404 });
      const { config, facts } = client;

      let practitioner: string | null = null;
      if (body.data.practitioner) {
        const p = facts.collections.practitioners.find((x) => x.slug === body.data.practitioner);
        if (!p) return Response.json({ error: "Unknown practitioner" }, { status: 400 });
        practitioner = practitionerLabel(p);
      }

      if (body.data.website) {
        console.log(JSON.stringify({ client: config.id, ok: true, emailId: null, skipped: "honeypot" }));
        return Response.json({ ok: true, message: confirmation(facts) });
      }

      const message = buildHandoffEmail({
        config,
        request: body.data,
        practitioner,
        to: env.HANDOFF_TO_OVERRIDE || config.frontDeskInbox,
        from: env.MAIL_FROM || defaultFrom,
      });

      try {
        transport ??= mailTransportFromEnv(env);
        const { id } = await (await transport).send(message);
        console.log(JSON.stringify({ client: config.id, ok: true, emailId: id }));
        return Response.json({ ok: true, message: confirmation(facts) });
      } catch (error) {
        // MailError messages never carry content; anything else is reduced to its name.
        const reason = error instanceof MailError ? error.message : error instanceof Error ? error.name : "unknown";
        console.error(JSON.stringify({ client: config.id, ok: false, emailId: null, reason }));
        return Response.json({ ok: false, error: sendFailed(facts) }, { status: 502 });
      }
    },
  };
}
