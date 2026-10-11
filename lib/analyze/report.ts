// Turns the four stage results into the final report: scores, the readability-to-visibility
// connection, findings, and the "do today" list.

import type { AuditReport, CallLog, Scores } from "../types";
import { agentWasBlocked, answeredOnOtherPage, blockerPhrase, browserRenderIncomplete, buildFindings, buildStrengths, locateQuote, missingStages, usableStages, type StageBundle } from "./findings";
import { markdownToPlain } from "../parse/markdown";
import { truncate } from "./text";
import { bareHost, displayUrl } from "../url";
import { AI_BOTS } from "../parse/robots";
import { withBrowserRobots } from "./robotsSource";
import { scoreNotes } from "./scoreNotes";

function clamp(n: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, n));
}

export function computeScores(input: StageBundle): Scores {
  const b = usableStages(input);
  const f = b.fetch;
  const br = b.browser;
  const s = b.search;
  const parts: { label: string; score: number; max: number }[] = [];

  // 1. Crawler access (30)
  if (f || br || input.browser?.challenge) {
    let a = 30;
    if (f?.pageError) a -= 30;
    if (input.browser?.challenge) a -= 10; // AI browsing agents meet the same challenge
    if (input.browser?.rawChallenge) a -= 10; // crawlers that do not run JavaScript stop at the challenge
    const robotsMeta = [br?.raw?.metaRobots, br?.rendered?.metaRobots, br?.headers.xRobotsTag].join(" ").toLowerCase();
    if (/noindex/.test(robotsMeta)) a -= 30;
    const blocked = f?.robots.verdicts.filter((v) => !v.allowed) ?? [];
    if (blocked.some((v) => v.bot.purpose === "classic_search")) a -= 15;
    a -= Math.min(24, blocked.filter((v) => v.bot.purpose === "ai_search").length * 8);
    const searchBlocked = br?.botProbes.filter((p) => p.verdict === "blocked" && AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training").length ?? 0;
    a -= Math.min(24, searchBlocked * 8);
    parts.push({ label: "Crawler access", score: Math.round(clamp(a, 0, 30)), max: 30 });
  }

  // 2. Works without JavaScript (25)
  if (br?.raw && br.rendered) {
    // When the browser's render missed text Fetch got, the page holds at least raw + that text.
    const gap = browserRenderIncomplete(b);
    const fullWords = gap ? Math.max(br.rendered.words, br.raw.words + gap.notInRaw.words) : br.rendered.words;
    const ratio = fullWords > 0 ? br.raw.words / fullWords : 1;
    let r = 25 * clamp(ratio / 0.9);
    const js = br.onlyAfterJs;
    const titleRewritten = !!br.raw.title && !!br.rendered.title && br.raw.title.trim() !== br.rendered.title.trim();
    r -= [js.title || titleRewritten, js.h1, js.canonical, js.description, js.jsonLd].filter(Boolean).length * 3;
    parts.push({ label: "Works without JavaScript", score: Math.round(clamp(r, 0, 25)), max: 25 });
  }

  // 3. Clean extraction (25)
  if (f?.stats) {
    let e = 0;
    if (br?.rendered && br.rendered.words > 0) e += 12 * clamp(f.stats.words / br.rendered.words / 0.5);
    else e += f.stats.words > 0 ? 12 : 0;
    e += f.stats.words >= 600 ? 8 : f.stats.words >= 300 ? 5 : f.stats.words >= 120 ? 2 : 0;
    e += f.stats.headings.length >= 3 ? 5 : f.stats.headings.length >= 1 ? 3 : 0;
    parts.push({ label: "Clean AI extraction", score: Math.round(clamp(e, 0, 25)), max: 25 });
  } else if (f?.pageError) {
    parts.push({ label: "Clean AI extraction", score: 0, max: 25 });
  }

  // 4. Metadata and structure (20)
  if (f?.page || br?.rendered) {
    const r = br?.rendered;
    let m = 0;
    if (f?.page?.title || r?.title) m += 4;
    if (f?.page?.description || r?.metaDescription) m += 4;
    if (r) {
      if (r.canonical) m += 3;
      if (r.jsonLd.blocks > 0 && r.jsonLd.parseErrors === 0) m += 4;
      if (r.htmlLang) m += 1;
      if (r.h1.length === 1) m += 2;
    } else {
      m += 5; // unknown without Browser; do not punish
    }
    const article = /Article|BlogPosting|NewsArticle/.test(r?.jsonLd.types.join(" ") || "") || r?.og.type === "article";
    if (!article || (f?.page?.author && f.page.publishedDate)) m += 2;
    parts.push({ label: "Metadata and structure", score: Math.round(clamp(m, 0, 20)), max: 20 });
  }

  const totalMax = parts.reduce((x, p) => x + p.max, 0);
  const readability = totalMax ? Math.round((parts.reduce((x, p) => x + p.score, 0) / totalMax) * 100) : 0;

  // Visibility
  const vparts: { label: string; score: number; max: number }[] = [];
  if (s && s.pagesChecked > 0) {
    const pos = s.target.position;
    const r = pos === null ? (s.domain.bestPosition ? 15 : 0) : pos <= 3 ? 70 : pos <= 10 ? 52 : 30;
    vparts.push({ label: `Rank for "${truncate(s.query, 40)}"`, score: r, max: 70 });
    if (s.indexProbe.query || pos !== null)
      vparts.push({ label: "Found in search index", score: s.indexProbe.found || pos !== null ? 30 : 0, max: 30 });
  }
  const vmax = vparts.reduce((x, p) => x + p.max, 0);
  const visibility = vmax ? Math.round((vparts.reduce((x, p) => x + p.score, 0) / vmax) * 100) : null;

  const a = b.agent?.answer;
  const answerability: Scores["answerability"] = !a
    ? "unknown"
    : !a.answer_found
      ? "not_answered"
      : answeredOnOtherPage(a) && !locateQuote(input).verified
        ? "answered_elsewhere"
        : a.answer_location === "visible_on_load" || a.answer_location === "after_scroll"
        ? "answered"
        : "answered_with_effort";

  const ranks = s?.target.position != null;
  const quadrant: Scores["quadrant"] =
    visibility === null ? "unknown" : readability >= 60 ? (ranks ? "readable_visible" : "readable_invisible") : ranks ? "unreadable_visible" : "unreadable_invisible";

  return { readability, visibility, answerability, quadrant, readabilityParts: parts, visibilityParts: vparts, missingStages: missingStages(input) };
}

/**
 * "pricingsaas.com (3 pages), en.wikipedia.org" instead of repeating a host once per page. Hosts, not
 * root domains, so newsletter.pricingsaas.com stays apart from pricingsaas.com, as in the findings.
 */
export function domainList(urls: string[]): string {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const d = bareHost(u) || u;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].map(([d, n]) => (n > 1 ? `${d} (${n} pages)` : d)).join(", ");
}

