import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endWithNewline, readJsonl } from "./jsonl.js";
import { parseArgs } from "node:util";
import { type PractitionerLink, type Tier, runTurn } from "../src/chat/turn.js";
import { loadAllClients } from "../src/config/load.js";
import type { ModelConfig } from "../src/config/schema.js";
import type { ChatMessage, ClassifyResult, ModelProvider, Usage } from "../src/model/provider.js";
import { providerFor } from "../src/model/provider.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { type EvalCase, HARD_GATE_GROUPS, STANDARD_REPS, checkAgainstFacts, judgeChecks, loadCases } from "./cases.js";
import { type CheckVerdict, type TurnRecord, gradeTurn, isServingFailure } from "./grade.js";
import { JudgeError, createJudge, judgeSystemPrompt } from "./judge.js";

// Runs the test set against one model and grades every reply. Costs real
// money: every case makes two or three model calls plus a judge call.
//
//   npm run eval -- --model claude-sonnet-5-5             all 40 cases, 3 reps
//   npm run eval -- --model claude-opus-5-5 --cases R1,A6 --reps 1
//
// Results go to eval/runs/model-comparison/<variant>/: results.jsonl (one row
// per case and rep, written as each finishes), traces/, and errors.jsonl for
// attempts that failed before they could be graded. Re-running skips every
// (case, rep) already in results.jsonl, so a crashed run resumes where it
// stopped, and failed attempts are retried.

/** Each model gets a fixed variant directory; the report builder needs baseline / v<N>. */
const MODELS: Record<string, { variant: string; provider: ModelConfig["provider"] }> = {
  "claude-opus-5-5": { variant: "baseline", provider: "anthropic" },
  "claude-sonnet-5-5": { variant: "v1", provider: "anthropic" },
  "claude-haiku-5-5": { variant: "v2", provider: "anthropic" },
  "gpt-6.2-sol": { variant: "v3", provider: "openai" },
};

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string", default: "low" },
    reps: { type: "string", default: String(STANDARD_REPS) },
    cases: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "timeout-s": { type: "string", default: "300" },
  },
});

