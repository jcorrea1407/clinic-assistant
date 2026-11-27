import { runTurn } from "../src/chat/turn.js";
import { loadAllClients } from "../src/config/load.js";
import type { ChatMessage, Usage } from "../src/model/provider.js";
import { providerFor } from "../src/model/provider.js";
import { buildSystemPrompt } from "../src/prompt/system.js";

// Runs one example conversation per tier against the real model and prints
// what the visitor would see, plus token usage per call. Costs real money
// (a few cents per run). Needs ANTHROPIC_API_KEY or `ant auth login`.
//
//   npm run try            all examples
//   npm run try -- concern only the examples whose name contains "concern"

const examples: { name: string; messages: string[] }[] = [
  { name: "concern", messages: ["My lower back has been stiff for two weeks since I moved house. Who should I see?"] },
  { name: "red-flag", messages: ["My back hurts and since this morning I can't control my bladder."] },
  { name: "advice-request", messages: ["I sprained my ankle playing soccer. Should I use ice or heat?"] },
  { name: "question", messages: ["Do you direct bill Alberta Blue Cross?", "And what are your hours on Saturday?"] },
  { name: "not-in-fact-sheet", messages: ["Do you offer dry needling?"] },
];

// Reads ANTHROPIC_API_KEY from .env (gitignored) if there is one.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env: the SDK falls back to the environment or an `ant auth login` profile.
}

const filter = process.argv[2];
const [client] = await loadAllClients();
if (!client) throw new Error("No clients configured");
const provider = providerFor(client.config.model);
const systemPrompt = buildSystemPrompt(client.facts);

const fmt = (u: Usage) =>
  `${u.model}: in ${u.inputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}, out ${u.outputTokens}`;

for (const example of examples.filter((e) => !filter || e.name.includes(filter))) {
  console.log(`\n=== ${example.name} ===`);
  const history: ChatMessage[] = [];
  for (const message of example.messages) {
    history.push({ role: "user", content: message });
    console.log(`\nVisitor: ${message}`);
    let reply = "";
    for await (const event of runTurn({
      facts: client.facts,
      systemPrompt,
      provider,
      messages: history,
      onUsage: (step, usage) => console.log(`  [${step}] ${fmt(usage)}`),
    })) {
      if (event.type === "tier") {
        const who = event.practitioners.map((p) => `${p.label} → ${p.bookingUrl}`).join("; ");
        console.log(`  [tier] ${event.tier}${who ? ` · ${who}` : ""}`);
      } else if (event.type === "text") reply += event.text;
      else if (event.type === "replace" || event.type === "error") reply = event.text;
      else if (event.type === "done" && event.ended) console.log("  [conversation ended]");
    }
    console.log(`Assistant: ${reply}`);
    history.push({ role: "assistant", content: reply });
  }
}
