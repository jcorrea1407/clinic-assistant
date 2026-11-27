# clinic-assistant

A front-desk assistant for clinics. It answers questions from a clinic's own fact sheet, routes a concern to the practitioner who treats it, shows a fixed emergency message for red flags, and hands everything else to the front desk. Each clinic is a client with its own config. It is deployed as Vercel Functions and embedded with a script-tag widget (coming in a later change).

Upland Physio, Chiro & Massage, a made-up clinic, is the first client.

## Status

Built: per-client config, a validated fact sheet, the model provider seam, a health endpoint, the chat endpoint and the front-desk handoff. Not yet built: the widget.

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Loads and validates every client, returns each client's `id` and `model`. Never calls the model. |
| `POST /api/chat` | One visitor turn, streamed as server-sent events. See [Chat](#chat). |
| `POST /api/handoff` | Emails a visitor's question to the client's front desk, with their consent. Never calls the model. See [Front-desk handoff](#front-desk-handoff). |

## Chat

**Request.** The server stores nothing, so the widget sends the whole conversation every turn:

```json
{ "client": "upland", "messages": [{ "role": "user", "content": "My back hurts. Who should I see?" }] }
```

Limits: 1–20 messages, each up to 2,000 characters, and the last one must be from the visitor.

**Response.** `text/event-stream`, one JSON event per `data:` line:

| Event | Meaning |
|---|---|
| `{ "type": "tier", "tier", "practitioners" }` | Always first, unless there's an error. `practitioners` is `[{ slug, label, bookingUrl }]`; the widget renders them as booking buttons. |
| `{ "type": "text", "text" }` | A piece of the reply. Append it. |
| `{ "type": "replace", "text" }` | Throw away the text so far this turn and show this instead. Sent when the reply is declined or cut off (a fixed message), or with `""` when a fallback model takes over partway, in which case its `text` events follow. |
| `{ "type": "error", "text" }` | A fixed message to show instead of a reply. |
| `{ "type": "done", "ended" }` | Always last. `ended: true` means the conversation is over: stop taking input. |

### The three tiers

Each turn takes two model calls. The first **classifies** the visitor's latest message, using structured output: a `tier` and, if one fits, the `concern` slug from the fact sheet. Code then decides what happens next:

| Tier | What the visitor gets |
|---|---|
| `red-flag` | The fact sheet's fixed `red-flag-message` (911 and Health Link 811), sent by code. The reply model is never called, and `done` carries `ended: true`, so the widget stops taking input. The server stores nothing, so the lock lives in the widget: if a later request's history still contains the red-flag message, the server sends it again, but a cleared history starts over. |
| `concern` | The reply model says it can't assess symptoms and names the practitioners for that concern. Code sends their booking links, so the model never writes a URL. |
| `advice-request` | The reply model declines plainly, then offers booking (with the practitioners for the concern, if one fits) or a question to the front desk. |
| `question` | Answered from the fact sheet only. If the answer isn't there, it says it doesn't know and offers the front desk. |

The model never writes emergency text. If classification fails or is refused, the visitor gets a fixed message with the clinic's phone number, never generated text.

**Why two calls instead of one.** Deciding the tier before any reply exists means a red flag can't leak generated text, and each turn carries a clean label for the model-comparison test set. Both calls start with the same cached system prompt, so the extra call should cost little. That is still to be measured: if the classify call's output schema changes the cached prefix, each call caches the prompt separately (see [Caching](#the-three-tiers)). The cost is a short pause before the reply starts.

**Caching.** The system prompt (rules plus the whole fact sheet, about 32,000 characters) is byte-identical on every request and carries a cache breakpoint. So does the visitor's latest message: the classify call writes the conversation to the cache, and the reply call reads it back. Each call's note goes after the conversation, so it never changes the cached prefix. `npm run try` prints `cache read` per call; from the second call on it should be above zero. Not yet measured: if the reply call's `cache read` is 0 on a first turn, the classify call's structured-output schema is splitting the cache, and the classifier should drop `format` and validate its JSON in code instead.

### Example conversations

`npm run try` runs one conversation per tier against the real model and prints the tier, the reply and token usage. It costs a few cents per run.

<!-- TODO(#72): paste the output of `npm run try` here once ANTHROPIC_API_KEY is available. -->
_Not recorded yet: they need an API key._


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

Locally you can skip the Anthropic key: run `ant auth login` once, and the Anthropic SDK picks up that profile. `.env.example` lists what's expected.

`npm test` never needs the key. `POST /api/chat` and `npm run try` do.

### Deploying

Connect the GitHub repo in the Vercel dashboard (Framework Preset: Other). Every pull request then gets a preview deploy. `vercel.json` sets the build command to `npm run build`, so a bad config or fact sheet fails the deploy.

## How it fits together

```text
api/health.ts                 GET handler (Vercel web-standard fetch export)
api/chat.ts                   POST handler; the logic is in src/chat/
src/chat/turn.ts              one visitor turn: classify, then red flag or streamed reply
src/chat/handler.ts           request validation and server-sent events
src/prompt/system.ts          the system prompt: rules plus the fact sheet
api/handoff.ts                POST handler; the logic is in src/handoff/
src/handoff/                  request schema, the email, the visitor-facing copy
src/mail/                     MailTransport interface and the Resend adapter
clients/index.ts              the list of clients
clients/<id>/config.ts        one client's config
clients/<id>/fact-sheet.json  that client's facts (until the Webflow CMS takes over)
src/config/                   config schema and loader
src/facts/                    fact-sheet schema, FactSource, label helpers
src/model/                    ModelProvider interface and the Anthropic adapter
scripts/check-config.ts       runs in the build
```

**Validated twice.** The build checks every client, and so does each function instance on its first request.

**Fact sheet rules.** Every line is a `public-rule` (an Alberta rule, which must carry a `sourceUrl`) or a `clinic-policy`. Concerns and practitioners must point at each other consistently. Unknown fields are rejected. The loader strips every `internalNote` before the facts can reach the model.

**FactSource.** `localJsonSource` reads the bundled JSON. A Webflow CMS source will replace it without changing anything downstream.

**ModelProvider.** Two calls, both taking `{ system, messages, note }`: `classify(request, zodSchema)` returns structured output, and `stream(request)` yields text (plus a `restart` if a fallback model takes over partway), then a final `end` event with the stop reason and usage. Only `src/model/anthropic.ts` imports the Anthropic SDK, so another vendor is one more adapter. The Anthropic adapter:

- uses the client's configured model (Upland: `claude-opus-5-5`, low effort);
- turns on server-side refusal fallbacks (`server-side-fallback-2026-07-01`, `fallbacks: "default"`): if a safety classifier declines, the API retries on a fallback model in the same call, and `usage.model` says which model answered. The response then holds the declined model's partial output, a `fallback` block, then the fallback's output, so the adapter reads the classification only from after the last `fallback` block, and the stream restarts the reply there;
- sends the note as a mid-conversation system message after the conversation, and sets the cache breakpoints described under [Caching](#the-three-tiers).

## Adding a client

1. Create `clients/<id>/config.ts` (copy `clients/upland/config.ts`) and its `fact-sheet.json`.
2. Add it to `clients/index.ts`.
3. Run `npm run build`. It names the client and field for any error.
