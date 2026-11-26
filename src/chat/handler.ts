import { z } from "zod";
import { runTurn, type ChatEvent } from "./turn.js";
import { getClients, type LoadedClient } from "../config/load.js";
import { providerFor, type ModelProvider } from "../model/provider.js";
import { buildSystemPrompt } from "../prompt/system.js";

// POST /api/chat
// Body: { client: "upland", messages: [{ role: "user" | "assistant", content }] }
// Replies with server-sent events, one ChatEvent per `data:` line.
// Nothing is stored: the widget sends the whole conversation every turn.

const Body = z.strictObject({
  client: z.string().min(1).max(64),
  messages: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2_000) }))
    .min(1)
    .max(20)
    .refine((m) => m.at(-1)?.role === "user", "The last message must be from the visitor"),
});

interface Runtime {
  client: LoadedClient;
  provider: ModelProvider;
  systemPrompt: string;
}

async function runtimeFor(
  runtimes: Map<string, Runtime>,
  id: string,
  makeProvider: typeof providerFor,
): Promise<Runtime | undefined> {
  const cached = runtimes.get(id);
  if (cached) return cached;
  const client = (await getClients()).find((c) => c.config.id === id);
  if (!client) return undefined;
  const runtime = { client, provider: makeProvider(client.config.model), systemPrompt: buildSystemPrompt(client.facts) };
  runtimes.set(id, runtime);
  return runtime;
}

function sse(events: AsyncIterable<ChatEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export function createChatHandler(makeProvider: typeof providerFor = providerFor) {
  // Built once per function instance and reused, so the prompt bytes stay identical.
  const runtimes = new Map<string, Runtime>();

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
      const body = Body.safeParse(json);
      if (!body.success) {
        return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });
      }

      let runtime: Runtime | undefined;
      try {
        runtime = await runtimeFor(runtimes, body.data.client, makeProvider);
      } catch (error) {
        console.error(error);
        return Response.json({ error: "Client config failed validation" }, { status: 500 });
      }
      if (!runtime) return Response.json({ error: "Unknown client" }, { status: 404 });

      const { client, provider, systemPrompt } = runtime;
      const events = runTurn({
        facts: client.facts,
        systemPrompt,
        provider,
        messages: body.data.messages,
        onUsage: (step, usage) => console.log(JSON.stringify({ client: client.config.id, step, ...usage })),
      });

      return new Response(sse(events), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
        },
      });
    },
  };
}
