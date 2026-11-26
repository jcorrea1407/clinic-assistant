import { describe, expect, it } from "vitest";
import uplandSheet from "../clients/upland/fact-sheet.json" with { type: "json" };
import { classificationSchema, runTurn, type ChatEvent } from "../src/chat/turn.js";
import { parseFactSheet } from "../src/facts/source.js";
import type { ChatMessage, ModelProvider } from "../src/model/provider.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { classified, fakeProvider, usage } from "./fake-provider.js";

const facts = parseFactSheet(uplandSheet);
const systemPrompt = buildSystemPrompt(facts);
const redFlag = facts.collections.clinicFacts.find((f) => f.slug === "red-flag-message")!.value;

async function turn(provider: ModelProvider, messages: ChatMessage[] = [{ role: "user", content: "Hi" }]) {
  const events: ChatEvent[] = [];
  for await (const e of runTurn({ facts, systemPrompt, provider, messages })) events.push(e);
  return events;
}

describe("a red flag", () => {
  it("shows the fixed message, ends the conversation, and never calls the reply model", async () => {
    const { provider, calls } = fakeProvider({ classify: classified("red-flag") });
    const events = await turn(provider, [{ role: "user", content: "I have chest pain" }]);

    expect(events).toEqual([
      { type: "tier", tier: "red-flag", practitioners: [] },
      { type: "text", text: redFlag },
      { type: "done", ended: true },
    ]);
    expect(calls.stream).toHaveLength(0);
  });

  it("stays the only answer for the rest of the conversation", async () => {
    const { provider, calls } = fakeProvider({ classify: classified("question") });
    const events = await turn(provider, [
      { role: "user", content: "I have chest pain" },
      { role: "assistant", content: redFlag },
      { role: "user", content: "Ok, what are your hours?" },
    ]);

    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: redFlag });
    expect(events.at(-1)).toEqual({ type: "done", ended: true });
    expect(calls.classify).toHaveLength(0);
    expect(calls.stream).toHaveLength(0);
  });
});

describe("a concern", () => {
  it("sends the concern's practitioners with booking links, and tells the reply model who they are", async () => {
    const { provider, calls } = fakeProvider({ classify: classified("concern", "back-and-neck"), reply: ["You can ", "see…"] });
    const events = await turn(provider, [{ role: "user", content: "My back hurts" }]);

    expect(events).toEqual([
      {
        type: "tier",
        tier: "concern",
        practitioners: [
          { slug: "priya-nair", label: "Dr. Priya Nair, chiropractor", bookingUrl: "/book/priya-nair" },
          { slug: "daniel-reyes", label: "Daniel Reyes, physiotherapist", bookingUrl: "/book/daniel-reyes" },
        ],
      },
      { type: "text", text: "You can " },
      { type: "text", text: "see…" },
      { type: "done", ended: false },
    ]);
    expect(calls.stream[0]!.note).toContain("Dr. Priya Nair, chiropractor");
  });

  it("labels massage therapists as RMTs without naming a regulator", async () => {
    const { provider } = fakeProvider({ classify: classified("concern", "muscle-tension-and-stress") });
    const tier = (await turn(provider)).find((e) => e.type === "tier");
    expect(tier).toMatchObject({
      practitioners: [
        { label: "Hannah Brooks, registered massage therapist (RMT)" },
        { label: "Liam Fraser, registered massage therapist (RMT)" },
      ],
    });
  });
});

describe("an advice request", () => {
  it("is passed to the reply model as a request to decline, with booking options", async () => {
    const { provider, calls } = fakeProvider({ classify: classified("advice-request", "sports-injuries") });
    const events = await turn(provider, [{ role: "user", content: "Should I ice my ankle?" }]);

    expect(events[0]).toMatchObject({ type: "tier", tier: "advice-request" });
    expect(calls.stream[0]!.note).toMatch(/asks for treatment advice\. Decline/);
  });
});

describe("a question", () => {
  it("gets no practitioner buttons", async () => {
    const { provider, calls } = fakeProvider({ classify: classified("question", "back-and-neck") });
    const events = await turn(provider);
    expect(events[0]).toEqual({ type: "tier", tier: "question", practitioners: [] });
    expect(calls.stream[0]!.note).toContain("Answer it from the fact sheet only");
  });
});

describe("failures", () => {
  it("shows fixed text, never generated text, when classification is refused", async () => {
    const { provider, calls } = fakeProvider({ classify: { ok: false, reason: "refusal", usage } });
    const events = await turn(provider);
    expect(events).toEqual([
      { type: "error", text: "Sorry, something went wrong on my side. Please call the front desk at 403-555-0142." },
      { type: "done", ended: false },
    ]);
    expect(calls.stream).toHaveLength(0);
  });

  it("shows fixed text when the classify call throws", async () => {
    const { provider } = fakeProvider({
      classify: () => {
        throw new Error("network");
      },
    });
    expect((await turn(provider))[0]).toMatchObject({ type: "error" });
  });

  it("replaces a reply that was declined mid-stream", async () => {
    const { provider } = fakeProvider({ reply: ["Partial"], stopReason: "refusal" });
    const events = await turn(provider);
    expect(events.slice(-2)).toEqual([
      { type: "replace", text: "Sorry, I can't help with that here. You can ask the front desk at 403-555-0142." },
      { type: "done", ended: false },
    ]);
  });
});

describe("the classification schema", () => {
  it("only accepts concern slugs from the fact sheet", () => {
    const schema = classificationSchema(facts);
    expect(schema.safeParse({ tier: "concern", concern: "back-and-neck" }).success).toBe(true);
    expect(schema.safeParse({ tier: "concern", concern: "made-up" }).success).toBe(false);
  });
});

describe("the system prompt", () => {
  it("is byte-identical every time it's built, so it can be cached", () => {
    expect(buildSystemPrompt(parseFactSheet(structuredClone(uplandSheet)))).toBe(systemPrompt);
  });

  it("contains the facts but no internal notes and no emergency text", () => {
    expect(systemPrompt).toContain("403-555-0142");
    expect(systemPrompt).not.toContain("internalNote");
    expect(systemPrompt).not.toContain("Practitioner review needed");
  });
});
