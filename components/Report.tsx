"use client";

import { useState } from "react";
import type { AuditReport, Finding, Category } from "@/lib/types";
import { reportToMarkdown } from "@/lib/analyze/markdownReport";
import { scoreNotes } from "@/lib/analyze/scoreNotes";
import { oneLineError, reportFileBase, rootDomain, sameSite, withoutCallerInstructions } from "@/lib/url";

const CATEGORY_TITLE: Record<Category, string> = {
  access: "Can AI crawlers get in?",
  rendering: "Does it work without JavaScript?",
  extraction: "What AI extraction keeps",
  metadata: "Titles, descriptions and tags",
  structured_data: "Structured data",
  visibility: "How it shows up in search",
  content_gap: "What the pages above you cover",
  answerability: "Can an AI agent answer the query?",
};
const CATEGORY_ORDER: Category[] = ["access", "rendering", "extraction", "answerability", "visibility", "content_gap", "metadata", "structured_data"];
const SEV_WORD: Record<Finding["severity"], string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Note" };
const SOURCE_NAME = { fetch: "Fetch", browser: "Browser", search: "Search", agent: "Agent" } as const;
const ANSWER_TEXT = {
  answered: "Answered",
  answered_with_effort: "Answered after clicks",
  answered_elsewhere: "Only on another page",
  not_answered: "Not answered",
  unknown: "Not tested",
};

