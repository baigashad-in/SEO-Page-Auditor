// Stage 4: TinyFish Agent. Can an AI browsing agent answer the searcher's question from this page?
// This is the only stage that interacts with the page (dismiss pop-ups, open tabs and accordions),
// so it finds answers hidden behind clicks and blockers that Fetch, Browser and Search cannot see.
// The report then checks whether the agent's evidence quote is also in the Fetch extraction and in
// the raw server HTML, which tells the site owner exactly which kind of AI tool can or cannot use it.

import type { AgentAnswer, AgentStageResult, AnswerLocation, CallLog } from "../types";
import { tfCancelAgentRun, tfGetAgentRun, tfStartAgentRun, tinyfishErrorText } from "../tinyfish";
import { parseInputUrl } from "../url";

const LOCATIONS: AnswerLocation[] = ["visible_on_load", "after_scroll", "after_interaction", "other_page", "not_on_page"];
const BLOCKERS = ["cookie_wall", "modal", "login_wall", "paywall", "captcha", "age_gate", "region_block", "broken_page", "other"];

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer_found: { type: "boolean" },
    answer_summary: { type: "string", nullable: true },
    evidence_quote: { type: "string", nullable: true },
    answer_location: { type: "string", enum: LOCATIONS },
    interactions_needed: { type: "array", items: { type: "string" }, maxItems: 10 },
    blockers: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { type: { type: "string", enum: BLOCKERS }, description: { type: "string" } },
        required: ["type", "description"],
      },
    },
    page_purpose: { type: "string" },
    missing_information: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
  required: [
    "answer_found",
    "answer_summary",
    "evidence_quote",
    "answer_location",
    "interactions_needed",
    "blockers",
    "page_purpose",
    "missing_information",
  ],
};

export function agentGoal(url: string, query: string): string {
  const host = new URL(url).host;
  return [
    "You are testing how well an AI assistant that browses the web could answer a searcher's question using only this page.",
    `Question: "${query}"`,
    "Rules:",
    `1. Stay on this exact page (${url}). Do not open other pages, even on ${host}, and do not use search engines or other websites.`,
    "2. You may scroll, close cookie or newsletter pop-ups, and click tabs, accordions, 'read more' or 'show more' controls on this page.",
    "3. Do not log in, sign up, buy anything, or submit any form.",
    "Report:",
    "- answer_found: true only if this page itself answers the question.",
    "- answer_summary: the answer in one or two sentences, or null.",
    "- evidence_quote: copy one exact sentence from the page that supports the answer (40 words max), or null.",
    "- answer_location: visible_on_load if readable without scrolling or clicking; after_scroll if you only had to scroll; after_interaction if you had to click or dismiss something on this page first; other_page if this page only links to the answer; not_on_page if absent.",
    "- interactions_needed: each click or dismissal you needed, in order.",
    "- blockers: anything that blocked or covered content, with type and a short description.",
    "- page_purpose: one sentence on what the page is for.",
    "- missing_information: up to 5 specific facts someone asking this question would still need that the page does not give.",
  ].join("\n");
}

export async function startAgentStage(url: string, query: string): Promise<{ runId: string | null; error?: string; calls: CallLog[] }> {
  const pageUrl = parseInputUrl(url).toString();
  const t = Date.now();
  try {
    const res = await tfStartAgentRun({ url: pageUrl, goal: agentGoal(pageUrl, query), output_schema: AGENT_OUTPUT_SCHEMA, browser_profile: "lite" });
    if (!res.run_id) {
      const msg = tinyfishErrorText(res.error?.message || "No run_id returned", "an Agent run");
      return { runId: null, error: msg, calls: [{ endpoint: "agent", purpose: "Start answerability run", ms: Date.now() - t, ok: false, detail: msg }] };
    }
    return { runId: res.run_id, calls: [{ endpoint: "agent", purpose: "Start answerability run (run-async)", ms: Date.now() - t, ok: true, detail: res.run_id }] };
  } catch (err) {
    const msg = tinyfishErrorText(err, "an Agent run");
    return { runId: null, error: msg, calls: [{ endpoint: "agent", purpose: "Start answerability run", ms: Date.now() - t, ok: false, detail: msg }] };
  }
}

