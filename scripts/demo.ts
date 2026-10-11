// Runs the audit on every page in demo-pages.json (or a file passed as the first argument).
// Each run gets its own folder, demo-reports/<run time>/, holding a .md and a .json per page plus
// index.md comparing them. Upload the files from one folder to share a complete run.
// Usage: npm run demo [-- pages.json] [--no-agent] [--no-browser]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadEnv } from "./env";
import { runFullAudit } from "../lib/orchestrate";
import { stampForFile } from "../lib/url";
import { scoreNotes } from "../lib/analyze/scoreNotes";
import { saveReport } from "./save";

loadEnv();

async function main() {
  const file = process.argv.slice(2).find((a) => a.endsWith(".json")) || "demo-pages.json";
  const pages: { url: string; query?: string; why?: string }[] = JSON.parse(readFileSync(file, "utf8"));
  const out = join("demo-reports", stampForFile(new Date().toISOString()));
  mkdirSync(out, { recursive: true });
  const rows: string[] = [];
  const partial: string[] = []; // why a page's report is missing stage data, one entry per page
  for (const [i, p] of pages.entries()) {
    // Spread runs out to stay inside per-minute Search and Fetch limits on free tiers.
    if (i > 0) await new Promise((r) => setTimeout(r, 20_000));
    console.log(`\n${p.url}`);
    const started = Date.now();
    try {
      const r = await runFullAudit(
        { url: p.url, query: p.query, location: "US" },
        { skipAgent: process.argv.includes("--no-agent"), skipBrowser: process.argv.includes("--no-browser"), onProgress: (m) => console.log(`  ${m}`) },
      );
      const saved = saveReport(out, r);
      console.log(`  Saved ${basename(saved.md)} and ${basename(saved.json)}`);
      const top = r.findings.find((f) => f.severity !== "info");
      const notes = scoreNotes(r.scores);
      const why = r.findings.find((f) => f.id === "audit-coverage")?.evidence.join(" ");
      if (r.scores.missingStages?.length) {
        partial.push(why || `${r.scores.missingStages.join(", ")} gave no data`);
        console.log(`  Warning: this report is partial. ${why || ""}`.trimEnd());
      }
      rows.push(
        `| [${p.url}](${basename(saved.md)}) | ${r.query} | ${r.scores.readability}${notes.readability ? " (partial)" : ""} | ${r.scores.visibility ?? "n/a"} | ${notes.answerability ? "no result" : r.scores.answerability.replace(/_/g, " ")} | ${r.views.rawWords ?? "n/a"} / ${r.views.renderedWords ?? "n/a"} / ${r.views.extractedWords ?? "n/a"} | ${top ? `${top.severity}: ${top.title.replace(/\|/g, "/")}` : "none"} | ${Math.round((Date.now() - started) / 1000)}s |`,
      );
    } catch (err) {
      rows.push(`| ${p.url} | ${p.query ?? ""} | error | | | | ${(err as Error).message.replace(/\|/g, "/")} | |`);
    }
  }
  const index = [
    "# Demo run",
    "",
    `Run at ${new Date().toISOString()} against live pages.`,
    "",
    ...(partial.length
      ? [
          `Partial run: ${partial.length} of ${pages.length} reports are missing stage data, so their scores are partial. ${[...new Set(partial)].slice(0, 2).join(" ")}`,
          "",
        ]
      : []),
    "| Page | Query | Readability | Visibility | Agent answer | Words: raw / rendered / extracted | Top finding | Time |",
    "| :- | :- | -: | -: | :- | :- | :- | -: |",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(out, "index.md"), index);
  console.log(`\nWrote ${join(out, "index.md")}. Every .md and .json from this run is in ${out}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
