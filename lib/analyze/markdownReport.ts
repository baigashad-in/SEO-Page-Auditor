// Markdown export of a report, for sharing with a developer or pasting into a ticket.

import type { AuditReport, Finding } from "../types";
import { oneLineError, withoutCallerInstructions } from "../url";
import { scoreNotes } from "./scoreNotes";

/** Text safe inside a Markdown table cell: one line, no column separators. */
function cell(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "/");
}

const SEV_LABEL: Record<Finding["severity"], string> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

function findingMd(f: Finding): string {
  const lines = [
    `### [${SEV_LABEL[f.severity]}] ${f.title}`,
    `Category: ${f.category.replace(/_/g, " ")}. Confidence: ${f.confidence}. Evidence from: ${f.sources.join(", ") || "audit"}.`,
    "",
    "**Evidence**",
    ...f.evidence.map((e) => `* ${e}`),
    "",
    `**Why it matters for visibility:** ${f.visibilityImpact}`,
    "",
    `**Fix (${f.fix.effort}):** ${f.fix.summary}`,
    ...f.fix.steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (f.fix.code) lines.push("", "```html", f.fix.code, "```");
  return lines.join("\n");
}

export function reportToMarkdown(r: AuditReport): string {
  const s = r.scores;
  const notes = scoreNotes(s);
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const out: string[] = [
    `# AI Page Audit: ${r.input.url}`,
    "",
    `Generated ${r.generatedAt}. Query: "${r.query}"${r.queryDerived ? " (derived from the page)" : ""}.`,
    "",
    "## Scores",
    "",
    `* AI readability: **${s.readability}/100**${notes.readability ? ` (${notes.readability})` : ""}`,
    `* Search visibility: **${s.visibility === null ? "not measured" : `${s.visibility}/100`}**`,
    `* Answerability (AI agent): **${s.answerability.replace(/_/g, " ")}**${notes.answerability ? ` (${notes.answerability})` : ""}`,
    "",
    "## How readability connects to visibility",
    "",
    ...r.connection.map((c) => `* ${c}`),
    "",
    "## Do today",
    "",
    ...(r.doToday.length ? [] : ["Nothing urgent. The remaining findings are low priority polish."]),
    ...r.doToday.map((id, i) => {
      const f = byId.get(id)!;
      return `${i + 1}. **${f.title}** (${f.severity}, ${f.fix.effort}): ${f.fix.summary}`;
    }),
    "",
  ];
  if (r.strengths.length) out.push("## What is already working", "", ...r.strengths.map((x) => `* ${x}`), "");
  out.push("## All findings", "");
  for (const f of r.findings) out.push(findingMd(f), "");
  out.push(
    "## What each reader sees",
    "",
    ...(r.views.blockedNote ? [`* ${r.views.blockedNote}`] : []),
    `* Raw server HTML (non-JavaScript crawlers): ${r.views.rawWords ?? "n/a"} words`,
    `* Rendered page (browser): ${r.views.renderedWords ?? "n/a"} words`,
    `* AI fetch extraction (TinyFish Fetch): ${r.views.extractedWords ?? "n/a"} words`,
    "",
    "## TinyFish calls",
    "",
    "| Endpoint | Purpose | Time | Result |",
    "| :- | :- | -: | :- |",
    ...r.calls.map((c) => `| ${c.endpoint} | ${cell(c.purpose)} | ${(c.ms / 1000).toFixed(1)}s | ${c.ok ? "ok" : "failed"}${c.detail ? `: ${cell(oneLineError(withoutCallerInstructions(c.detail), 300))}` : ""} |`),
    "",
  );
  return out.join("\n");
}