function capitalize(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="code">
      <button
        type="button"
        className="copy"
        onClick={() => {
          navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {code}
    </pre>
  );
}

function sourcesText(f: Finding) {
  if (!f.sources.length) return "From the audit run.";
  const names = f.sources.map((s) => SOURCE_NAME[s]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `Evidence from TinyFish ${list}. Confidence: ${f.confidence}.`;
}

function FindingItem({ f }: { f: Finding }) {
  const open = f.severity === "critical" || f.severity === "high";
  return (
    <article className={`finding sev-${f.severity}`} id={`f-${f.id}`}>
      <div className="margin">
        {SEV_WORD[f.severity]}
        <small>{f.fix.effort}</small>
      </div>
      <details open={open}>
        <summary>
          <h4>{f.title}</h4>
          <p className="meta">{sourcesText(f)}</p>
        </summary>
        <div className="body">
          <ul className="plain evidence">
            {f.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <p>
            <span className="label">Why it matters for visibility. </span>
            {f.visibilityImpact}
          </p>
          <div className="fix">
            <span className="label">Fix: </span>
            {f.fix.summary}
            {f.fix.steps.length > 0 && (
              <ol>
                {f.fix.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            {f.fix.code && <CodeBlock code={f.fix.code} />}
          </div>
        </div>
      </details>
    </article>
  );
}

function Readers({ r }: { r: AuditReport }) {
  const blocked = r.views.blockedNote;
  const rows = [
    { label: "A person in a browser", sub: "Rendered page, JavaScript on", value: r.views.renderedWords, browser: true },
    { label: "An AI fetch tool", sub: "What TinyFish Fetch extracts", value: r.views.extractedWords, browser: false },
    { label: "A crawler that skips JavaScript", sub: "GPTBot, ClaudeBot, PerplexityBot", value: r.views.rawWords, browser: true },
  ];
  const max = Math.max(1, ...rows.map((x) => x.value ?? 0));
  const top = r.views.renderedWords ?? max;
  return (
    <dl className="readers" aria-label="Words each reader gets from the page">
      {rows.map((row) => {
        const w = row.value === null ? 0 : Math.max(1.5, (row.value / max) * 100);
        const short = row.value !== null && top > 0 && row.value / top < 0.5;
        return (
          <div className="reader" key={row.label}>
            <dt>
              {row.label}
              <small>{row.sub}</small>
            </dt>
            <dd>
              <div className={`bar${short ? " short" : ""}`} role="img" aria-label={`${row.value ?? "not measured"} words`}>
                {row.value !== null && <span style={{ width: `${w}%` }} />}
              </div>
              <div className="bar-num">
                {row.value === null ? <small>{blocked && row.browser ? "bot challenge" : "not measured"}</small> : row.value.toLocaleString()}{" "}
                {row.value !== null && <small>words</small>}
              </div>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export default function Report({ report: r }: { report: AuditReport }) {
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const s = r.scores;
  const notes = scoreNotes(s);
  const search = r.stages.search;
  const agent = r.stages.agent?.answer;
  const fetch = r.stages.fetch;
  const browser = r.stages.browser;
  const grouped = CATEGORY_ORDER.map((c) => ({ c, items: r.findings.filter((f) => f.category === c) })).filter((g) => g.items.length);

  return (
    <div className="report">
      <p className="audited-url">
        Audited {r.input.url} for &ldquo;{r.query}&rdquo;
        {r.queryDerived ? " (query taken from the page title; add your own target query for a sharper audit)" : ""}
      </p>
      <p className="lede">{r.connection[0]}</p>

      <Readers r={r} />

      <dl className="scores">
        <div>
          <dt>AI readability</dt>
          <dd>
            {s.readability}
            <small>/100</small>
          </dd>
          {notes.readability && <div className="breakdown">{capitalize(notes.readability)}</div>}
          <details className="breakdown">
            <summary>Breakdown</summary>
            {s.readabilityParts.map((p) => (
              <div key={p.label}>
                {p.label}: {p.score}/{p.max}
              </div>
            ))}
          </details>
        </div>
        <div>
          <dt>Search visibility</dt>
          <dd>
            {s.visibility === null ? <small>not measured</small> : s.visibility}
            {s.visibility !== null && <small>/100</small>}
          </dd>
          {s.visibilityParts.length > 0 && (
            <details className="breakdown">
              <summary>Breakdown</summary>
              {s.visibilityParts.map((p) => (
                <div key={p.label}>
                  {p.label}: {p.score}/{p.max}
                </div>
              ))}
            </details>
          )}
        </div>
        <div>
          <dt>AI agent answer test</dt>
          <dd style={{ fontSize: "1.35rem", paddingTop: 6 }}>{ANSWER_TEXT[s.answerability]}</dd>
          {notes.answerability && <div className="breakdown">{capitalize(notes.answerability)}</div>}
        </div>
      </dl>
      <p className="breakdown">Scores are heuristics built from the checks below, meant for comparing runs, not an external standard.</p>

      <section>
        <h2>How readability connects to visibility</h2>
        <ul className="plain">
          {r.connection.slice(1).map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </section>

      {r.doToday.length === 0 && (
        <section>
          <h2>Do these today</h2>
          <p>Nothing urgent. The remaining findings below are low priority polish.</p>
        </section>
      )}

      {r.doToday.length > 0 && (
        <section>
          <h2>Do these today</h2>
          <ol className="plain today">
            {r.doToday.map((id) => {
              const f = byId.get(id)!;
              return (
                <li key={id}>
                  <a href={`#f-${id}`}>{f.title}</a>{" "}
                  <span className={`sev-word sev-${f.severity}`}>
                    {SEV_WORD[f.severity]}, {f.fix.effort}
                  </span>
                  <div>{f.fix.summary}</div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {r.strengths.length > 0 && (
        <section>
          <h2>Already working</h2>
          <ul className="plain">
            {r.strengths.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>All findings</h2>
        {grouped.map((g) => (
          <div key={g.c}>
            <h3>{CATEGORY_TITLE[g.c]}</h3>
            {g.items.map((f) => (
              <FindingItem key={f.id} f={f} />
            ))}
          </div>
        ))}
      </section>

      {(browser?.raw || fetch?.page) && (
        <section>
          <h2>Read it the way they do</h2>
          <div className="samples">
            <div>
              <p className="sample-title">Raw HTML text (no JavaScript)</p>
              <div className="sample">{r.views.rawSample || "No text in the raw HTML."}</div>
            </div>
            <div>
              <p className="sample-title">TinyFish Fetch extraction</p>
              <div className="sample">{r.views.extractedSample || "Nothing extracted."}</div>
            </div>
          </div>
          {browser?.screenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="shot" src={browser.screenshot} alt="Screenshot of the page as loaded by the TinyFish remote browser" />
          )}
        </section>
      )}

      {agent && (
        <section>
          <h2>The agent&rsquo;s attempt</h2>
          <p>
            Asked to answer &ldquo;{r.query}&rdquo; using only this page. It {agent.answer_found ? "found an answer" : "did not find an answer"}
            {agent.answer_found
              ? r.scores.answerability === "answered_elsewhere"
                ? " on another page it opened, not on this one"
                : ` (${agent.answer_location.replace(/_/g, " ")})`
              : ""}
            .
          </p>
          {agent.answer_summary && <p>{agent.answer_summary}</p>}
          {agent.evidence_quote && <blockquote className="quote">{agent.evidence_quote}</blockquote>}
          {agent.interactions_needed.length > 0 && <p>Steps it needed: {agent.interactions_needed.join(", then ")}.</p>}
          {agent.missing_information.length > 0 && (
            <>
              <p className="label">What it says is missing</p>
              <ul className="plain">
                {agent.missing_information.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {search && search.results.length > 0 && (
        <section>
          <h2>
            Search results for &ldquo;{search.query}&rdquo; ({search.location})
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Result</th>
                  <th className="num">Extractable words</th>
                </tr>
              </thead>
              <tbody>
                {search.results.slice(0, Math.max(10, search.target.position ?? 0)).map((x) => {
                  const comp = search.competitors.find((c) => c.url === x.url);
                  const you = sameSite(x.url, r.input.url);
                  return (
                    <tr key={x.position} className={you ? "you" : undefined}>
                      <td className="num">{x.position}</td>
                      <td>
                        <a href={x.url} target="_blank" rel="noreferrer">
                          {x.title || x.url}
                        </a>
                        <div style={{ color: "var(--slate)" }}>
                          {rootDomain(x.url)}
                          {you ? " (your site)" : ""}
                        </div>
                      </td>
                      <td className="num">{comp?.stats ? comp.stats.words.toLocaleString() : you && search.target.matchedUrl === x.url ? (r.views.extractedWords ?? "").toLocaleString() : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {fetch && fetch.robots.verdicts.length > 0 && (
        <section>
          <h2>Crawler rules for this URL</h2>
          <p className="breakdown">{fetch.robots.note}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Crawler</th>
                  <th>Used for</th>
                  <th>robots.txt</th>
                  <th>Live request</th>
                </tr>
              </thead>
              <tbody>
                {fetch.robots.verdicts.map((v) => {
                  const probe = browser?.botProbes.find((p) => p.bot === v.bot.token);
                  return (
                    <tr key={v.bot.token}>
                      <td>
                        {v.bot.token}
                        <div style={{ color: "var(--slate)" }}>{v.bot.operator}</div>
                      </td>
                      <td>{v.bot.note}</td>
                      {fetch.robots.status === "unreadable" ? (
                        <td>Unknown</td>
                      ) : (
                        <td className={v.allowed ? "yes" : "no"}>{v.allowed ? "Allowed" : `Blocked (${v.matchedRule})`}</td>
                      )}
                      <td className={probe ? (probe.verdict === "ok" ? "yes" : probe.verdict === "error" ? undefined : "no") : undefined}>
                        {probe
                          ? probe.verdict === "error"
                            ? `Not tested: ${probe.error || "probe failed"}`
                            : `${probe.verdict === "ok" ? "Same page" : probe.verdict}, HTTP ${probe.status ?? "n/a"}`
                          : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2>How TinyFish was used in this audit</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>API</th>
                <th>Purpose</th>
                <th className="num">Time</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {r.calls.map((c, i) => (
                <tr key={i}>
                  <td>{SOURCE_NAME[c.endpoint]}</td>
                  <td>{c.purpose}</td>
                  <td className="num">{(c.ms / 1000).toFixed(1)}s</td>
                  <td className={c.ok ? "yes" : "no"}>
                    {c.ok ? "ok" : "failed"}
                    {c.detail ? `: ${oneLineError(withoutCallerInstructions(c.detail), 300)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Take it with you</h2>
        <div className="actions">
          <button type="button" className="btn" onClick={() => download(`${reportFileBase(r.input.url, r.generatedAt)}.md`, reportToMarkdown(r), "text/markdown")}>
            Download Markdown report
          </button>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => download(`${reportFileBase(r.input.url, r.generatedAt)}.json`, JSON.stringify(r, null, 2), "application/json")}
          >
            Download raw JSON
          </button>
        </div>
      </section>
    </div>
  );
}