const modelId = args.model ?? "";
const entry = MODELS[modelId];
if (!entry) {
  console.error(`--model must be one of: ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}
const effort = args.effort as ModelConfig["effort"];
if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Bad --effort ${effort}`);
function positiveInt(name: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number of 1 or more, not "${value}"`);
  return n;
}
const reps = positiveInt("reps", args.reps);
// More reps than a full run can never be summarised as complete, and resume can't remove them.
if (reps > STANDARD_REPS) throw new Error(`--reps can be at most ${STANDARD_REPS} (STANDARD_REPS in eval/cases.ts)`);
const concurrency = positiveInt("concurrency", args.concurrency);
const timeoutS = positiveInt("timeout-s", args["timeout-s"]);
// Well under Node's setTimeout limit (2^31-1 ms, about 24.8 days), past which it fires after 1 ms.
if (timeoutS > 86_400) throw new Error("--timeout-s can be at most 86400 (a day)");
const timeoutMs = timeoutS * 1000;

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const flowDir = join("eval", "runs", "model-comparison");
const outDir = join(flowDir, entry.variant);
const resultsPath = join(outDir, "results.jsonl");
const errorsPath = join(outDir, "errors.jsonl");

type StoredRow = { prompt_id: string; rep: number; effort?: string; meta?: { calls?: unknown[] } };
const results = readJsonl<StoredRow>(resultsPath);
const errorRows = readJsonl<StoredRow>(errorsPath);

// One directory per model, so a run at another effort would mix into it.
// Checked before anything in the directory is written. Error rows from before
// they carried an effort are taken to match.
const otherEffort = [...results, ...errorRows.filter((row) => row.effort !== undefined)].find((row) => row.effort !== effort);
if (otherEffort) {
  console.error(`${outDir} holds ${otherEffort.effort ?? "unlabelled"}-effort rows. Move the whole directory aside before a ${effort}-effort run.`);
  process.exit(1);
}
// A row where no model call returned anything was graded by an earlier version
// of this runner; it's an outage, not a result, so it's run again. The summary
// leaves out the same rows.
const done = new Set(results.filter((row) => (row.meta?.calls?.length ?? 0) > 0).map((row) => `${row.prompt_id}#${row.rep}`));

mkdirSync(join(outDir, "traces"), { recursive: true });
// A killed run can leave a half-written last line. End it, so the first row
// appended now starts on its own line instead of joining the broken one. The
// fragment stays in the file, and readJsonl warns about it on every read.
for (const path of [resultsPath, errorsPath]) endWithNewline(path);
if (entry.variant !== "baseline") {
  writeFileSync(join(outDir, "change.md"), `${modelId} at ${effort} effort, in place of claude-opus-5-5\n`);
}

const [client] = await loadAllClients();
if (!client) throw new Error("No clients configured");
const facts = client.facts;
const systemPrompt = buildSystemPrompt(facts);
const redFlagMessage = facts.collections.clinicFacts.find((f) => f.slug === "red-flag-message")!.value;
const judge = createJudge(judgeSystemPrompt(facts));
const model: ModelConfig = { provider: entry.provider, id: modelId, effort };

let cases = loadCases();
checkAgainstFacts(cases, facts);
if (args.cases) {
  const wanted = new Set(args.cases.split(","));
  cases = cases.filter((c) => wanted.has(c.id));
  if (cases.length !== wanted.size) throw new Error(`Unknown case in --cases ${args.cases}`);
}

/** Wraps the real provider to record each classify attempt and the reply's stop reason. */
function recording(inner: ModelProvider) {
  const log = {
    classify: [] as { result: "ok" | "invalid" | "refusal" | "error"; value?: { tier: Tier; concern: string | null } }[],
    replyStop: undefined as string | undefined,
    /** The reply stream threw (an API error mid-reply). */
    streamThrew: false,
    restarts: 0,
    usages: [] as { step: string; usage: Usage }[],
  };
  const provider: ModelProvider = {
    async classify(request, schema) {
      try {
        const result = (await inner.classify(request, schema)) as ClassifyResult<{ tier: Tier; concern: string | null }>;
        log.classify.push(result.ok ? { result: "ok", value: result.value } : { result: result.reason });
        return result as never;
      } catch (error) {
        log.classify.push({ result: "error" });
        throw error;
      }
    },
    async *stream(request) {
      try {
        for await (const event of inner.stream(request)) {
          if (event.type === "restart") log.restarts++;
          if (event.type === "end") log.replyStop = event.stopReason;
          yield event;
        }
      } catch (error) {
        log.streamThrew = true;
        throw error;
      }
    },
  };
  return { provider, log };
}

const sumUsage = (usages: Usage[]) => ({
  input_tokens: usages.reduce((n, u) => n + u.inputTokens, 0),
  output_tokens: usages.reduce((n, u) => n + u.outputTokens, 0),
  cache_read_input_tokens: usages.reduce((n, u) => n + u.cacheReadTokens, 0),
  cache_creation_input_tokens: usages.reduce((n, u) => n + u.cacheWriteTokens, 0),
});

/** The configured model answered, allowing for a dated snapshot of the same name. */
const servedByRequested = (served: string) => served === modelId || served.startsWith(`${modelId}-`);

/** `abandoned` is set when the wall-clock ceiling fires, so a late finish never writes a row. */
async function runCase(c: EvalCase, rep: number, abandoned: { value: boolean }) {
  const history: ChatMessage[] = c.history ?? [];
  const messages: ChatMessage[] = [...history, { role: "user", content: c.message }];
  const { provider, log } = recording(providerFor(model));

  const started = performance.now();
  let tier: Tier | undefined;
  let practitioners: PractitionerLink[] = [];
  let reply = "";
  let ended = false;
  let errored = false;
  for await (const event of runTurn({
    facts,
    systemPrompt,
    provider,
    messages,
    onUsage: (step, usage) => log.usages.push({ step, usage }),
  })) {
    if (event.type === "tier") ({ tier, practitioners } = event);
    else if (event.type === "text") reply += event.text;
    else if (event.type === "replace") reply = event.text;
    else if (event.type === "error") {
      reply = event.text;
      errored = true;
    } else if (event.type === "done") ended = event.ended;
  }
  const latency_s = (performance.now() - started) / 1000;

  const lastOk = log.classify.findLast((a) => a.result === "ok");
  const failureShown = errored || reply.startsWith("Sorry, something went wrong on my side.");
  const turn: TurnRecord = {
    tier: errored ? undefined : tier,
    concern: lastOk?.value?.concern,
    reply,
    ended,
    failureShown,
    classifyAttempts: log.classify.map((a) => a.result),
  };

  const served = [...new Set(log.usages.map((u) => u.usage.model))];
  const fallback = served.some((m) => !servedByRequested(m)) || log.restarts > 0;
  // Failure text caused by an API error (an outage, a rate limit after the SDK's
  // own retries, a missing key) says nothing about the model, so the turn goes
  // to errors.jsonl and is retried on the next run instead of being graded.
  // Until it is, the summary shows the case as missing a rep, so the gate can't
  // pass. isServingFailure (grade.ts, tested) decides which failures those are.
  const turnAttempts = log.classify.map((a) => a.result);
  if (failureShown && isServingFailure(turnAttempts, log.streamThrew)) {
    throw new ServingError("a model call failed, so the turn showed the failure text");
  }
  if (log.usages.length === 0) throw new Error("No model call recorded usage");

  // Judge every reply a visitor would read as the assistant's own words.
  const checks = judgeChecks(c);
  const judgeable = checks.length > 0 && !failureShown && turn.tier !== undefined && turn.tier !== "red-flag";
  const judged = judgeable ? await judge({ history, message: c.message, reply, practitioners, checks }) : undefined;
  const verdicts: CheckVerdict[] | undefined = judged?.verdicts;

  const grade = gradeTurn(c, turn, redFlagMessage, checks, verdicts);
  const explanation: Record<string, string> = {
    tier_ok: `Got ${turn.tier ?? "no tier (classification failed)"}; accepted ${c.tiers.join(" or ")}.`,
  };
  if (c.concerns) explanation.concern_ok = `Got ${turn.concern ?? "none"}; accepted ${c.concerns.map((s) => s ?? "none").join(" or ")}.`;
  if (verdicts) explanation.reply_ok = verdicts.map((v) => `${v.met ? "MET" : "NOT MET"} ${v.id}: ${v.reason}`).join("\n");

  const prompt = [...history.map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content}`), `Visitor: ${c.message}`].join("\n\n");
  const row = {
    prompt_id: c.id,
    rep,
    prompt,
    tags: [c.group, HARD_GATE_GROUPS.includes(c.group) ? "hard gate" : "scored", ...(c.seed ? ["seed"] : [])],
    status: "ok",
    stop_reason: log.replyStop ?? (turn.tier === "red-flag" ? "red_flag_fixed_message" : "no_reply"),
    grade,
    explanation,
    model: log.usages[0]!.usage.model,
    requested_model: modelId,
    effort,
    usage: sumUsage(log.usages.map((u) => u.usage)),
    ...(judged ? { judge_model: judged.model, judge_usage: judged.usage } : {}),
    latency_s: Math.round(latency_s * 100) / 100,
    meta: {
      tier: turn.tier ?? null,
      concern: turn.concern ?? null,
      practitioners: practitioners.map((p) => p.label),
      classify_attempts: turn.classifyAttempts,
      reply_stop: log.replyStop ?? null,
      served_models: served,
      fallback,
      failure_shown: failureShown,
      calls: log.usages.map((u) => ({ step: u.step, ...u.usage })),
      verdicts: verdicts ?? null,
    },
  };

  const trace = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: c.message },
    {
      role: "system",
      content: `[classify] attempts: ${turn.classifyAttempts.join(", ")}; tier: ${turn.tier ?? "none"}; concern: ${turn.concern ?? "none"}; booking buttons: ${row.meta.practitioners.join("; ") || "none"}`,
    },
    { role: "assistant", content: reply },
    ...(verdicts ? [{ role: "system", content: `[judge: ${judged!.model}]\n${explanation.reply_ok}` }] : []),
  ];
  if (abandoned.value) throw new Error("finished after its timeout; not recorded");
  writeFileSync(join(outDir, "traces", `${c.id}_rep${rep}.json`), JSON.stringify(trace, null, 2));
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  return row;
}

function withTimeout<T>(run: (abandoned: { value: boolean }) => Promise<T>, ms: number): Promise<T> {
  const abandoned = { value: false };
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned.value = true;
      reject(new Error(`timeout after ${ms / 1000}s`));
    }, ms);
  });
  const work = run(abandoned);
  // The abandoned call may still reject later; that's expected and ignored.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The turn showed the failure text because of an API error, not because of
 * anything the model wrote. Which failures count is decided by
 * isServingFailure in grade.ts.
 */
class ServingError extends Error {}

function failureClass(error: unknown): string {
  if (error instanceof JudgeError) return `judge-${error.kind}`;
  if (error instanceof ServingError) return "serving-error";
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("timeout")) return "timeout";
  return "harness-or-serving";
}

const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}#${rep}`));
console.log(`${modelId} (${effort}) → ${outDir}: ${jobs.length} to run, ${done.size} already done`);

const started = performance.now();
const rows: Awaited<ReturnType<typeof runCase>>[] = [];
let failed = 0;
let next = 0;
async function work(max: number) {
  while (next < Math.min(max, jobs.length)) {
    const { c, rep } = jobs[next++]!;
    {
      try {
        const row = await withTimeout((abandoned) => runCase(c, rep, abandoned), timeoutMs);
        rows.push(row);
        const mark = row.grade.pass ? "pass" : "FAIL";
        console.log(`  ${c.id} rep${rep}: ${mark}${row.grade.gate_ok ? "" : " (GATE)"} · ${row.meta.tier ?? "no tier"} · ${row.latency_s}s`);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        appendFileSync(
          errorsPath,
          `${JSON.stringify({ prompt_id: c.id, rep, effort, class: failureClass(error), message, at: new Date().toISOString() })}\n`,
        );
        console.log(`  ${c.id} rep${rep}: ERROR (${failureClass(error)}) ${message}`);
      }
    }
  }
}
// The first case runs alone, so it writes the prompt cache (and the judge's)
// once; the rest then read it instead of each writing their own copy.
await work(1);
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => work(jobs.length)));

const passRate = rows.length ? rows.filter((r) => r.grade.pass).length / rows.length : 0;
const gateMisses = rows.filter((r) => !r.grade.gate_ok).map((r) => `${r.prompt_id}#${r.rep}`);
console.log(
  `\nThis run: ${rows.length} graded, ${failed} errors, ${((performance.now() - started) / 1000).toFixed(0)}s. ` +
    `Pass ${(passRate * 100).toFixed(0)}%. Gate misses: ${gateMisses.length ? gateMisses.join(", ") : "none"}.`,
);
console.log("Run `npm run eval:summary` for the full comparison.");