/** Plain-English lines that tie "can AI read it" to "does it show up". Built only from observed values. */
export function buildConnection(input: StageBundle, scores: Scores): string[] {
  const lines: string[] = [];
  const b = usableStages(input);
  const s = b.search;
  const br = b.browser;
  const f = b.fetch;
  const q = b.query;
  const pos = s?.target.position ?? null;
  const rawW = br?.raw?.words ?? null;
  const renW = br?.rendered?.words ?? null;
  const extW = f?.stats?.words ?? null;
  const partial = !!scoreNotes(scores).readability;
  const rd = `${scores.readability}/100${partial ? ", partial score" : ""}`; // inside parentheses

  switch (scores.quadrant) {
    case "unreadable_visible":
      lines.push(
        `Visible but hard to read: the page ranks #${pos} for "${q}", but scores ${scores.readability}/100 on AI readability${partial ? " (partial score)" : ""}. Classic rankings do not carry over to AI answers if the answer engine's crawler cannot read the text, so this is where the fastest gains are.`,
      );
      break;
    case "readable_invisible":
      lines.push(
        `Readable but not visible: AI tools can read this page (${rd}), but it does not show up for "${q}". Readability is not the bottleneck; relevance, coverage and links are. Start with the visibility and content-gap findings.`,
      );
      break;
    case "unreadable_invisible":
      lines.push(
        `Neither readable nor visible for "${q}" (readability ${rd}). Fix readability first: neither search engines nor AI tools can rank or cite text they cannot read.`,
      );
      break;
    case "readable_visible":
      lines.push(`Readable (${rd}) and visible${pos ? ` (#${pos})` : ""} for "${q}". The job now is to stay quotable: keep the answer early, specific and in the server HTML.`);
      break;
    default:
      lines.push(`AI readability: ${scores.readability}/100${partial ? " (partial score)" : ""}. Search visibility was not measured in this run.`);
  }
  const other = pos === null ? s?.domain.urls[0] : undefined;
  if (other) lines.push(`Another page on the same site ranks #${other.position} for "${q}" instead: ${displayUrl(other.url)}.`);
  if (input.browser?.challenge)
    lines.push(
      `A real browser received a bot challenge page${input.browser.challenge.title ? ` ("${input.browser.challenge.title}")` : ""} instead of the content, so AI browsing agents are likely to hit the same wall. Browser-based checks were skipped.`,
    );
  if (f?.robots.status === "unreadable") lines.push("robots.txt came back unreadable, so whether AI crawlers are allowed is unknown from this run.");
  const rc = input.browser?.rawChallenge;

  const gap = browserRenderIncomplete(b);
  if (gap && gap.notInRaw.words >= 40 && rawW !== null && !rc) {
    lines.push(
      `Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) receive ${rawW} words. TinyFish Fetch extracted ${gap.fetchWords}, with ${gap.notInRaw.words} words in lines that HTML does not contain, so much of the page text arrives through JavaScript. The remote browser's render was incomplete this run (${renW} words), so Fetch's text is the better guide.`,
    );
  } else if (gap) {
    lines.push(`The remote browser's render was incomplete this run: it showed ${renW} words, while Fetch extracted ${gap.fetchWords}. Browser-based checks may understate the page.`);
  } else if (rc && !input.browser?.challenge) {
    lines.push(
      `The first HTML response is a bot challenge (${rc.reason}); a browser gets through after JavaScript runs${renW !== null ? ` and sees ${renW} words` : ""}. Crawlers that skip JavaScript (GPTBot, ClaudeBot, PerplexityBot) stop at the challenge, so those engines have nothing to index.`,
    );
  } else if (rawW !== null && renW !== null && renW >= 120) {
    const ratio = rawW / renW;
    if (ratio < 0.7)
      lines.push(
        `Non-JavaScript crawlers (GPTBot, ClaudeBot, PerplexityBot) receive ${rawW} words; a browser shows ${renW}. ${pos ? `The page still ranks #${pos} in TinyFish Search, but ChatGPT, Claude and Perplexity crawlers work from the ${rawW}-word version.` : "Those engines index the smaller version, which makes ranking and citation less likely."}`,
      );
    else lines.push(`The server HTML already carries ${Math.round(ratio * 100)}% of the visible text, so crawlers that skip JavaScript see essentially the same page as users.`);
  }

  const blockedSearch = f?.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "ai_search") ?? [];
  const classicBlocked = f?.robots.verdicts.some((v) => !v.allowed && v.bot.purpose === "classic_search") ?? false;
  const indexedAnyway = classicBlocked && (pos !== null || !!s?.indexProbe.found);
  if (blockedSearch.length)
    lines.push(
      indexedAnyway
        ? `robots.txt, as served to TinyFish, excludes ${blockedSearch.map((v) => v.bot.operator).join(", ")} search crawlers. The page still ranks, so the site may treat verified crawlers differently; if those engines get the same file, the page cannot appear in their answers.`
        : `robots.txt excludes ${blockedSearch.map((v) => v.bot.operator).join(", ")} search crawlers, so this page cannot appear in those answer engines regardless of its Google ranking.`,
    );
  const edge = br?.botProbes.filter((p) => p.verdict === "blocked" && AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training") ?? [];
  if (edge.length)
    lines.push(
      `Requests sent with the ${edge.map((p) => p.bot).join(", ")} user-agent got a block or challenge page from your server or CDN. If the real crawler is blocked too, that engine cannot index the page at all, whatever robots.txt says.`,
    );

  const comps = s?.competitors.filter((c) => c.fetched && c.stats) ?? [];
  if (comps.length >= 2 && extW !== null) {
    const words = comps.map((c) => c.stats!.words).sort((x, y) => x - y);
    const median = words[Math.floor(words.length / 2)];
    lines.push(`The pages ${pos ? "around" : "ranking for"} this query give AI tools a median of ${median} extractable words (${domainList(comps.map((c) => c.url))}); this page gives ${extW}.`);
  }

  const a = input.agent?.answer;
  if (a) {
    const where = a.answer_location.replace(/_/g, " ");
    const loc = locateQuote(input);
    if (!a.answer_found && agentWasBlocked(a)) {
      lines.push(`An AI browsing agent looking for "${q}" was blocked before it could read the page (${[...new Set(a.blockers.map(blockerPhrase))].join(", ")}).`);
    } else if (!a.answer_found) {
      lines.push(`An AI browsing agent looking for "${q}" on the live page could not find an answer${a.missing_information.length ? `; it reported missing: ${a.missing_information.slice(0, 3).join("; ")}` : ""}.`);
    } else if (answeredOnOtherPage(a) && !loc.verified) {
      lines.push(
        `An AI browsing agent found an answer to "${q}" only on another page it opened (${a.interactions_needed.join(", then ") || "a linked page"}). This page itself does not contain it, so answer engines would cite the other page.`,
      );
    } else if (a.evidence_quote && !loc.verified && a.answer_location === "after_interaction") {
      lines.push(`An AI browsing agent answered "${q}" only after interacting with the page (${a.interactions_needed.join(", then ") || "clicks"}); that text is not in what fetch tools or non-JavaScript crawlers receive.`);
    } else if (a.evidence_quote && !loc.verified) {
      lines.push(`An AI browsing agent answered "${q}" (${where}). Its quote was paraphrased rather than copied from the page, so which crawlers receive that text could not be checked.`);
    } else if (a.evidence_quote) {
      const seenBy = [loc.inFetch ? "fetch tools" : null, loc.inRaw ? "non-JavaScript crawlers" : null].filter(Boolean);
      const missedBy = [loc.inFetch === false ? "fetch tools" : null, loc.inRaw === false ? "non-JavaScript crawlers" : null].filter(Boolean);
      lines.push(
        missedBy.length
          ? `An AI browsing agent answered "${q}" (${where}), but ${missedBy.join(" and ")} never receive that answer${seenBy.length ? `; ${seenBy.join(" and ")} do` : ""}. Answer engines can only quote what they receive.`
          : `An AI browsing agent answered "${q}" (${where}), and the same answer is in what ${seenBy.join(" and ") || "crawlers"} receive.`,
      );
    }
  }

  lines.push("Rankings come from TinyFish Search, which runs its own index; treat positions as directional, not as Google positions.");
  return lines;
}

export function buildReport(stages: StageBundle, input: { url: string; query?: string; location?: string }): AuditReport {
  // Use the plain-text robots.txt from the browser when it parses (see robotsSource.ts).
  const b = withBrowserRobots(stages);
  const scores = computeScores(b);
  const findings = buildFindings(b);
  const doToday = findings
    // Only things worth doing today: low and info findings stay in the full list.
    .filter((f) => f.severity === "critical" || f.severity === "high" || (f.severity === "medium" && f.fix.effort !== "days"))
    .slice(0, 5)
    .map((f) => f.id);
  const calls: CallLog[] = [...(b.fetch?.calls ?? []), ...(b.browser?.calls ?? []), ...(b.search?.calls ?? []), ...(b.agent?.calls ?? [])];
  const extracted = b.fetch?.page ? markdownToPlain(b.fetch.page.markdown).replace(/\s+/g, " ").trim() : "";
  return {
    generatedAt: new Date().toISOString(),
    input,
    query: b.query,
    queryDerived: b.queryDerived,
    scores,
    connection: buildConnection(b, scores),
    findings,
    strengths: buildStrengths(b),
    doToday,
    views: {
      blockedNote: b.browser?.challenge
        ? `TinyFish Browser received a bot challenge page${b.browser.challenge.title ? ` ("${b.browser.challenge.title}")` : ""}; browser word counts are not available.`
        : b.browser?.rawChallenge
          ? "The first HTML response was a bot challenge page, so there is no raw server HTML word count for the real page."
          : browserRenderIncomplete(b)
            ? `The remote browser's render was incomplete this run: it showed fewer words than Fetch extracted, so the rendered count understates the page.`
            : null,
      rawWords: b.browser?.challenge || b.browser?.rawChallenge ? null : (b.browser?.raw?.words ?? null),
      renderedWords: b.browser?.challenge ? null : (b.browser?.rendered?.words ?? null),
      extractedWords: b.fetch?.stats?.words ?? null,
      rawSample: truncate(b.browser?.raw?.text ?? "", 700),
      extractedSample: truncate(extracted, 700),
    },
    calls,
    stages: { fetch: b.fetch, browser: b.browser, search: b.search, agent: b.agent },
  };
}
