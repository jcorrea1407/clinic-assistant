# clinic-assistant

A front-desk assistant for clinics. It answers questions from a clinic's own fact sheet, routes a concern to the practitioner who treats it, shows a fixed emergency message for red flags, and hands everything else to the front desk. Each clinic is a client with its own config. It is deployed as Vercel Functions and embedded with a script-tag widget (coming in a later change).

Upland Physio, Chiro & Massage, a made-up clinic, is the first client.

## Status

Built: per-client config, a validated fact sheet, the model provider seam, a health endpoint and the front-desk handoff. The chat endpoint is in review (PR #2), and the widget comes later.

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Loads and validates every client, returns each client's `id` and `model`. Never calls the model. |
| `POST /api/handoff` | Emails a visitor's question to the client's front desk, with their consent. Never calls the model. See [Front-desk handoff](#front-desk-handoff). |

## Front-desk handoff

The widget always shows an **Ask the front desk** button. It opens a short form with a consent line, and the visitor must tick it before anything is sent:

> We'll email your question, name and contact details to the front desk at Upland Physio, Chiro & Massage so they can reply. Nothing is kept on this site.

**Request.**

```json
{
  "client": "upland",
  "consent": true,
  "question": "Can I book a Saturday appointment?",
  "name": "Sam",
  "email": "sam@example.com",
  "phone": "403-555-0199",
  "preferredTime": "Saturday morning",
  "practitioner": "priya-nair"
}
```

`consent` must be the boolean `true`, checked on the server, not just in the widget. `email` or `phone` is required, and the other fields are optional. `practitioner` is the slug the chat suggested, and it must exist in the fact sheet. `website` is a honeypot hidden from people: if a bot fills it, it gets a normal-looking success and nothing is sent. Name, phone and preferred time must be single lines; the question can be up to 2,000 characters.

**Response.** `200 { ok: true, message }`, where `message` is the confirmation to show: "Sent. The front desk replies to messages within one business day. They can help with booking and questions about the clinic, not treatment advice." If sending fails, it returns `502 { ok: false, error }` with a fixed message giving the clinic's phone number. Bad input gets a `400`.

**The email** goes to the client's `frontDeskInbox`. Its subject is tagged with the suggested practitioner, as in `[Dr. Priya Nair, chiropractor] Website question from Sam`, or `[No practitioner] …`. Reply-to is the visitor's email, so the front desk answers by replying. The footer says it was sent with the visitor's consent and isn't stored.

**Nothing is stored, and logs carry no visitor data.** Each handoff logs only `{ client, ok, emailId }`, and a test fails if any submitted field reaches the logs.

**MailTransport.** Only `src/mail/resend.ts` imports the Resend SDK. Without `RESEND_API_KEY`, a local run prints the email to the terminal instead, and a Vercel deploy refuses to send, so a visitor is never told a message went when it didn't.

Rate limiting will be set with Vercel's firewall when the site ships, and CORS when the widget is built.

## Setup

Needs Node.js 20 or later locally (Vercel runs Node 24, set in `package.json` `engines`).

```bash
npm install
npm test          # vitest; never calls the API
npm run build     # type-check, then validate every client config and fact sheet
```

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Vercel (Preview and Production) | Claude API key. Never commit it. |
| `RESEND_API_KEY` | Vercel (Preview and Production) | Sends handoff emails. Without it, a deploy refuses handoffs and a local run prints them. |
| `MAIL_FROM` | Vercel, optional | The sender, as `Name <address>` on a domain verified in Resend. Defaults to Resend's test sender, `onboarding@resend.dev`. |
| `HANDOFF_TO_OVERRIDE` | Vercel, optional | Sends every handoff to this address instead of the client's `frontDeskInbox`. For the demo, while the inboxes are placeholders. |

Until a domain is verified in Resend, its test sender only delivers to the address on your Resend account, so set `HANDOFF_TO_OVERRIDE` to that address.

Locally you can skip the key: run `ant auth login` once, and the Anthropic SDK picks up that profile. `.env.example` lists what's expected.

Nothing in this change calls the model, so the key is only needed from the chat endpoint on.

### Deploying

Connect the GitHub repo in the Vercel dashboard (Framework Preset: Other). Every pull request then gets a preview deploy. `vercel.json` sets the build command to `npm run build`, so a bad config or fact sheet fails the deploy.

## How it fits together

```text
api/health.ts                 GET handler (Vercel web-standard fetch export)
api/handoff.ts                POST handler; the logic is in src/handoff/
src/handoff/                  request schema, the email, the visitor-facing copy
src/mail/                     MailTransport interface and the Resend adapter
clients/index.ts              the list of clients
clients/<id>/config.ts        one client's config
clients/<id>/fact-sheet.json  that client's facts (until the Webflow CMS takes over)
src/config/                   config schema and loader
src/facts/                    fact-sheet schema and FactSource
src/model/                    ModelProvider interface and the Anthropic adapter
scripts/check-config.ts       runs in the build
```

**Validated twice.** The build checks every client, and so does each function instance on its first request.

**Fact sheet rules.** Every line is a `public-rule` (an Alberta rule, which must carry a `sourceUrl`) or a `clinic-policy`. Concerns and practitioners must point at each other consistently. Unknown fields are rejected. The loader strips every `internalNote` before the facts can reach the model.

**FactSource.** `localJsonSource` reads the bundled JSON. A Webflow CMS source will replace it without changing anything downstream.

**ModelProvider.** One call: `complete({ system, messages })`. Only `src/model/anthropic.ts` imports the Anthropic SDK, so another vendor is one more adapter. The Anthropic adapter:

- uses the client's configured model (Upland: `claude-opus-5-5`, low effort);
- turns on server-side refusal fallbacks (`server-side-fallback-2026-07-01`, `fallbacks: "default"`): if a safety classifier declines, the API retries on a fallback model in the same call, and `Completion.model` says which model answered;
- caches the system prompt, which holds the fact sheet and is the same on every turn.

## Adding a client

1. Create `clients/<id>/config.ts` (copy `clients/upland/config.ts`) and its `fact-sheet.json`.
2. Add it to `clients/index.ts`.
3. Run `npm run build`. It names the client and field for any error.