function asStringArray(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()).slice(0, max) : [];
}

/** Accepts the run result whether it is the schema object, wrapped in another key, or a JSON string. */
export function normalizeAgentResult(result: unknown): AgentAnswer | null {
  let r: unknown = result;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r && typeof r === "object" && !("answer_found" in (r as object))) {
    const inner = Object.values(r as object).find((v) => v && typeof v === "object" && "answer_found" in (v as object));
    if (inner) r = inner;
  }
  if (!r || typeof r !== "object" || !("answer_found" in (r as object))) return null;
  const o = r as Record<string, unknown>;
  const loc = LOCATIONS.includes(o.answer_location as AnswerLocation) ? (o.answer_location as AnswerLocation) : o.answer_found ? "visible_on_load" : "not_on_page";
  const blockers = Array.isArray(o.blockers)
    ? (o.blockers as unknown[])
        .filter((b) => b && typeof b === "object")
        .map((b) => ({ type: String((b as Record<string, unknown>).type ?? "other"), description: String((b as Record<string, unknown>).description ?? "") }))
        .slice(0, 8)
    : [];
  return {
    answer_found: Boolean(o.answer_found),
    answer_summary: typeof o.answer_summary === "string" && o.answer_summary.trim() ? o.answer_summary.trim() : null,
    evidence_quote: typeof o.evidence_quote === "string" && o.evidence_quote.trim() ? o.evidence_quote.trim() : null,
    answer_location: loc,
    interactions_needed: asStringArray(o.interactions_needed, 10),
    blockers,
    page_purpose: typeof o.page_purpose === "string" ? o.page_purpose : "",
    missing_information: asStringArray(o.missing_information, 5),
  };
}

export async function pollAgentStage(runId: string, query: string): Promise<AgentStageResult> {
  const t = Date.now();
  try {
    const run = await tfGetAgentRun(runId);
    const calls: CallLog[] = [];
    const done = run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED";
    if (done) {
      calls.push({ endpoint: "agent", purpose: "Answerability run result", ms: Date.now() - t, ok: run.status === "COMPLETED", detail: `${run.status}, ${run.num_of_steps ?? "?"} steps` });
    }
    const answer = run.status === "COMPLETED" ? normalizeAgentResult(run.result ?? run.resultJson) : null;
    const errText = run.error ? tinyfishErrorText([run.error.message, run.error.help_message].filter(Boolean).join(" "), "the Agent run") : "";
    return {
      ok: run.status === "COMPLETED" && !!answer,
      runId,
      status: run.status,
      error: errText || (run.status === "COMPLETED" && !answer ? "Run completed but result did not match the schema" : undefined),
      numSteps: run.num_of_steps,
      query,
      answer,
      calls,
    };
  } catch (err) {
    return { ok: false, runId, status: "ERROR", error: tinyfishErrorText(err, "the Agent run result"), query, answer: null, calls: [] };
  }
}

/** Server-side helper for the CLI: start, poll until done or timeout, cancel on timeout. */
export async function runAgentStage(
  url: string,
  query: string,
  timeoutMs = 240_000,
  onStatus?: (status: string) => void, // called when the run's status changes (QUEUED, RUNNING, ...)
): Promise<AgentStageResult> {
  const started = await startAgentStage(url, query);
  if (!started.runId) return { ok: false, runId: null, status: "NOT_STARTED", error: started.error, query, answer: null, calls: started.calls };
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await pollAgentStage(started.runId, query);
    if (onStatus && res.status !== last) onStatus(res.status);
    last = res.status;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(res.status)) return { ...res, calls: [...started.calls, ...res.calls] };
  }
  await tfCancelAgentRun(started.runId);
  return {
    ok: false,
    runId: started.runId,
    status: "TIMEOUT",
    error: `Agent run did not finish in ${Math.round(timeoutMs / 1000)}s and was cancelled.`,
    query,
    answer: null,
    calls: [...started.calls, { endpoint: "agent", purpose: "Answerability run", ms: timeoutMs, ok: false, detail: "timed out, cancelled" }],
  };
}
