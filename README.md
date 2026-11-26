# clinic-assistant

A front-desk assistant for clinics. It answers questions from a clinic's own fact sheet, routes a concern to the practitioner who treats it, shows a fixed emergency message for red flags, and hands everything else to the front desk. Each clinic is a client with its own config. It is deployed as Vercel Functions and embedded with a script-tag widget (coming in a later change).

Upland Physio, Chiro & Massage, a made-up clinic, is the first client.

## Status

The scaffold is done: per-client config, a validated fact sheet, the model provider seam and a health endpoint. There's no chat endpoint yet.

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Loads and validates every client, returns each client's `id` and `model`. Never calls the model. |

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

Locally you can skip the key: run `ant auth login` once, and the Anthropic SDK picks up that profile. `.env.example` lists what's expected.

Nothing in this change calls the model, so the key is only needed from the chat endpoint on.

### Deploying

Connect the GitHub repo in the Vercel dashboard (Framework Preset: Other). Every pull request then gets a preview deploy. `vercel.json` sets the build command to `npm run build`, so a bad config or fact sheet fails the deploy.

## How it fits together

```text
api/health.ts                 GET handler (Vercel web-standard fetch export)
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
