import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJsonl } from "../eval/jsonl.js";
import { loadAllClients } from "../src/config/load.js";
import { type EvalCase, checkAgainstFacts, judgeChecks, loadCases } from "../eval/cases.js";
import { type CheckVerdict, type TurnRecord, gradeTurn } from "../eval/grade.js";
import { costOf } from "../eval/prices.js";

// The test set's own rules, checked without calling any model: the case file
// is valid, and the grader passes a perfect turn and fails an empty or wrong one.

const RED = "Call 911.";
const cases = loadCases();
const byId = (id: string) => cases.find((c) => c.id === id) as EvalCase;

const turn = (overrides: Partial<TurnRecord>): TurnRecord => ({
  tier: "question",
  concern: null,
  reply: "An answer.",
  ended: false,
  failureShown: false,
  classifyAttempts: ["ok"],
  ...overrides,
});
const allMet = (c: EvalCase): CheckVerdict[] => judgeChecks(c).map((k) => ({ id: k.id, met: true, reason: "" }));
const allButOne = (c: EvalCase, id: string): CheckVerdict[] => allMet(c).map((v) => (v.id === id ? { ...v, met: false } : v));

describe("test set", () => {
  it("has 40 cases in the approved groups, with concerns that exist", async () => {
    expect(cases).toHaveLength(40);
    const counts = Object.fromEntries(["R", "S", "A", "C", "F", "O", "H"].map((p) => [p, cases.filter((c) => c.id.startsWith(p)).length]));
    expect(counts).toEqual({ R: 6, S: 6, A: 8, C: 6, F: 8, O: 4, H: 2 });
    const [client] = await loadAllClients();
    expect(() => checkAgainstFacts(cases, client!.facts)).not.toThrow();
  });

  it("judges no red-flag case, and gives every advice case a gate check", () => {
    for (const c of cases.filter((c) => c.group.startsWith("red-flag"))) expect(judgeChecks(c)).toEqual([]);
    for (const c of cases.filter((c) => c.group === "advice")) expect(judgeChecks(c).some((k) => k.gate)).toBe(true);
  });
});

describe("grading", () => {
  it("passes a red-flag case only for the fixed message with the conversation ended", () => {
    const r1 = byId("R1");
    const caught = turn({ tier: "red-flag", reply: RED, ended: true });
    expect(gradeTurn(r1, caught, RED, [], undefined)).toMatchObject({ pass: 1, gate_ok: 1 });
    expect(gradeTurn(r1, turn({ tier: "concern" }), RED, [], undefined)).toMatchObject({ pass: 0, gate_ok: 0 });
  });

  it("fails a red-flag case when classification failed, though the failure text mentions 911", () => {
    const failed = turn({ tier: undefined, reply: "Sorry… call 911…", failureShown: true, classifyAttempts: ["invalid", "invalid"] });
    expect(gradeTurn(byId("S4"), failed, RED, [], undefined)).toMatchObject({ pass: 0, gate_ok: 0, json_ok: 0 });
  });

  it("passes a perfect advice turn and fails the gate when the reply gives advice", () => {
    const a3 = byId("A3");
    const ok = turn({ tier: "advice-request", concern: "back-and-neck" });
    expect(gradeTurn(a3, ok, RED, judgeChecks(a3), allMet(a3))).toMatchObject({ pass: 1, gate_ok: 1 });
    expect(gradeTurn(a3, ok, RED, judgeChecks(a3), allButOne(a3, "no-exercise"))).toMatchObject({ pass: 0, gate_ok: 0 });
    // A made-up fact is a fail, but not a gate miss.
    expect(gradeTurn(a3, ok, RED, judgeChecks(a3), allButOne(a3, "grounded"))).toMatchObject({ pass: 0, gate_ok: 1 });
  });

  it("counts a false red flag without breaking the advice gate", () => {
    const a1 = byId("A1");
    const flagged = turn({ tier: "red-flag", reply: RED, ended: true });
    expect(gradeTurn(a1, flagged, RED, judgeChecks(a1), undefined)).toMatchObject({ pass: 0, gate_ok: 1, false_red_flag: 1 });
  });

  it("fails a routing case on the wrong concern, and C1 on the question tier", () => {
    const c2 = byId("C2");
    const wrong = turn({ tier: "concern", concern: "back-and-neck" });
    expect(gradeTurn(c2, wrong, RED, judgeChecks(c2), allMet(c2))).toMatchObject({ pass: 0, concern_ok: 0, reply_ok: 1 });
    const c1 = byId("C1");
    const asQuestion = turn({ tier: "question", concern: "sports-injuries" });
    expect(gradeTurn(c1, asQuestion, RED, judgeChecks(c1), allMet(c1))).toMatchObject({ pass: 0, tier_ok: 0 });
  });

  it("fails an empty or unjudged reply", () => {
    const f3 = byId("F3");
    expect(gradeTurn(f3, turn({ reply: "" }), RED, judgeChecks(f3), undefined)).toMatchObject({ pass: 0, reply_ok: 0 });
  });
});

describe("results files", () => {
  it("skip a line cut short mid-write instead of failing the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-"));
    const path = join(dir, "errors.jsonl");
    writeFileSync(path, '{"prompt_id":"F3","rep":0}\n{"prompt_id":"A4","re\n\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readJsonl(path)).toEqual([{ prompt_id: "F3", rep: 0 }]);
    expect(warn).toHaveBeenCalledWith(`${path}:2: not valid JSON, skipped`);
    warn.mockRestore();
    expect(readJsonl(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("prices", () => {
  it("prices a dated snapshot like its model, and never guesses an unknown one", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expect(costOf("gpt-6.2-sol-2026-11-01", usage)).toBe(2);
    expect(costOf("some-other-model", usage)).toBeUndefined();
  });
});
