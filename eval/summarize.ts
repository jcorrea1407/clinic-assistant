import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS, HARD_GATE_GROUPS, loadCases } from "./cases.js";
import type { Grade } from "./grade.js";
import { type UsageFields, costOf } from "./prices.js";

// Reads every model's results and writes the comparison to
// eval/runs/model-comparison/summary.md. Never calls a model.
//
//   npm run eval:summary

interface Row {
  prompt_id: string;
  rep: number;
  tags: string[];
  grade: Grade;
  model: string;
  requested_model: string;
  effort: string;
  usage: UsageFields;
  judge_model?: string;
  judge_usage?: UsageFields;
  latency_s: number;
  meta: { calls: ({ step: string; model: string } & Record<string, number | string>)[]; fallback: boolean; failure_shown: boolean };
}

const flowDir = join("eval", "runs", "model-comparison");
const VARIANTS = ["baseline", "v1", "v2", "v3"];
const cases = loadCases();
const groupOf = new Map(cases.map((c) => [c.id, c.group]));

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}% (${n}/${d})` : "–");
const money = (x: number | undefined) => (x === undefined ? "not measured" : `$${x.toFixed(4)}`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Cost of the assistant's own calls in one row, priced per call by the model that answered. */
function appCost(row: Row): number | undefined {
  let total = 0;
  for (const call of row.meta.calls) {
    const cost = costOf(call.model, {
      input_tokens: Number(call.inputTokens),
      output_tokens: Number(call.outputTokens),
      cache_read_input_tokens: Number(call.cacheReadTokens),
      cache_creation_input_tokens: Number(call.cacheWriteTokens),
    });
    if (cost === undefined) return undefined;
    total += cost;
  }
  return total;
}

const sections: string[] = [];
const eligible: { model: string; cost: number }[] = [];
const overview: string[] = [
  "| Model | Rows | Hard gate | Scored pass | False red flags | JSON parsed (1st try) | Failure text shown | Fallback turns | Cost / conversation | Median latency |",
  "|---|---|---|---|---|---|---|---|---|---|",
];

for (const variant of VARIANTS) {
  const rows = readJsonl<Row>(join(flowDir, variant, "results.jsonl"));
  if (!rows.length) continue;
  const errors = readJsonl<{ prompt_id: string; rep: number }>(join(flowDir, variant, "errors.jsonl"));
  const model = rows[0]!.requested_model;
  const effort = rows[0]!.effort;
  const repsByCase = new Map<string, Row[]>();
  for (const r of rows) repsByCase.set(r.prompt_id, [...(repsByCase.get(r.prompt_id) ?? []), r]);

  const gateCases = cases.filter((c) => HARD_GATE_GROUPS.includes(c.group));
  const gateMisses = rows.filter((r) => !r.grade.gate_ok).map((r) => `${r.prompt_id} rep${r.rep}`);
  const gateMissing = gateCases.filter((c) => !repsByCase.has(c.id)).map((c) => c.id);
  const gate = gateMisses.length ? `FAIL (${gateMisses.length})` : gateMissing.length ? "incomplete" : "pass";

  const scored = rows.filter((r) => !HARD_GATE_GROUPS.includes(groupOf.get(r.prompt_id)!));
  const nonRedFlag = rows.filter((r) => !groupOf.get(r.prompt_id)!.startsWith("red-flag"));
  const costs = rows.map(appCost);
  const costKnown = costs.every((c) => c !== undefined);
  const meanCost = costKnown && costs.length ? (costs as number[]).reduce((a, b) => a + b, 0) / costs.length : undefined;
  const judgeCost = rows.reduce<number | undefined>((sum, r) => {
    if (sum === undefined || !r.judge_model || !r.judge_usage) return sum;
    const c = costOf(r.judge_model, r.judge_usage);
    return c === undefined ? undefined : sum + c;
  }, 0);
  const sum = (key: keyof Grade, rs = rows) => rs.reduce((n, r) => n + r.grade[key], 0);

  overview.push(
    `| ${model} (${effort}) | ${rows.length}${errors.length ? `, ${errors.length} errors` : ""} | ${gate} | ${pct(sum("pass", scored), scored.length)} | ${pct(sum("false_red_flag", nonRedFlag), nonRedFlag.length)} | ${pct(sum("json_ok"), rows.length)} | ${rows.filter((r) => r.meta.failure_shown).length} | ${rows.filter((r) => r.meta.fallback).length} | ${money(meanCost)} | ${median(rows.map((r) => r.latency_s)).toFixed(1)}s |`,
  );
  if (gate === "pass" && meanCost !== undefined && repsByCase.size === cases.length) eligible.push({ model, cost: meanCost });

  const byGroup = GROUPS.map((g) => {
    const rs = rows.filter((r) => groupOf.get(r.prompt_id) === g);
    const key = HARD_GATE_GROUPS.includes(g) ? "gate_ok" : "pass";
    return `| ${g} | ${key === "gate_ok" ? "hard gate" : "pass"} | ${pct(sum(key, rs), rs.length)} | ${pct(sum("pass", rs), rs.length)} |`;
  });
  const failing = [...repsByCase.entries()]
    .filter(([, rs]) => rs.some((r) => !r.grade.pass))
    .map(([id, rs]) => `${id} (${rs.filter((r) => !r.grade.pass).length}/${rs.length})`);

  sections.push(
    [
      `## ${model} (${variant})`,
      "",
      "| Group | Metric | Gate or pass | Everything right |",
      "|---|---|---|---|",
      ...byGroup,
      "",
      `Gate misses: ${gateMisses.join(", ") || "none"}.${gateMissing.length ? ` Not yet run: ${gateMissing.join(", ")}.` : ""}`,
      "",
      `Cases with a failed rep: ${failing.join(", ") || "none"}.`,
      "",
      `Judge cost for this model's rows: ${money(judgeCost)}. Assistant cost for this model's rows: ${money(costKnown ? (costs as number[]).reduce((a, b) => a + b, 0) : undefined)}.`,
    ].join("\n"),
  );
}

eligible.sort((a, b) => a.cost - b.cost);
const recommendation = eligible.length
  ? `Cheapest model that passed every hard-gate case on every rep: **${eligible[0]!.model}**, at ${money(eligible[0]!.cost)} per conversation.`
  : "No model has passed every hard-gate case on a complete run yet.";

const doc = [
  "# Model comparison: results",
  "",
  `Generated by \`npm run eval:summary\` on ${new Date().toISOString().slice(0, 10)}. Don't edit by hand.`,
  "",
  "A conversation here is one graded visitor turn (two model calls, or one for a red flag). Cost covers the assistant's calls only, priced by the model that answered; the judge is listed separately. The hard gate is every red-flag and advice case on every rep.",
  "",
  ...overview,
  "",
  recommendation,
  "",
  ...sections,
  "",
].join("\n");

writeFileSync(join(flowDir, "summary.md"), doc);
console.log(doc);
