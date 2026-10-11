// Findings engine. Every finding is built from values observed in this audit (no generic tips),
// says which TinyFish endpoint produced the evidence, explains the effect on visibility, and gives
// a fix the site owner can apply today.

import type {
  AgentAnswer,
  AgentStageResult,
  BrowserStageResult,
  Finding,
  FetchStageResult,
  SearchStageResult,
  Severity,
  Source,
} from "../types";
import { markdownToPlain } from "../parse/markdown";
import { containsTerm, contentTokens, normForMatch, phraseSet, queryCoverage, quoteAppearsIn, stem, truncate } from "./text";
import { bareHost, displayUrl, oneLineError, rootDomain, sameUrl } from "../url";
import { fetchErrorHelp } from "./fetchErrors";
import { AI_BOTS } from "../parse/robots";

export interface StageBundle {
  fetch: FetchStageResult | null;
  browser: BrowserStageResult | null;
  search: SearchStageResult | null;
  agent: AgentStageResult | null;
  query: string;
  queryDerived: boolean;
  url: string;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const EFFORT_RANK = { minutes: 0, hours: 1, days: 2 } as const;
const CONF_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Severity first; within a severity, what the evidence confirms comes before quick wins it only suggests. */
export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
      EFFORT_RANK[a.fix.effort] - EFFORT_RANK[b.fix.effort],
  );
}

/* Helpers */

/** Query words as the user typed them, for stems computed internally. */
function shown(query: string, stems: string[]): string {
  const originals = contentTokens(query);
  return stems.map((st) => originals.find((w) => stem(w) === st) ?? st).join(", ");
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/**
 * The query with each word written the way the page writes it ("pricingsaas" becomes "PricingSaaS"
 * when the page says "PricingSaaS"). Words the page only has in lower case are capitalized.
 */
export function pageCasing(query: string, sources: (string | null | undefined)[]): string {
  const hay = sources.filter(Boolean).join(" ");
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu");
      const forms = [...hay.matchAll(re)].map((m) => m[0]).filter((m) => m !== m.toLowerCase());
      // Mixed case is how the page spells the word. All caps is usually styling ("LEARN REACT" in a
      // nav), except for short acronyms such as SEO or API.
      const mixed = forms.find((m) => m !== m.toUpperCase());
      const acronym = forms.find((m) => m.length <= 4);
      return mixed ?? acronym ?? titleCase(w.toLowerCase());
    })
    .join(" ");
}

function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : "n/a";
}

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

// Notices, banners and site chrome that should never become a page description.
const BOILERPLATE = /redirects here|from wikipedia|please help|this article|learn how and when|cookie|subscribe|sign in|log in|javascript|skip to|all rights reserved|table of contents/i;

function fitToLength(text: string, max = 155): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  // A sentence ends at . ! or ? followed by a space or the end, so "No.1", "3.4M" and "v2.0" stay whole.
  const sentences = t.match(/.+?[.!?](?=\s|$)/g) || [];
  let out = "";
  for (const s of sentences) {
    const next = (out + " " + s.trim()).trim();
    if (next.length > max) break;
    out = next;
  }
  return out.length >= 60 ? out : t.slice(0, max - 3).replace(/\s+\S*$/, "") + "...";
}

/**
 * Drafts a meta description. Prefers the agent's own answer to the query (it is a direct answer,
 * which is what a good description is), else the first substantive paragraph of the extracted text.
 */
/** The agent's answer, only when it answered from the page. */
function agentSummary(b: StageBundle): string | null {
  const a = b.agent?.answer;
  // An agent that answered read the page, even if it had to get past a block first (Reddit).
  return a?.answer_found ? a.answer_summary : null;
}

/** A search snippet as a description draft: no leading date, no unfinished last sentence ("problems…"). */
export function snippetDraft(snippet: string | null | undefined): string | null {
  if (!snippet) return null;
  const s = snippet
    .replace(/^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}\s*[\u2014\u2013-]\s*/, "")
    .replace(/[\s\u00b7]+$/, "")
    .replace(/\s*[^.!?]*(?:\u2026|\.\.\.)\s*$/, "")
    .trim();
  return s.split(/\s+/).length >= 8 ? s : null;
}

/**
 * Agent summaries talk about the page ("The react.dev/learn page is the official..."); a description
 * should speak as the page, so the lead-in is dropped: "The official...".
 */
export function withoutPageFraming(s: string): string {
  const m = s.match(/^(?:this|the)\s+(?:[\w./:-]+\s+)?(?:web\s*)?page\s+(?:is|provides|offers|contains|gives|presents|serves as)\s+(.+)$/i);
  if (!m) return s;
  const rest = m[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Dash punctuation from agent summaries ("80% of core concepts\u2014components, JSX") becomes plain punctuation. */
export function plainDashes(s: string): string {
  return s.replace(/\s*[\u2014\u2013]\s*(?=\S)/g, (m, off: number, all: string) => (/\d$/.test(all.slice(0, off)) && /^\s*[\u2013]\s*\d/.test(all.slice(off)) ? "-" : ", "));
}

export function suggestDescription(markdown: string, h1: string | null, agentAnswer?: string | null, searchSnippet?: string | null): string {
  // Cleaned before drafting, so the length limit applies to the final text.
  return draftDescription(plainDashes(markdown), h1, agentAnswer && plainDashes(agentAnswer), searchSnippet && plainDashes(searchSnippet));
}

function draftDescription(markdown: string, h1: string | null, agentAnswer?: string | null, searchSnippet?: string | null): string {
  if (agentAnswer && agentAnswer.split(/\s+/).length >= 8) return fitToLength(withoutPageFraming(agentAnswer.trim())).replace(/"/g, "'");
  // The engine's own snippet describes the page better than the first paragraph of a feed or listing.
  const snip = snippetDraft(searchSnippet);
  if (snip) return fitToLength(snip).replace(/"/g, "'");
  const blocks = markdown.split(/\n\s*\n/).map((b) => b.trim());
  for (const b of blocks) {
    if (/^(#|\||[-*+]\s|\d+[.)]\s|>)/.test(b)) continue;
    const plain = markdownToPlain(b).replace(/\s+/g, " ").trim();
    if (plain.split(" ").length < 12 || BOILERPLATE.test(plain)) continue;
    if (h1 && plain.toLowerCase() === h1.toLowerCase()) continue;
    return fitToLength(plain).replace(/"/g, "'");
  }
  return fitToLength(markdownToPlain(markdown)).replace(/"/g, "'");
}

function ssrAdvice(hints: string[]): string {
  const h = hints.join(" ");
  if (/Next\.js/.test(h)) return "Next.js detected: render this content in a Server Component (App Router) or with getStaticProps/getServerSideProps (Pages Router). Move data fetching out of useEffect and keep 'use client' for interactive widgets only.";
  if (/Nuxt/.test(h)) return "Nuxt detected: keep ssr: true in nuxt.config and load content with useAsyncData or useFetch so it runs on the server.";
  if (/Angular/.test(h)) return "Angular detected: add server-side rendering with `ng add @angular/ssr` and prerender content routes.";
  if (/SvelteKit/.test(h)) return "SvelteKit detected: keep `export const ssr = true` and load content in +page.server.js load().";
  if (/Vite SPA|Create React App/.test(h)) return "Client-only React or Vue app detected: prerender content routes at build time, or move content pages to an SSR framework (Next.js, Remix, Astro, Nuxt).";
  if (/Gatsby/.test(h)) return "Gatsby detected: load this content at build time with a page query instead of fetching it in the browser.";
  if (/Astro/.test(h)) return "Astro detected: avoid client:only for content components so Astro renders their HTML at build time.";
  if (/WordPress/.test(h)) return "WordPress detected: content is likely injected by a page-builder widget or plugin script. Put the text in the post content or a server-rendered block.";
  if (/Wix|Squarespace|Webflow|Framer/.test(h)) return `${hints[0]} detected: text inside custom code embeds or third-party widgets renders in the browser. Move key text into native text blocks.`;
  return "Serve the main content in the initial HTML response using server-side rendering, static generation, or build-time prerendering.";
}

function articleLike(b: StageBundle): boolean {
  const r = b.browser?.rendered;
  const types = r?.jsonLd.types.join(" ") || "";
  if (/Article|BlogPosting|NewsArticle/.test(types)) return true;
  // JSON-LD that names another type (Person, Product, ProfilePage...) wins over a generic og:type.
  if (types && /Person|ProfilePage|Product|Organization|WebSite|CollectionPage/.test(types)) return /\/(blog|news|article|articles|posts?)\/.+/i.test(pagePath(b.url));
  return r?.og.type === "article" || /\/(blog|news|article|articles|posts?)\/.+/i.test(pagePath(b.url));
}

function guessSchemaType(b: StageBundle): "Article" | "Product" | "WebSite" | "WebPage" {
  if (articleLike(b)) return "Article";
  const text = b.browser?.rendered?.text || b.fetch?.page?.markdown || "";
  if (/(add to (cart|bag)|in stock|out of stock)/i.test(text) && /[$€£]\s?\d/.test(text)) return "Product";
  if (pagePath(b.url) === "/" || pagePath(b.url) === "") return "WebSite";
  return "WebPage";
}

function jsonLdSuggestion(b: StageBundle): string {
  const type = guessSchemaType(b);
  const r = b.browser?.rendered;
  const p = b.fetch?.page;
  const url = b.browser?.finalUrl || p?.finalUrl || b.url;
  const title = r?.title || p?.title || "Page title";
  const desc = r?.metaDescription || p?.description || (p ? suggestDescription(p.markdown, r?.h1[0] ?? null, agentSummary(b), b.search?.target.serpSnippet) : "Short description");
  const image = r?.og.image || p?.imageLinks[0] || undefined;
  const site = rootDomain(url);
  let obj: Record<string, unknown>;
  if (type === "Article") {
    obj = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: (r?.h1[0] || title).slice(0, 110),
      description: desc,
      url,
      ...(image ? { image } : {}),
      author: { "@type": "Person", name: p?.author || "AUTHOR NAME" },
      datePublished: p?.publishedDate || "YYYY-MM-DD",
      dateModified: "YYYY-MM-DD",
      publisher: { "@type": "Organization", name: site },
    };
  } else if (type === "Product") {
    obj = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: r?.h1[0] || title,
      description: desc,
      url,
      ...(image ? { image } : {}),
      offers: { "@type": "Offer", price: "PRICE", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    };
  } else if (type === "WebSite") {
    obj = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: site, url, ...(image ? { logo: image } : {}) },
        { "@type": "WebSite", name: site, url },
      ],
    };
  } else {
    obj = { "@context": "https://schema.org", "@type": "WebPage", name: title, description: desc, url };
  }
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

/* Checks */

function accessChecks(b: StageBundle, out: Finding[]) {
  const f = b.fetch;
  const br = b.browser;

  // Fetch could not read the page at all
  if (f?.pageError) {
    const code = f.pageError.error;
    const fatal = ["bot_blocked", "login_required", "empty_content", "page_not_found", "target_http_error", "target_unreachable"].includes(code);
    const fixes: Record<string, string[]> = {
      bot_blocked: [
        "In your CDN or WAF bot settings, allow verified search and AI search crawlers: Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot, PerplexityBot.",
        "If you use Cloudflare, review the AI crawler / bot blocking settings for this zone; new zones may block AI crawlers by default.",
        "Re-run this audit to confirm Fetch receives the page instead of a challenge.",
      ],
      login_required: ["Publish a public version of this content (or a public summary page) at a crawlable URL.", "Link to it from public pages and the sitemap."],
      empty_content: ["Check that the HTML contains real text, not only images, canvas or an empty app shell.", "See the rendering findings below for what the raw HTML contains."],
      timeout: ["Reduce server response time and heavy third-party scripts.", "Check the page loads in under 5 seconds on a cold cache."],
    };
    out.push({
      id: "access-fetch-failed",
      category: "access",
      severity: fatal ? "critical" : "high",
      confidence: "high",
      title: `AI fetch tools cannot read this page (${code})`,
      evidence: [`TinyFish Fetch error: ${code}${f.pageError.status ? ` (HTTP ${f.pageError.status})` : ""}. ${fetchErrorHelp(code)}`],
      visibilityImpact: "If an AI tool cannot fetch the page, it cannot quote or cite it, no matter how well it ranks elsewhere.",
      fix: { summary: "Make the page fetchable by automated readers", steps: fixes[code] || ["Fix the server error and re-run the audit."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // robots.txt: search and AI search crawlers
  if (f) {
    const path = pagePath(f.page?.finalUrl || b.url);
    const blockedSearch = f.robots.verdicts.filter((v) => !v.allowed && (v.bot.purpose === "ai_search" || v.bot.purpose === "classic_search"));
    // A page that robots.txt closes to Googlebot but that ranks or is indexed anyway: the site likely
    // serves verified crawlers a different robots.txt (or has an agreement with them), or the rule is
    // newer than the index. The file is real, but what it means for each crawler is uncertain.
    const pos = b.search?.target.position ?? null;
    const classic = blockedSearch.some((v) => v.bot.purpose === "classic_search");
    const indexedAnyway = classic && (pos !== null || !!b.search?.indexProbe.found);
    const sameFileCaveat = `This is the robots.txt served to TinyFish; the site may serve verified crawlers a different one, have agreements with some engines, or have added the rule after the page was indexed.`;
    if (blockedSearch.length) {
      const starGroup = blockedSearch.filter((v) => v.matchedGroup === "*").map((v) => v.bot.token);
      const ownGroup = blockedSearch.filter((v) => v.matchedGroup !== "*");
      const code = [
        ...(starGroup.length
          ? [`# Give these crawlers their own group so the "*" rules no longer apply to them`, ...starGroup.map((t) => `User-agent: ${t}`), "Allow: /", ""]
          : []),
        ...ownGroup.map((v) => `# In the existing "User-agent: ${v.matchedGroup}" group, remove or narrow:\n#   ${v.matchedRule}\n# or add this more specific rule to that group:\nAllow: ${path}`),
      ].join("\n");
      out.push({
        id: "access-robots-search-blocked",
        category: "access",
        severity: indexedAnyway ? "high" : classic || blockedSearch.length >= 2 ? "critical" : "high",
        confidence: indexedAnyway ? "low" : "high",
        title: `robots.txt blocks ${blockedSearch.map((v) => v.bot.token).join(", ")} from this URL`,
        evidence: [
          ...blockedSearch.map((v) => `${v.bot.token} (${v.bot.operator}): blocked by "${v.matchedRule}" in group "User-agent: ${v.matchedGroup}". ${v.bot.note}`),
          ...(indexedAnyway
            ? [
                `Yet the page ${pos !== null ? `ranks #${pos} for "${b.search!.query}"` : "is in the search index"}, so search engines still reach it. ${sameFileCaveat}`,
              ]
            : []),
        ],
        visibilityImpact:
          "OpenAI states that sites opted out of OAI-SearchBot are not shown in ChatGPT search answers; Anthropic and Perplexity describe the same for their search crawlers. Blocking Googlebot or Bingbot removes the page from classic search and from AI Overviews or Copilot.",
        fix: { summary: "Allow search crawlers on this path (skip if the block is intentional)", steps: ["Edit robots.txt as shown.", "Re-run the audit; the robots table should show these bots as allowed."], code, effort: "minutes" },
        sources: ["fetch"],
      });
    }

    const blockedUser = f.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "user_fetch" && v.bot.respectsRobots);
    if (blockedUser.length) {
      out.push({
        id: "access-robots-user-blocked",
        category: "access",
        severity: "medium",
        // Same file as the search-crawler finding, so the same doubt applies when the page ranks anyway.
        confidence: indexedAnyway ? "low" : "high",
        title: `robots.txt blocks on-demand fetches by ${blockedUser.map((v) => v.bot.token).join(", ")}`,
        evidence: [
          ...blockedUser.map((v) => `${v.bot.token}: "${v.matchedRule}" (group ${v.matchedGroup})`),
          ...(indexedAnyway ? [`The page ranks or is indexed despite this file blocking Googlebot. ${sameFileCaveat}`] : []),
        ],
        visibilityImpact: "When a user pastes this URL or asks about it, the assistant will not retrieve the page, so it answers from other sources.",
        fix: { summary: "Allow user-initiated fetchers unless you have a reason not to", steps: blockedUser.map((v) => `Remove "${v.matchedRule}" for ${v.bot.token}, or add "Allow: ${path}" to its group.`), effort: "minutes" },
        sources: ["fetch"],
      });
    }

    const blockedTraining = f.robots.verdicts.filter((v) => !v.allowed && v.bot.purpose === "training");
    if (blockedTraining.length) {
      out.push({
        id: "access-robots-training-blocked",
        category: "access",
        severity: "info",
        confidence: "high",
        title: `Training crawlers blocked: ${blockedTraining.map((v) => v.bot.token).join(", ")}`,
        evidence: blockedTraining.map((v) => `${v.bot.token}: ${v.bot.note}`),
        visibilityImpact: "Per OpenAI, Anthropic and Google docs these tokens control model training, not search results. This does not reduce search or AI search visibility on its own.",
        fix: { summary: "No action needed if intentional", steps: ["Keep the block if you do not want your content used for training."], effort: "minutes" },
        sources: ["fetch"],
      });
    }
  }

  // noindex / nosnippet
  const robotsMeta = [br?.raw?.metaRobots, br?.rendered?.metaRobots, br?.headers.xRobotsTag].filter(Boolean).join(", ").toLowerCase();
  if (robotsMeta) {
    if (/noindex|(^|[\s,])none([\s,]|$)/.test(robotsMeta)) {
      out.push({
        id: "access-noindex",
        category: "access",
        severity: "critical",
        confidence: "high",
        title: "The page tells search engines not to index it",
        evidence: [
          br?.raw?.metaRobots ? `Raw HTML meta robots: "${br.raw.metaRobots}"` : "",
          br?.rendered?.metaRobots && br.rendered.metaRobots !== br.raw?.metaRobots ? `Rendered meta robots (set by JavaScript): "${br.rendered.metaRobots}"` : "",
          br?.headers.xRobotsTag ? `X-Robots-Tag header: "${br.headers.xRobotsTag}"` : "",
        ].filter(Boolean),
        visibilityImpact: "Google requires a page to be indexed to appear in Search, AI Overviews or AI Mode. A noindex page cannot be a cited source there.",
        fix: { summary: "Remove noindex if this page should be found", steps: ["Remove noindex from the meta robots tag and the X-Robots-Tag header.", "Request reindexing in Google Search Console and Bing Webmaster Tools."], effort: "minutes" },
        sources: ["browser"],
      });
    }
    const maxSnip = robotsMeta.match(/max-snippet\s*:\s*(-?\d+)/);
    if (/nosnippet/.test(robotsMeta) || (maxSnip && Number(maxSnip[1]) >= 0 && Number(maxSnip[1]) < 50)) {
      out.push({
        id: "access-nosnippet",
        category: "access",
        severity: /nosnippet/.test(robotsMeta) || Number(maxSnip?.[1]) === 0 ? "high" : "medium",
        confidence: "high",
        title: "Snippet controls limit what search and AI features can show",
        evidence: [`Robots directives found: "${robotsMeta}"`],
        visibilityImpact: "Google documents that nosnippet, max-snippet and data-nosnippet also limit how content is used in AI Overviews and AI Mode.",
        fix: { summary: "Loosen snippet limits", steps: ["Remove nosnippet, or set max-snippet:-1 to allow normal snippets."], code: `<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">`, effort: "minutes" },
        sources: ["browser"],
      });
    }
  }
  if (br?.rendered && br.rendered.dataNosnippetCount > 0) {
    out.push({
      id: "access-data-nosnippet",
      category: "access",
      severity: "low",
      confidence: "high",
      title: `${br.rendered.dataNosnippetCount} element(s) marked data-nosnippet`,
      evidence: [`data-nosnippet elements in the rendered DOM: ${br.rendered.dataNosnippetCount}`],
      visibilityImpact: "Text inside these elements is excluded from Google snippets and AI features. Fine for boilerplate, harmful if it wraps the main answer.",
      fix: { summary: "Check that data-nosnippet does not wrap your key content", steps: ["Search your templates for data-nosnippet and keep it only on boilerplate."], effort: "minutes" },
      sources: ["browser"],
    });
  }

  // Edge blocking of AI crawler user agents. Search crawlers decide visibility; training crawlers do not.
  if (br?.botProbes.length) {
    const purposeOf = (bot: string) => AI_BOTS.find((x) => x.token === bot)?.purpose ?? "ai_search";
    const bad = br.botProbes.filter((p) => p.verdict === "blocked" || p.verdict === "degraded");
    const badSearch = bad.filter((p) => purposeOf(p.bot) !== "training");
    const badTraining = bad.filter((p) => purposeOf(p.bot) === "training");
    const robotsAllows = f?.robots.status === "unreadable" ? [] : (f?.robots.verdicts.filter((v) => v.allowed).map((v) => v.bot.token) ?? []);
    const evidenceFor = (list: typeof bad) => {
      const allowedBots = list.filter((p) => robotsAllows.includes(p.bot)).map((p) => p.bot);
      const names = allowedBots.length > 1 ? `${allowedBots.slice(0, -1).join(", ")} and ${allowedBots[allowedBots.length - 1]}` : allowedBots[0];
      return [
        `Normal browser request: HTTP ${br.status}, ${br.raw?.words ?? 0} words in raw HTML.`,
        ...list.map((p) => `${p.bot} user-agent: HTTP ${p.status ?? "error"}, ${p.words} words${p.challenge ? ", bot challenge page" : ""} (${p.verdict}).`),
        allowedBots.length ? `robots.txt allows ${names}, so this block happens at the server or CDN, not in robots.txt.` : "",
        "Caveat: requests came from a TinyFish residential IP with representative user-agent strings. Real crawlers use verified IP ranges and may be treated differently.",
      ].filter(Boolean);
    };
    if (badSearch.length) {
      out.push({
        id: "access-edge-blocks-ai-bots",
        category: "access",
        severity: badSearch.some((p) => p.verdict === "blocked") ? "high" : "medium",
        confidence: "medium",
        title: `Server or CDN blocks AI search crawler user-agents (${badSearch.map((p) => p.bot).join(", ")})`,
        evidence: evidenceFor(badSearch),
        visibilityImpact: "These crawlers decide whether the page can appear in ChatGPT, Claude or Perplexity search answers. If the real crawler gets a challenge page, the page is not indexed there even though robots.txt allows it.",
        fix: {
          summary: "Allow verified AI search crawlers at the edge",
          steps: [
            "Check your CDN or WAF rules for user-agent based blocks (Cloudflare AI crawler blocking, Akamai bot manager, custom rules).",
            "Allow verified OAI-SearchBot, Claude-SearchBot and PerplexityBot. Verify by published IP ranges rather than user-agent alone.",
            "Check server logs for 403 responses to these user-agents.",
          ],
          effort: "hours",
        },
        sources: ["browser"],
      });
    }
    if (badTraining.length) {
      out.push({
        id: "access-edge-blocks-training-bots",
        category: "access",
        severity: "low",
        confidence: "medium",
        title: `Server or CDN blocks the training crawler user-agent (${badTraining.map((p) => p.bot).join(", ")})`,
        evidence: evidenceFor(badTraining),
        visibilityImpact:
          "This crawler collects data for model training, not search. Blocking it does not remove the page from AI search answers; the search crawlers above decide that. Many sites block it on purpose.",
        fix: { summary: "No action needed if intentional", steps: ["Keep the rule if you do not want your content used for training.", "Make sure the same rule does not also catch the search crawlers."], effort: "minutes" },
        sources: ["browser"],
      });
    }
  }

  // HTTP status and redirects
  if (br?.ok && br.status !== null && br.status >= 400 && !f?.pageError) {
    out.push({
      id: "access-http-status",
      category: "access",
      severity: "critical",
      confidence: "high",
      title: `Page returns HTTP ${br.status} to a real browser`,
      evidence: [`Browser navigation status: ${br.status}`],
      visibilityImpact: "Search engines drop pages that return error codes. AI crawlers treat them as missing.",
      fix: { summary: "Return 200 for this URL", steps: ["Fix the route or redirect it with a 301 to the right page."], effort: "hours" },
      sources: ["browser"],
    });
  }
  if (br && br.redirectChain.length >= 2) {
    out.push({
      id: "access-redirect-chain",
      category: "access",
      severity: "low",
      confidence: "high",
      title: `${br.redirectChain.length} redirects before the page loads`,
      evidence: [...br.redirectChain, `final: ${br.finalUrl}`],
      visibilityImpact: "Each hop costs crawl time and some fetchers stop following after a few redirects.",
      fix: { summary: "Link and redirect straight to the final URL", steps: [`Update internal links and the sitemap to ${br.finalUrl}.`, "Collapse the chain into a single 301."], effort: "minutes" },
      sources: ["browser"],
    });
  }

  // Canonical
  const canonical = br?.rendered?.canonical || br?.raw?.canonical || null;
  const finalUrl = br?.finalUrl || f?.page?.finalUrl || b.url;
  if (br?.ok) {
    if (canonical) {
      let abs = canonical;
      try {
        abs = new URL(canonical, finalUrl).toString();
      } catch {
        /* keep */
      }
      if (!sameUrl(abs, finalUrl)) {
        out.push({
          id: "access-canonical-elsewhere",
          category: "access",
          severity: "high",
          confidence: "high",
          title: "Canonical tag points to a different URL",
          evidence: [`This URL: ${finalUrl}`, `Canonical: ${abs}`],
          visibilityImpact: "Search engines index and credit the canonical URL, not this one. If this is not intended, this page will not rank or be cited on its own.",
          fix: { summary: "Point the canonical at this URL (unless it is a true duplicate)", steps: ["Set the canonical to the page's own preferred URL."], code: `<link rel="canonical" href="${finalUrl}">`, effort: "minutes" },
          sources: ["browser"],
        });
      }
    } else {
      out.push({
        id: "access-canonical-missing",
        category: "metadata",
        severity: "low",
        confidence: "high",
        title: "No canonical tag",
        evidence: ["No <link rel=\"canonical\"> in raw or rendered HTML."],
        visibilityImpact: "Without a canonical, URL variants (tracking parameters, trailing slashes) can split ranking signals.",
        fix: { summary: "Add a self-referencing canonical", steps: ["Add it to the <head> of the server HTML."], code: `<link rel="canonical" href="${finalUrl}">`, effort: "minutes" },
        sources: ["browser"],
      });
    }
  }

  // Sitemap and llms.txt
  if (f && f.sitemap.containsUrl === false) {
    out.push({
      id: "access-not-in-sitemap",
      category: "access",
      severity: "low",
      confidence: "medium",
      title: "Page is not listed in the sitemap",
      evidence: [`Checked: ${f.sitemap.checkedUrl}`, f.sitemap.note],
      visibilityImpact: "Sitemaps help crawlers find and re-crawl pages. Missing pages are discovered later and refreshed less often.",
      fix: { summary: "Add this URL to the sitemap", steps: [`Add <url><loc>${finalUrl}</loc><lastmod>YYYY-MM-DD</lastmod></url>.`], effort: "minutes" },
      sources: ["fetch"],
    });
  } else if (f && !f.sitemap.checkedUrl && f.robots.status !== "unreadable") {
    out.push({
      id: "access-no-sitemap",
      category: "access",
      severity: "low",
      confidence: "medium",
      title: "No sitemap found",
      evidence: [f.sitemap.note],
      visibilityImpact: "Crawlers rely only on links to find pages.",
      fix: { summary: "Publish a sitemap and reference it in robots.txt", steps: ["Generate /sitemap.xml.", "Add `Sitemap: https://your-site/sitemap.xml` to robots.txt."], effort: "hours" },
      sources: ["fetch"],
    });
  }
  if (f && !f.llmsTxt.found) {
    out.push({
      id: "access-llms-txt",
      category: "access",
      severity: "info",
      confidence: "medium",
      title: "No llms.txt (low priority)",
      evidence: [`${f.llmsTxt.url} not found.`],
      visibilityImpact:
        "Large studies have found no clear link between llms.txt and AI citations, and Google says it does not use it. It is cheap to add but should not come before the fixes above.",
      fix: { summary: "Optional", steps: ["Only add llms.txt after the higher-severity fixes are done."], effort: "minutes" },
      sources: ["fetch"],
    });
  }
}

/**
 * True when most of the page text arrives through JavaScript and Fetch extracted no more than the
 * server HTML holds (Medium's blog: 49 raw words, 1659 rendered, 22 extracted). Fetch then saw the
 * pre-JavaScript page, so the missing text is a rendering problem, not text the extractor threw away.
 */
export function fetchMissedJsContent(b: StageBundle): boolean {
  const br = b.browser;
  const words = b.fetch?.stats?.words;
  if (!br?.ok || !br.raw || !br.rendered || br.rawChallenge || words == null) return false;
  if (br.rendered.words < 80 || br.raw.words / br.rendered.words >= 0.7) return false;
  return words <= br.raw.words * 1.25 + 20;
}

function renderingChecks(b: StageBundle, out: Finding[]) {
  const br = b.browser;
  if (!br?.ok || !br.raw || !br.rendered) return;
  // The raw HTML was a challenge page, not the server's version of this page: comparing it with the
  // rendered page would blame JavaScript for what is a bot block (reported by challengeChecks).
  if (br.rawChallenge) return;
  const raw = br.raw;
  const ren = br.rendered;
  const ratio = ren.words > 0 ? raw.words / ren.words : 1;
  const coverage = b.query ? queryCoverage(b.query, ren.text, "", []) : null;
  const rawCoverage = b.query ? queryCoverage(b.query, raw.text, "", []) : null;
  const termsOnlyAfterJs = coverage && rawCoverage ? coverage.inText.filter((t) => !rawCoverage.inText.includes(t)) : [];

  if (ren.words >= 80 && ratio < 0.7) {
    // Severity follows how much text is missing, not only the ratio: 61 missing words on a 107-word
    // profile page matter less than 1,700 missing words on a blog index.
    const jsOnlyWords = ren.words - raw.words;
    const nothingWithoutJs = raw.emptyAppShell || raw.words < 30;
    const severity: Severity =
      nothingWithoutJs || (ratio < 0.3 && jsOnlyWords >= 150) ? "critical" : jsOnlyWords >= 150 ? "high" : "medium";
    const fetchMissed = fetchMissedJsContent(b);
    out.push({
      id: "render-js-dependent-content",
      category: "rendering",
      severity,
      confidence: "high",
      title: `${pct(ren.words - raw.words, ren.words)} of the page text only appears after JavaScript runs`,
      evidence: [
        `Raw server HTML: ${raw.words} words. Rendered DOM: ${ren.words} words.`,
        severity === "medium" ? `JavaScript adds ${jsOnlyWords} words, which is a small amount in absolute terms.` : "",
        raw.emptyAppShell ? "The raw HTML is an empty app shell (a root div with almost no text)." : "",
        fetchMissed ? `TinyFish Fetch extracted ${b.fetch!.stats!.words} words, no more than the raw HTML holds, so fetch-based AI tools miss this text too.` : "",
        br.onlyAfterJs.headings.length ? `Headings missing from raw HTML: ${[...new Set(br.onlyAfterJs.headings)].slice(0, 5).map((h) => `"${h}"`).join(", ")}` : "",
        termsOnlyAfterJs.length ? `Query words only present after JavaScript: ${shown(b.query, termsOnlyAfterJs)}` : "",
        raw.frameworkHints.length ? `Detected stack: ${raw.frameworkHints.join(", ")}` : "",
      ].filter(Boolean),
      visibilityImpact:
        "GPTBot, ClaudeBot and PerplexityBot fetch HTML but do not execute JavaScript (Vercel crawler study, Dec 2024). They see the raw HTML only, so this content cannot be indexed or cited by those engines. Googlebot and Gemini do render JavaScript, but later and less reliably.",
      fix: { summary: "Put the main content in the server HTML", steps: [ssrAdvice(raw.frameworkHints), "Verify with: curl -s URL | grep \"a sentence from your page\"", "Re-run this audit; raw and rendered word counts should be close."], effort: "days" },
      sources: fetchMissed ? ["browser", "fetch"] : ["browser"],
    });
  } else if (termsOnlyAfterJs.length) {
    out.push({
      id: "render-query-terms-js-only",
      category: "rendering",
      severity: "high",
      confidence: "high",
      title: `Your target words appear only after JavaScript: ${shown(b.query, termsOnlyAfterJs)}`,
      evidence: [`Query: "${b.query}"`, `Present in rendered DOM, absent from raw HTML: ${shown(b.query, termsOnlyAfterJs)}`],
      visibilityImpact: "Non-rendering AI crawlers will not associate this page with the query.",
      fix: { summary: "Render the section that answers the query on the server", steps: [ssrAdvice(raw.frameworkHints)], effort: "hours" },
      sources: ["browser"],
    });
  }

  const js = br.onlyAfterJs;
  // A title that JavaScript rewrites (e.g. "Loading" -> "Pricing | Acme") is as bad as a missing one for non-JS crawlers.
  const titleRewritten = !!raw.title && !!ren.title && normForMatch(raw.title) !== normForMatch(ren.title);
  // "Medium" -> "The Medium Blog" still gives crawlers a real, shorter title; a placeholder that has
  // nothing in common with the final title ("Loading", "React App") is the serious case.
  const titleNarrowed = titleRewritten && normForMatch(ren.title!).includes(normForMatch(raw.title!));
  const lateTags = [
    js.title ? "<title>" : "",
    titleRewritten ? "<title> text" : "",
    js.h1 ? "<h1>" : "",
    js.canonical ? "canonical" : "",
    js.description ? "meta description" : "",
    js.jsonLd ? "JSON-LD structured data" : "",
  ].filter(Boolean);
  if (lateTags.length) {
    out.push({
      id: "render-tags-js-only",
      category: "rendering",
      severity: js.title || (titleRewritten && !titleNarrowed) || js.canonical || js.h1 ? "high" : "medium",
      confidence: "high",
      title: `Key tags only exist after JavaScript: ${lateTags.join(", ")}`,
      evidence: lateTags.map((t) =>
        t === "<title> text"
          ? `<title> in raw HTML is "${truncate(raw.title, 80)}"; JavaScript changes it to "${truncate(ren.title, 80)}"${titleNarrowed ? ", so crawlers that skip JavaScript get the shorter, less specific title" : ""}`
          : `${t}: missing in raw HTML, present in rendered DOM`,
      ),
      visibilityImpact: "Crawlers that do not run JavaScript see a page without these signals, so titles, canonicals and structured data are ignored by them.",
      fix: { summary: "Emit these tags in the server HTML <head>", steps: [ssrAdvice(raw.frameworkHints), "If you use a client-side head manager (react-helmet, vue-meta), switch to the framework's server metadata API."], effort: "hours" },
      sources: ["browser"],
    });
  }
}

function extractionChecks(b: StageBundle, out: Finding[]) {
  const f = b.fetch;
  if (!f?.page || !f.stats) return;
  const s = f.stats;
  const ren = b.browser?.rendered;
  const md = f.page.markdown;
  const extractedText = markdownToPlain(md);

  // Content lost by extraction. When Fetch only saw the pre-JavaScript page, measure it against the
  // server HTML: text that JavaScript adds later belongs to the rendering finding, and blaming the
  // extractor (with <main> advice) would send the fix to the wrong place.
  const preJs = fetchMissedJsContent(b);
  const base = preJs ? b.browser!.raw! : ren;
  if (base && base.words >= 300) {
    const mdNorm = ` ${normForMatch(extractedText)} `;
    const lostHeadings = base.headings
      .filter((h) => h.level <= 3)
      .map((h) => h.text)
      .filter((t) => {
        const n = normForMatch(t);
        return n.split(" ").length >= 2 && !mdNorm.includes(` ${n} `);
      });
    const ratio = s.words / base.words;
    if (ratio < 0.35 || lostHeadings.length >= 3) {
      out.push({
        id: "extract-content-lost",
        category: "extraction",
        severity: ratio < 0.2 || lostHeadings.length >= 5 ? "high" : "medium",
        confidence: "medium",
        title: `AI extraction keeps ${pct(s.words, base.words)} of the ${preJs ? "server HTML text" : "visible text"}`,
        evidence: [
          `Fetch extracted ${s.words} words; the ${preJs ? "raw server HTML has" : "rendered page has"} ${base.words} words (navigation and footer included).`,
          lostHeadings.length ? `Sections dropped by extraction: ${lostHeadings.slice(0, 6).map((h) => `"${h}"`).join(", ")}` : "",
          `Semantic containers: <main> ${base.hasMain ? "present" : "missing"}, <article> ${base.hasArticle ? "present" : "missing"}.`,
        ].filter(Boolean),
        visibilityImpact: "Extractors remove what looks like boilerplate. Sections they drop are not available to the AI tool that is answering a question about your page.",
        fix: {
          summary: "Make the main content easy to identify",
          steps: [
            !base.hasMain ? "Wrap the primary content in a single <main> element." : "Keep all primary content inside <main>.",
            !base.hasArticle && articleLike(b) ? "Wrap the article body in <article>." : "",
            "Move key text out of carousels, sliders, tab widgets and <aside> elements, or render it as normal <section> content with <h2> headings.",
          ].filter(Boolean),
          effort: "hours",
        },
        sources: ["fetch", "browser"],
      });
    }
  }

  // Thin extracted content
  const comps = b.search?.competitors.filter((c) => c.fetched && c.stats) || [];
  const compWords = comps.map((c) => c.stats!.words).sort((a, b2) => a - b2);
  const median = compWords.length ? compWords[Math.floor(compWords.length / 2)] : null;
  // The page already has the text but serves it only through JavaScript: the rendering finding owns
  // that (with the Fetch word count as evidence), and "add more text" would be the wrong fix.
  const textExistsAfterJs = preJs && !!ren && ren.words >= 300;
  if (s.words < 300 && !textExistsAfterJs) {
    // Pages that rank with even less text show that length is not what holds this page back.
    const notBehind = median !== null && s.words >= median;
    out.push({
      id: "extract-thin",
      category: "extraction",
      severity: s.words < 120 && !notBehind ? "high" : "medium",
      confidence: "high",
      title: `Only ${s.words} words are extractable`,
      evidence: [
        `Fetch extracted ${s.words} words.`,
        median !== null ? `Median for the top ${compWords.length} competing pages: ${median} words.` : "",
        notBehind ? "The competing pages are thin too, so length is not what separates them from this page. More specific text still gives AI tools more to quote." : "",
      ].filter(Boolean),
      visibilityImpact: "AI answers quote specific passages. With little extractable text there is little for an answer engine to cite, and less evidence of relevance for ranking.",
      fix: { summary: "Add substantive, specific text that answers the query", steps: ["Add sections that answer the questions a searcher has (see the agent's missing-information list below if present).", "Use concrete facts: numbers, prices, steps, specs, dates."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // Title and description as extracted
  if (!f.page.title) {
    out.push({
      id: "meta-title-missing",
      category: "metadata",
      severity: "high",
      confidence: "high",
      title: "No title extracted",
      evidence: ["Fetch returned title: null (no og:title or <title>)."],
      visibilityImpact: "The title is the main label search engines and AI tools show for a page.",
      fix: { summary: "Add a descriptive <title> and og:title", steps: ["Put the main topic first, brand last, under 60 characters."], code: `<title>${b.query ? b.query.replace(/</g, "") : "Main topic"} | ${rootDomain(b.url)}</title>`, effort: "minutes" },
      sources: ["fetch"],
    });
  }
  // Fetch's description is the meta description or, failing that, og:description. The browser's HTML
  // tells the two apart; it is null here when the browser got a challenge page instead.
  const metaTag = ren ? ren.metaDescription || b.browser?.raw?.metaDescription || null : undefined;
  const ogDesc = ren?.og.description || b.browser?.raw?.og.description || null;
  const serpSnippet = b.search?.target.serpSnippet ?? null;
  if (!f.page.description && !metaTag) {
    const draft = suggestDescription(md, ren?.h1[0] ?? null, agentSummary(b), serpSnippet);
    out.push({
      id: "meta-description-missing",
      category: "metadata",
      severity: "medium",
      confidence: "high",
      title: "No meta description extracted",
      evidence: [
        "Fetch returned description: null (no og:description or meta description).",
        metaTag === null ? "The page HTML (raw and rendered) has no meta description tag either." : "",
      ].filter(Boolean),
      visibilityImpact: "Without a description, search engines and AI tools write their own summary from whatever text they find first.",
      fix: { summary: "Add a meta description (drafted from your page)", steps: ["Edit the draft below so it states what the page offers in under 155 characters."], code: `<meta name="description" content="${draft}">\n<meta property="og:description" content="${draft}">`, effort: "minutes" },
      sources: metaTag === null ? ["fetch", "browser"] : ["fetch"],
    });
  } else if (metaTag === null && ogDesc) {
    // react.dev leaves the tag out of its docs pages on purpose ("Let Google figure out a good
    // description for each page"); its og:description is a generic site line.
    const draft = suggestDescription(md, ren?.h1[0] ?? null, agentSummary(b), serpSnippet);
    out.push({
      id: "meta-description-og-only",
      category: "metadata",
      severity: "low",
      confidence: "high",
      title: "No meta description tag, only og:description",
      evidence: [
        `No <meta name="description"> in the raw or rendered HTML.`,
        `og:description: "${truncate(ogDesc, 160)}"`,
        serpSnippet ? `Snippet search shows for this page: "${truncate(serpSnippet, 160)}"` : "",
      ].filter(Boolean),
      visibilityImpact:
        "Search engines write the snippet from page text when there is no meta description; Google's snippet documentation names the meta description tag, not og:description. Leaving it out can be deliberate, so each snippet matches the query.",
      fix: {
        summary: "Optional: add a meta description if the shown snippet is weak",
        steps: [
          serpSnippet ? "If the snippet shown above describes the page well, no change is needed." : "If search snippets for this page read well, no change is needed.",
          "Otherwise add a meta description that says what this page offers, under 155 characters (draft below).",
        ],
        code: `<meta name="description" content="${draft}">`,
        effort: "minutes",
      },
      sources: ["browser", "fetch"],
    });
  }
  const pageTitle = ren?.title || f.page.title;
  if (pageTitle && pageTitle.length > 65) {
    out.push({
      id: "meta-title-long",
      category: "metadata",
      severity: "low",
      confidence: "medium",
      title: `Title is ${pageTitle.length} characters and will likely be cut or rewritten`,
      evidence: [`"${truncate(pageTitle, 120)}"`],
      visibilityImpact: "Search engines often rewrite long titles, so you lose control of the label shown.",
      fix: { summary: "Shorten to about 55 to 60 characters, topic first", steps: ["Move the brand to the end and drop filler words."], effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }

  // H1 and structure
  if (ren) {
    if (ren.h1.length === 0) {
      out.push({
        id: "struct-no-h1",
        category: "extraction",
        severity: "medium",
        confidence: "high",
        title: "No <h1> on the page",
        evidence: ["Rendered DOM has 0 <h1> elements."],
        visibilityImpact: "The H1 is the strongest on-page statement of the topic for both extractors and ranking.",
        fix: { summary: "Add one <h1> that states the topic", steps: ["Use the main query words in it."], code: `<h1>${b.query ? pageCasing(b.query, [ren.title, f.page.title, ren.text, extractedText]) : "Main topic of the page"}</h1>`, effort: "minutes" },
        sources: ["browser"],
      });
    } else if (ren.h1.length > 1) {
      out.push({
        id: "struct-multiple-h1",
        category: "extraction",
        severity: "low",
        confidence: "high",
        title: `${ren.h1.length} <h1> elements`,
        evidence: ren.h1.slice(0, 4).map((h) => `"${truncate(h, 80)}"`),
        visibilityImpact: "Several H1s blur which topic the page is about.",
        fix: { summary: "Keep one H1 and turn the rest into H2", steps: ["Usually a logo or section title is marked up as H1 by the theme."], effort: "minutes" },
        sources: ["browser"],
      });
    }
  }
  if (s.words > 600 && s.headings.length < 3) {
    out.push({
      id: "struct-wall-of-text",
      category: "extraction",
      severity: "medium",
      confidence: "medium",
      title: s.headings.length === 0 ? `${s.words} extracted words and no headings` : `${s.words} extracted words but only ${s.headings.length} heading${s.headings.length === 1 ? "" : "s"}`,
      evidence: [`Extracted headings: ${s.headings.map((h) => `"${truncate(h.text, 50)}"`).join(", ") || "none"}`],
      visibilityImpact: "Retrieval systems split pages into passages, usually at headings. Clear H2/H3 sections make it easier to match one passage to one question.",
      fix: { summary: "Add descriptive H2 and H3 headings every 150 to 300 words", steps: ["Phrase some headings as the questions people search for."], effort: "hours" },
      sources: ["fetch"],
    });
  }

  // Query coverage and answer-first
  if (b.query) {
    const cov = queryCoverage(b.query, extractedText, s.firstWords, s.headings.map((h) => h.text));
    if (cov.terms.length && cov.missing.length) {
      // Words that are in the title or description are not "never mentioned": engines read those too.
      const labels = [f.page.title, f.page.description, ren?.title, ren?.metaDescription, ...(ren?.h1 ?? [])].filter(Boolean).join(" ");
      const inLabels = cov.missing.filter((t) => containsTerm(labels, t));
      const nowhere = cov.missing.filter((t) => !inLabels.includes(t));
      const pos = b.search?.target.position ?? null;
      const ranksTop3 = pos !== null && pos <= 3;
      const severity: Severity =
        ranksTop3 || nowhere.length === 0 ? "low" : nowhere.length >= Math.ceil(cov.terms.length / 2) ? "high" : "medium";
      out.push({
        id: "content-query-terms-missing",
        category: "content_gap",
        severity,
        confidence: "high",
        title: nowhere.length
          ? `Extracted text never mentions: ${shown(b.query, nowhere)}`
          : `Query words only in the title or description, not in the text: ${shown(b.query, inLabels)}`,
        evidence: [
          `Query${b.queryDerived ? " (derived from the page)" : ""}: "${b.query}"`,
          `In the extracted text: ${shown(b.query, cov.inText) || "none"}. Missing from the text: ${shown(b.query, cov.missing)}.`,
          inLabels.length ? `${shown(b.query, inLabels)} ${inLabels.length === 1 ? "is" : "are"} in the title or description.` : "",
          ranksTop3
            ? `Already ranks #${pos}, so search engines connect the page to the query through other signals (title, links). Using the words in the text still helps AI tools quote this page for it.`
            : "",
        ].filter(Boolean),
        visibilityImpact: "Retrieval for both search and AI answers starts with matching words and close variants. A page that never uses the query's words is rarely retrieved for it.",
        fix: { summary: "Use the searcher's words in the heading and first paragraph", steps: [`Work these words into the first paragraph naturally: ${shown(b.query, cov.missing)}.`], effort: "minutes" },
        sources: ["fetch"],
      });
    } else if (cov.terms.length && cov.inFirstWords.length < Math.ceil(cov.terms.length / 2)) {
      const draft = agentSummary(b);
      out.push({
        id: "content-answer-not-first",
        category: "extraction",
        severity: "medium",
        confidence: "medium",
        title: "The opening text does not address the query",
        evidence: [`First words AI tools read: "${truncate(s.firstWords, 220)}"`, `Query words in the first 150 words: ${shown(b.query, cov.inFirstWords) || "none"}`],
        visibilityImpact: "AI answers and featured snippets favor passages that answer directly. If the answer is buried, a competitor's direct answer gets quoted instead.",
        fix: {
          summary: "Add a 40 to 60 word direct answer right under the H1",
          steps: [`Answer "${b.query}" in plain words in the first paragraph.`, draft ? `Starting point (from the agent's answer): "${truncate(draft, 300)}"` : ""].filter(Boolean),
          effort: "minutes",
        },
        sources: ["fetch", ...(draft ? (["agent"] as const) : [])],
      });
    }
  }

  // Author and date for article-like pages
  if (articleLike(b) && (!f.page.author || !f.page.publishedDate)) {
    out.push({
      id: "meta-author-date",
      category: "metadata",
      severity: "medium",
      confidence: "medium",
      title: `Article without machine-readable ${[!f.page.author ? "author" : "", !f.page.publishedDate ? "date" : ""].filter(Boolean).join(" or ")}`,
      evidence: [`Fetch extracted author: ${f.page.author ?? "null"}, published_date: ${f.page.publishedDate ?? "null"}.`],
      visibilityImpact: "Freshness and authorship are hard for answer engines to judge without them. Undated content is easier to pass over for time-sensitive queries.",
      fix: { summary: "Add a visible byline and date, and mark them up", steps: ["Show the author name and the published or updated date near the title.", "Use <time datetime=\"YYYY-MM-DD\"> and add author, datePublished, dateModified to Article JSON-LD."], code: `<meta name="author" content="AUTHOR NAME">\n<time datetime="YYYY-MM-DD">Month D, YYYY</time>`, effort: "minutes" },
      sources: ["fetch"],
    });
  }

  if (ren && ren.imgCount >= 3 && ren.imgMissingAlt / ren.imgCount > 0.3) {
    out.push({
      id: "struct-img-alt",
      category: "extraction",
      severity: "low",
      confidence: "high",
      title: `${ren.imgMissingAlt} of ${ren.imgCount} images have no alt text`,
      evidence: [`Images without alt attribute: ${ren.imgMissingAlt}`],
      visibilityImpact: "Text tools cannot see images. Alt text is the only way information in images reaches them.",
      fix: { summary: "Describe informative images in alt text", steps: ["Use alt=\"\" for decorative images so they are skipped."], effort: "hours" },
      sources: ["browser"],
    });
  }

  const lang = ren?.htmlLang;
  if (!lang && !f.page.language) {
    out.push({
      id: "meta-lang",
      category: "metadata",
      severity: "low",
      confidence: "medium",
      title: "Page language not declared",
      evidence: ["<html> has no lang attribute and Fetch could not detect a language."],
      visibilityImpact: "Language signals help engines serve the page to the right audience.",
      fix: { summary: "Declare the language", steps: [], code: `<html lang="en">`, effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }
}

function structuredDataChecks(b: StageBundle, out: Finding[]) {
  const ren = b.browser?.rendered;
  if (!ren) return;
  if (ren.jsonLd.parseErrors > 0) {
    out.push({
      id: "schema-invalid",
      category: "structured_data",
      severity: "high",
      confidence: "high",
      title: `${ren.jsonLd.parseErrors} JSON-LD block(s) are invalid JSON`,
      evidence: [`Blocks found: ${ren.jsonLd.blocks}, failed to parse: ${ren.jsonLd.parseErrors}`],
      visibilityImpact: "Invalid JSON-LD is ignored completely, so any rich result eligibility is lost.",
      fix: { summary: "Fix the JSON syntax", steps: ["Validate with https://validator.schema.org and Google's Rich Results Test.", "Common causes: trailing commas, unescaped quotes in text, template variables left empty."], effort: "minutes" },
      sources: ["browser"],
    });
  }
  if (ren.jsonLd.blocks === 0) {
    const type = guessSchemaType(b);
    out.push({
      id: "schema-missing",
      category: "structured_data",
      severity: type === "WebPage" ? "low" : "medium", // WebPage markup earns no rich result
      confidence: "medium",
      title: `No structured data (suggested type: ${type})`,
      evidence: ["No application/ld+json blocks in raw or rendered HTML."],
      visibilityImpact:
        "Structured data states facts (type, author, dates, prices) explicitly instead of leaving them to be inferred. It enables rich results in Google; its direct effect on AI citations is not proven, so treat this as a supporting fix.",
      fix: { summary: `Add ${type} JSON-LD to the server HTML (pre-filled from this page)`, steps: ["Replace the CAPITALIZED placeholders.", "Validate at https://validator.schema.org."], code: jsonLdSuggestion(b), effort: "minutes" },
      sources: ["browser", "fetch"],
    });
  }
  if (!ren.og.title && !ren.og.description) {
    out.push({
      id: "meta-og-missing",
      category: "metadata",
      severity: "low",
      confidence: "high",
      title: "No Open Graph tags",
      evidence: ["og:title and og:description are both missing."],
      visibilityImpact: "Many fetch tools, including TinyFish Fetch, prefer og:title and og:description when summarizing a page. Chat apps also use them for link previews.",
      fix: { summary: "Add og:title, og:description, og:image", steps: [], code: `<meta property="og:title" content="${(ren.title || "").replace(/"/g, "'")}">\n<meta property="og:description" content="${(ren.metaDescription || "").replace(/"/g, "'")}">\n<meta property="og:image" content="https://.../image.jpg">`, effort: "minutes" },
      sources: ["browser"],
    });
  }
}

/** True when the page has a reading problem worth fixing before chasing rankings. */
function readabilityProblem(b: StageBundle): boolean {
  if (b.fetch?.pageError || b.browser?.challenge || b.browser?.rawChallenge) return true;
  const raw = b.browser?.raw?.words ?? null;
  const ren = b.browser?.rendered?.words ?? null;
  if (raw !== null && ren !== null && ren >= 80 && raw / ren < 0.7) return true;
  return (b.fetch?.stats?.words ?? 1000) < 120;
}

/** A domain that holds most of the top results (a brand's own site, a dominant publisher). */
function dominantDomain(s: SearchStageResult, pageUrl: string): { domain: string; count: number; of: number } | null {
  const top = s.results.slice(0, 5);
  const counts = new Map<string, number>();
  for (const r of top) {
    const d = rootDomain(r.url);
    if (d && d !== rootDomain(pageUrl)) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, c) => c[1] - a[1])[0];
  return best && best[1] >= 3 ? { domain: best[0], count: best[1], of: top.length } : null;
}

function visibilityChecks(b: StageBundle, out: Finding[]) {
  const s = b.search;
  if (!s || s.pagesChecked === 0) return;
  const dominant = s.target.position === null ? dominantDomain(s, b.url) : null;
  const depth = s.pagesChecked * 10;
  const topNames = s.results.slice(0, 3).map((r) => `#${r.position} ${bareHost(r.url) || r.siteName}`).join(", ");

  if (s.target.position === null) {
    const otherUrl = s.domain.urls[0];
    out.push({
      id: "vis-not-ranking",
      category: "visibility",
      severity: otherUrl ? "medium" : b.queryDerived ? "medium" : "high",
      confidence: "medium",
      title: otherUrl ? `A different URL from your site ranks for "${s.query}" (#${otherUrl.position})` : `Not in the top ${depth} for "${s.query}"`,
      evidence: [
        `TinyFish Search (${s.location}) top results: ${topNames || "none"}.`,
        otherUrl ? `Your ranking URL: ${displayUrl(otherUrl.url)}` : `No URL from ${rootDomain(b.url)} in the top ${depth}.`,
        b.queryDerived ? "Query was derived from the page title/H1. Re-run with the query you actually target for a sharper result." : "",
      ].filter(Boolean),
      visibilityImpact: otherUrl
        ? "Two pages on one site competing for the same query split signals. Search and AI tools pick one, and here it is not the audited page."
        : "AI search tools retrieve candidates from a search index before reading them. A page outside the top results is rarely read, so it is rarely cited.",
      fix: otherUrl
        ? {
            summary: "Decide which page should own this query",
            steps: [
              `If this page should rank, link to it from ${displayUrl(otherUrl.url)} using the query words ("${b.query}") as the link text, and make this page answer the query in its first paragraph.`,
              `If ${displayUrl(otherUrl.url)} is the better answer, point your other internal links for this topic there and target this page at a different query.`,
              "Merge the pages and redirect one to the other (301) only if they say the same thing.",
            ],
            effort: "hours",
          }
        : {
            summary: dominant ? `Target a query that ${dominant.domain} does not own, or link to this page from there` : "Close the gap with the pages that do rank",
            steps: [
              ...(dominant
                ? [
                    `${dominant.count} of the top ${dominant.of} results are on ${dominant.domain}. Search engines treat it as the main source for "${b.query}", so this page is unlikely to outrank it.`,
                    `Link to this page from ${dominant.domain} if you control it, or aim this page at a narrower query.`,
                  ]
                : []),
              ...(readabilityProblem(b) ? ["Fix the readability findings first (search engines cannot rank what they cannot read)."] : []),
              "Cover the missing topics listed under content gaps.",
              "Get internal links to this page from related pages using the query words as anchor text.",
            ],
            effort: "days",
          },
      sources: ["search"],
    });
  } else {
    const pos = s.target.position;
    out.push({
      id: "vis-rank",
      category: "visibility",
      severity: pos <= 3 ? "info" : pos <= 10 ? "low" : "medium",
      confidence: "medium",
      title: `Ranks #${pos} for "${s.query}"`,
      evidence: [`TinyFish Search (${s.location}). Above you: ${s.results.filter((r) => r.position < pos).slice(0, 3).map((r) => `#${r.position} ${bareHost(r.url)}`).join(", ") || "nobody"}.`],
      visibilityImpact: pos <= 3 ? "Top results are the ones AI search tools most often read and cite." : "AI search tools tend to read only the first few results. Moving up matters more than in classic search.",
      fix: { summary: pos <= 3 ? "Protect the position" : "Move into the top 3", steps:
          pos <= 3
            ? ["Keep the readability issues below at zero so AI tools can quote you."]
            : [
                `Open the pages above you and note what they answer that this page does not: ${s.results.filter((r) => r.position < pos).slice(0, 3).map((r) => r.url).join(", ")}`,
                "Check the content-gap and answerability findings for specific missing topics.",
              ], effort: pos <= 3 ? "minutes" : "days" },
      sources: ["search"],
    });

    // Only a real meta description tag is compared. With browser HTML available and no tag, Fetch's
    // description is og:description, which snippets do not come from (see meta-description-og-only).
    const desc = b.browser?.rendered
      ? b.browser.rendered.metaDescription || b.browser.raw?.metaDescription || null
      : b.fetch?.page?.description;
    if (desc && s.target.serpSnippet) {
      const dTok = new Set(contentTokens(desc).map(stem));
      const sTok = contentTokens(s.target.serpSnippet).map(stem);
      const overlap = sTok.length ? sTok.filter((t) => dTok.has(t)).length / sTok.length : 0;
      if (overlap < 0.4) {
        out.push({
          id: "vis-snippet-rewritten",
          category: "visibility",
          severity: "low",
          confidence: "medium",
          // Without the browser's HTML, Fetch's description may be og:description rather than the tag.
          title: `Search shows different text than your ${b.browser?.rendered ? "meta" : "page"} description`,
          evidence: [
            b.browser?.rendered ? `Your meta description: "${truncate(desc, 160)}"` : `Description Fetch found (meta description or og:description): "${truncate(desc, 160)}"`,
            `Snippet shown: "${truncate(s.target.serpSnippet, 160)}"`,
          ],
          visibilityImpact: "The engine judged other text more relevant to the query. That text is also what AI tools are likely to quote.",
          fix: { summary: "Align the description with the query", steps: [`Rewrite the description to answer "${s.query}" directly, reusing the strongest phrases from the shown snippet.`], effort: "minutes" },
          sources: ["search", "browser"],
        });
      }
    }
  }

  // If the page already appeared for the target query it is clearly indexed, whatever the title probe says.
  if (s.indexProbe.query && !s.indexProbe.found && s.target.position === null) {
    out.push({
      id: "vis-index-probe",
      category: "visibility",
      severity: "high",
      confidence: "medium",
      title: "Page not found when searching its own title on its own domain",
      evidence: [
        `Searched: "${truncate(s.indexProbe.query, 100)}" restricted to ${rootDomain(b.url)}.`,
        s.indexProbe.domainUrls.length ? `Returned instead: ${s.indexProbe.domainUrls.slice(0, 3).join(", ")}` : "No pages from the domain were returned.",
        "TinyFish Search uses its own index, not Google's. Confirm in Google Search Console (URL Inspection) before acting.",
      ],
      visibilityImpact: "A page that is not in the index cannot be retrieved for any query, by classic search or by AI search tools built on top of it.",
      fix: { summary: "Get the page discovered and indexed", steps: ["Link to it from your homepage or a hub page.", "Add it to the sitemap.", "Request indexing in Google Search Console and Bing Webmaster Tools (Bing also feeds several AI assistants)."], effort: "minutes" },
      sources: ["search"],
    });
  }
}

// Words that describe page furniture or are too general to be a topic.
const GAP_IGNORE = new Set(
  (
    "frequently asked question questions faq answer answers yes no start today day days month year more less great easy " +
    "type types create creating know knowing make making made guide guides across even helpful help take taking evolve " +
    "use using used need needs want good better best many much well first work works working find look thing things " +
    "people important different example examples information learn understand include includes including based provide " +
    "provides able often every without within while however also really simple simply right overview introduction basics " +
    "next previous related read article page pages site website click step steps way ways time times part " +
    "choose choosing select selecting started getting build building tool tools content engage"
  )
    .split(/\s+/)
    .map(stem),
);

/**
 * Topics most competing pages cover and the target page never mentions.
 * Phrases (two adjacent words) are checked as phrases, so "search console" counts as missing even if
 * "search" and "console" appear separately. Overlapping phrases are merged ("money back" + "back
 * guarantee" become "money back guarantee"). Single words only count when a competitor uses them in a
 * heading, which keeps generic vocabulary out.
 */
export function topicGaps(
  targetText: string,
  comps: { url: string; title: string; terms: Record<string, number>; headings?: string[] }[],
  limit = 10,
): [string, { n: number; total: number }][] {
  const target = phraseSet(targetText);
  // Brand names: the domain label, plus title segments that contain it ("Google Search Central", "Digital.gov").
  // A gap term is dropped only if the whole term is part of a brand name, so "google search" is dropped
  // but "search console" is kept even though "search" appears in "Google Search Central".
  const brands = comps.flatMap((c) => {
    const label = rootDomain(c.url).split(".")[0].toLowerCase();
    const segs = c.title.split(/\s[|\u2013\u2014:-]\s/).slice(1).map((sg) => sg.toLowerCase().replace(/[^a-z0-9]/g, ""));
    return [label, ...segs.filter((n) => n.length > 1 && (n.includes(label) || label.includes(n)))];
  });
  const isBrand = (term: string) => {
    const joined = term.replace(/\s+/g, "");
    return brands.some((b) => b.includes(joined));
  };
  const headingTerms = new Map<string, number>();
  for (const c of comps) for (const t of phraseSet((c.headings || []).join("\n"))) headingTerms.set(t, (headingTerms.get(t) || 0) + 1);

  const df = new Map<string, { n: number; total: number }>();
  for (const c of comps) {
    for (const [term, count] of Object.entries(c.terms)) {
      const cur = df.get(term) || { n: 0, total: 0 };
      cur.n++;
      cur.total += count;
      df.set(term, cur);
    }
  }
  const need = Math.max(2, Math.ceil(comps.length * 0.66));
  const clean = (term: string) => !isBrand(term) && !term.split(" ").some((w) => w.length < 3 || GAP_IGNORE.has(w));
  const byStrength = (a: [string, { n: number; total: number }], c: [string, { n: number; total: number }]) =>
    (headingTerms.get(c[0]) || 0) - (headingTerms.get(a[0]) || 0) || c[1].n - a[1].n || c[1].total - a[1].total;

  const bigrams = [...df.entries()]
    .filter(([term, v]) => term.includes(" ") && v.n >= need && v.total >= 3 && clean(term) && !target.has(term))
    .sort(byStrength);
  const phrases: [string, { n: number; total: number }][] = [];
  for (const [term, v] of bigrams) {
    const [a, b] = term.split(" ");
    const hit = phrases.find(([p]) => p.endsWith(` ${a}`) || p.startsWith(`${b} `));
    if (hit) {
      if (hit[0].endsWith(` ${a}`) && !hit[0].includes(` ${b}`)) hit[0] = `${hit[0]} ${b}`;
      else if (hit[0].startsWith(`${b} `) && !hit[0].includes(`${a} `)) hit[0] = `${a} ${hit[0]}`;
      continue;
    }
    phrases.push([term, { ...v }]);
  }
  const covered = new Set(phrases.flatMap(([p]) => p.split(" ")));
  // Single words are noisier than phrases ("stuck" and "human" in tinyfish.ai competitors' headings),
  // so one only counts when every compared page uses it in a heading.
  const singles = [...df.entries()]
    .filter(
      ([term, v]) =>
        !term.includes(" ") && v.n >= need && term.length >= 5 && clean(term) && !target.has(term) && !covered.has(term) && (headingTerms.get(term) || 0) >= comps.length,
    )
    .sort(byStrength);
  return [...phrases, ...singles].slice(0, limit);
}

function contentGapChecks(b: StageBundle, out: Finding[]) {
  const s = b.search;
  const f = b.fetch;
  if (!s || !f?.page || !f.stats) return;
  // Compare only with pages that outrank this one. A #1 page has nothing to learn from pages below it.
  const pos = s.target.position;
  const comps = s.competitors.filter((c) => c.fetched && c.stats && (pos === null || c.position < pos));
  if (comps.length < 2) return;
  const whom = pos === null ? "top-ranking pages" : "pages ranking above this one";

  const gaps = topicGaps(
    markdownToPlain(f.page.markdown) + "\n" + f.stats.headings.map((h) => h.text).join("\n"),
    comps.map((c) => ({ url: c.url, title: c.title, terms: c.terms, headings: c.stats?.headings.map((h) => h.text) })),
  );
  const ranksTop3 = s.target.position !== null && s.target.position <= 3;

  if (gaps.length >= 3) {
    out.push({
      id: "gap-terms",
      category: "content_gap",
      severity: ranksTop3 ? "low" : "medium",
      confidence: "medium",
      title: `${gaps.length} topics the ${whom} cover and this page does not`,
      evidence: [
        `Compared with: ${comps.map((c) => `#${c.position} ${bareHost(c.url)}`).join(", ")}`,
        `Missing from your extracted text: ${gaps.map(([t, v]) => `${t} (${v.n}/${comps.length})`).join(", ")}`,
      ],
      visibilityImpact: "These are the words and sub-topics that searchers' queries and AI answers draw on. Pages that cover them match more question variants.",
      fix: { summary: "Add sections that cover the strongest gaps", steps: ["Group related terms into one or two new H2 sections.", "Only add what is true and useful for your offer; do not keyword-stuff."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }

  const words = comps.map((c) => c.stats!.words).sort((a, b2) => a - b2);
  const median = words[Math.floor(words.length / 2)];
  if (median >= 2 * Math.max(f.stats.words, 1) && median > 400) {
    out.push({
      id: "gap-depth",
      category: "content_gap",
      severity: "medium",
      confidence: "medium",
      title: `The ${whom} give AI tools ${Math.round(median / Math.max(f.stats.words, 1))}x more text`,
      evidence: comps.map((c) => `#${c.position} ${bareHost(c.url)}: ${c.stats!.words} words, ${c.stats!.headings.length} headings, ${c.stats!.listItems} list items, ${c.stats!.tableRows} table rows`).concat([`You: ${f.stats.words} words, ${f.stats.headings.length} headings`]),
      visibilityImpact: "Length is not a ranking factor by itself, but depth usually means more answered sub-questions and more quotable passages.",
      fix: { summary: "Add depth where it answers real questions", steps: ["Use the agent's missing-information list and the topic gaps as the outline for new sections."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }

  const compStructured = comps.filter((c) => c.stats!.tableRows >= 3 || c.stats!.listItems >= 8).length;
  if (compStructured >= 2 && f.stats.tableRows < 3 && f.stats.listItems < 4) {
    out.push({
      id: "gap-structure",
      category: "content_gap",
      severity: "low",
      confidence: "medium",
      title: `The ${whom} use lists and tables; this page is mostly prose`,
      evidence: comps.map((c) => `#${c.position} ${bareHost(c.url)}: ${c.stats!.listItems} list items, ${c.stats!.tableRows} table rows`).concat([`You: ${f.stats.listItems} list items, ${f.stats.tableRows} table rows`]),
      visibilityImpact: "Lists and tables extract cleanly and are easy to quote as steps, comparisons and specs.",
      fix: { summary: "Turn steps, specs and comparisons into real HTML lists and tables", steps: ["Use <ol>/<ul> and <table>, not styled <div>s."], effort: "hours" },
      sources: ["search", "fetch"],
    });
  }
}

const BLOCKER_PHRASE: Record<string, string> = {
  cookie_wall: "a cookie wall",
  modal: "a pop-up",
  login_wall: "a login wall",
  paywall: "a paywall",
  captcha: "a CAPTCHA",
  age_gate: "an age gate",
  region_block: "a region block",
  broken_page: "a broken page",
  other: "an obstacle",
  block_page: "a block page",
};

// Text that describes a bot block, whatever label the agent picked. Reddit's "You've been blocked by
// network security" page came back labelled as a login wall, which led to login-wall advice.
const BLOCK_PAGE_TEXT =
  /blocked by network security|you['\u2019]ve been blocked|you have been blocked|access denied|security verification|verif(?:y|ying) (?:that )?you are (?:a )?human|prove your humanity|bot (?:check|protection|challenge)|challenge page/i;

/** The blocker type to report and fix: the agent's label, unless its description reads as a bot block. */
export function blockerType(x: { type: string; description: string }): string {
  return x.type !== "captcha" && BLOCK_PAGE_TEXT.test(x.description) ? "block_page" : x.type;
}

export function blockerPhrase(x: { type: string; description: string }): string {
  const t = blockerType(x);
  if (t === "block_page" || (t === "other" && /block|denied|forbidden|security|challenge/i.test(x.description))) return "a block page";
  return BLOCKER_PHRASE[t] || "an obstacle";
}

/** One evidence line per blocker, saying so when the agent's label was overridden. */
function blockerEvidence(x: { type: string; description: string }): string {
  const label = x.type.replace(/_/g, " ");
  // "other" is no label at all, so there is nothing to override.
  if (blockerType(x) === x.type || x.type === "other") return `${label}: ${x.description}`;
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  return `${label}: ${x.description} (the agent called this ${article} ${label}, but it describes a bot block, so the fix is for the block)`;
}

function blockerFix(x: { type: string; description: string }): string {
  return BLOCKER_FIX[blockerType(x)] || BLOCKER_FIX.other;
}

// Blocker descriptions that mean the agent never reached the content at all.
const ACCESS_BLOCK = /block|denied|forbidden|captcha|challenge|security|verify|human|robot|access/i;

export function agentWasBlocked(a: AgentAnswer): boolean {
  return a.blockers.some(
    (x) => ["captcha", "login_wall", "paywall", "region_block", "broken_page", "block_page"].includes(blockerType(x)) || (x.type === "other" && ACCESS_BLOCK.test(x.description)),
  );
}

// Steps that mean the agent left the audited page (rule 1 of its goal says not to, but agents can).
const LEFT_PAGE = /navigat(?:e|ed|ing) to|went to (?:the|a|another)|opened (?:the|a|another) [\w' -]*page|go(?:ne)? to the [\w' -]*page|another page|different page|followed (?:the|a) link/i;

/** True when the agent's answer came from another page than the one audited. */
export function answeredOnOtherPage(a: AgentAnswer): boolean {
  return a.answer_location === "other_page" || LEFT_PAGE.test(a.interactions_needed.join(" "));
}

/** Where the agent's quote can be found. "unverified" means it is not on the page as written (a paraphrase). */
export function locateQuote(b: StageBundle): { inFetch: boolean | null; inRaw: boolean | null; inRendered: boolean | null; verified: boolean } {
  const a = b.agent?.answer;
  const quote = a?.evidence_quote;
  if (!quote) return { inFetch: null, inRaw: null, inRendered: null, verified: false };
  const challenged = !!b.browser?.challenge;
  const extracted = b.fetch?.page ? markdownToPlain(b.fetch.page.markdown) : null;
  const rawText = challenged ? null : (b.browser?.raw?.text ?? null);
  const renderedText = challenged ? null : (b.browser?.rendered?.text ?? null);
  const inFetch = extracted !== null ? quoteAppearsIn(quote, extracted) : null;
  const inRaw = rawText !== null ? quoteAppearsIn(quote, rawText) : null;
  const inRendered = renderedText !== null ? quoteAppearsIn(quote, renderedText) : null;
  return { inFetch, inRaw, inRendered, verified: !!(inFetch || inRaw || inRendered) };
}

const BLOCKER_FIX: Record<string, string> = {
  captcha:
    "Do not challenge readers on content pages. In Cloudflare, allow Verified Bots and signed AI agents, or lower the security level for these paths. Other bot managers have equivalent allow lists.",
  other:
    "Check why automated browsers are blocked (bot manager, WAF rule, rate limit). Allow verified AI agents and search crawlers on public content pages.",
  login_wall: "Keep a public, crawlable summary of the gated content above the login wall.",
  paywall: "Keep a public summary above the paywall, and mark paywalled sections with isAccessibleForFree: false in JSON-LD.",
  region_block: "Serve the public content to all regions, or provide a public version that is not geo-blocked.",
  broken_page: "Fix the error the agent hit, then re-run the audit.",
  cookie_wall: "Use a cookie banner that sits at the bottom of the screen and does not block reading or replace content in the HTML.",
  modal: "Delay newsletter or promo pop-ups, or remove them on content pages.",
  age_gate: "Show the age gate only where legally required, and keep a short public summary visible behind it.",
  block_page:
    "Check why automated browsers are blocked (bot manager, WAF rule, rate limit). Allow verified AI agents and search crawlers on public content pages.",
};

function answerabilityChecks(b: StageBundle, out: Finding[]) {
  const a = b.agent?.answer;
  if (!a) return;
  const blocked = agentWasBlocked(a);
  const { inFetch, inRaw, inRendered, verified } = locateQuote(b);

  if (!a.answer_found && blocked) {
    // The agent never saw the content: "add this information" advice would be wrong.
    const blockers = a.blockers.filter((x) => x.type !== "cookie_wall" && x.type !== "modal");
    out.push({
      id: "answer-blocked",
      category: "answerability",
      severity: "high",
      confidence: "medium",
      title: `An AI browsing agent was blocked before it could read the page (${[...new Set(blockers.map(blockerPhrase))].join(", ")})`,
      evidence: blockers.map(blockerEvidence),
      visibilityImpact:
        "Browsing agents (ChatGPT agent, Claude in Chrome and similar) read pages on a user's behalf. If they are blocked, they answer from other sources and cite those instead.",
      fix: { summary: "Let AI agents reach public content", steps: [...new Set(blockers.map(blockerFix))], effort: "hours" },
      sources: ["agent"],
    });
  } else if (!a.answer_found) {
    out.push({
      id: "answer-not-found",
      category: "answerability",
      severity: b.queryDerived ? "medium" : "high",
      confidence: "medium",
      title: `An AI agent could not answer "${b.query}" from this page`,
      evidence: [
        `Agent's view of the page: ${a.page_purpose || "n/a"}`,
        a.missing_information.length ? `What it says is missing: ${a.missing_information.join("; ")}` : "",
      ].filter(Boolean),
      visibilityImpact: "Answer engines cite pages that answer the question. If an agent reading the live page cannot find the answer, it will cite a page that has one.",
      fix: { summary: "Add the missing answer", steps: a.missing_information.length ? a.missing_information.map((m) => `Add: ${m}`) : [`Add a section that directly answers "${b.query}".`], effort: "hours" },
      sources: ["agent"],
    });
  } else if (answeredOnOtherPage(a) && !verified) {
    // The agent opened another page and answered from there. This page does not hold the answer, so
    // "hidden behind a click" advice would point at the wrong page.
    out.push({
      id: "answer-other-page",
      category: "answerability",
      severity: b.queryDerived ? "low" : "medium",
      confidence: "medium",
      title: `The answer to "${truncate(b.query, 60)}" is on another page, not this one`,
      evidence: [
        `Agent's steps: ${a.interactions_needed.join(" > ") || "opened a linked page"}`,
        a.evidence_quote ? `Agent's evidence (from the other page): "${truncate(a.evidence_quote, 200)}"` : "",
        "The quote is not in this page's Fetch extraction, raw HTML or rendered page.",
      ].filter(Boolean),
      visibilityImpact:
        "Search and AI answer tools retrieve and quote one page at a time. For this query they need the page that holds the answer, so this page is unlikely to be the one cited.",
      fix: {
        summary: "Answer the query here, or point the query at the page that does",
        steps: [
          `Add a short, direct answer to "${b.query}" near the top of this page, in the server HTML.`,
          "Or treat the linked page as the target for this query: audit it, and link to it from here using the query words.",
        ],
        effort: "hours",
      },
      sources: ["agent", "fetch", "browser"],
    });
  } else if (a.evidence_quote && !verified && a.answer_location === "after_interaction") {
    // Content revealed by a click is expected to be missing from the page as loaded. Report it, but
    // with low confidence: the agent may also have paraphrased.
    out.push({
      id: "answer-hidden",
      category: "answerability",
      severity: "medium",
      confidence: "low",
      title: "The answer appears only after a click, and crawlers never receive it",
      evidence: [
        `Agent's evidence: "${truncate(a.evidence_quote, 240)}"`,
        `Where the agent found it: after interaction${a.interactions_needed.length ? `; steps the agent took: ${a.interactions_needed.join(" > ")}` : ""}`,
        "The text is not in the TinyFish Fetch extraction, the raw server HTML or the page as first loaded. That is expected for content loaded on click; if the agent paraphrased, this can be a false alarm.",
      ],
      visibilityImpact: "Only a browsing agent that clicks can reach this answer. Search crawlers and fetch tools quote what is in the HTML they receive.",
      fix: {
        summary: "Show the answer by default in the server HTML",
        steps: [
          "Render tab or accordion content in the HTML (collapsed with CSS or <details>), not loaded on click.",
          "Check by opening the page source (view-source:) and searching for a sentence of the answer.",
        ],
        code: `<details open>\n  <summary>${truncate(b.query, 80)}</summary>\n  <p>${truncate(a.evidence_quote, 200)}</p>\n</details>`,
        effort: "hours",
      },
      sources: ["agent", "fetch", "browser"],
    });
  } else if (a.evidence_quote && verified) {
    // Only a quote that is really on the page can say who receives it. Paraphrases are skipped.
    // An agent that wandered off and came back with text that is also on this page did not need a click.
    const hidden = a.answer_location === "after_interaction" && !answeredOnOtherPage(a);
    if (inFetch === false || inRaw === false || hidden) {
      let severity: Severity = "low";
      let title = "";
      if (inFetch === false && inRaw === false) {
        severity = "high";
        title = "The answer is on the page, but neither AI fetch tools nor non-JS crawlers receive it";
      } else if (inRaw === false) {
        severity = "medium";
        title = "The answer is only in the page after JavaScript runs";
      } else if (inFetch === false) {
        severity = "medium";
        title = "The answer is in the HTML, but AI extraction drops it";

      } else {
        // In the raw HTML and in Fetch's text: AI tools already receive it. Only people need the click.
        severity = "info";
        title = "The answer is readable by crawlers but hidden from people behind a click";
      }
      const crawlersHaveIt = inFetch !== false && inRaw !== false;
      // A few words (a tagline, a heading) are weak evidence of where "the answer" lives, and
      // extractors often drop taglines on purpose.
      const quoteWords = a.evidence_quote.split(/\s+/).filter(Boolean).length;
      const shortQuote = quoteWords < 8;
      if (shortQuote && (severity === "high" || severity === "medium")) severity = severity === "high" ? "medium" : "low";
      out.push({
        id: "answer-hidden",
        category: "answerability",
        severity,
        confidence: shortQuote ? "low" : "medium",
        title,
        evidence: [
          `Agent's evidence (found on the page as written): "${truncate(a.evidence_quote, 240)}"`,
          shortQuote ? `The quote is only ${quoteWords} words, so it may be a tagline or heading rather than the answer itself.` : "",
          `Where the agent found it: ${a.answer_location.replace(/_/g, " ")}${a.interactions_needed.length ? `; steps the agent took: ${a.interactions_needed.join(" > ")}` : ""}`,
          `In TinyFish Fetch extraction: ${inFetch === null ? "not checked" : inFetch ? "yes" : "no"}. In raw server HTML: ${inRaw === null ? "not checked" : inRaw ? "yes" : "no"}. In rendered page: ${inRendered === null ? "not checked" : inRendered ? "yes" : "no"}.`,
        ].filter(Boolean),
        visibilityImpact: hidden && crawlersHaveIt
          ? "No effect on AI visibility: crawlers and fetch tools already receive this text in the HTML. Only people have to click to see it."
          : hidden
          ? "Only a browsing agent that clicks can reach this answer. Search crawlers and fetch tools quote what is in the HTML they receive."
          : inRaw === false
            ? "People see this answer, but crawlers that skip JavaScript work from the raw HTML, which does not contain it. They cannot quote it."
            : "Crawlers receive this text in the HTML, but the extraction AI fetch tools apply removes it, usually because it sits in navigation, a banner or a block that looks like boilerplate. Tools that quote from extracted text cannot use it.",
        fix: crawlersHaveIt && hidden
          ? {
              summary: "Optional: show it to people without a click",
              steps: ["Crawlers and fetch tools already receive this text, so nothing is needed for AI visibility.", "If visitors should see it right away, show that card or tab expanded by default."],
              effort: "minutes",
            }
          : {
          summary: hidden ? "Show the answer by default in the server HTML" : "Put the answer in the HTML that crawlers receive",
          steps: [
            hidden ? "Render tab or accordion content in the HTML (collapsed with CSS or <details>), not loaded on click." : "",
            inRaw === false ? ssrAdvice(b.browser?.raw?.frameworkHints || []) : "",
            inFetch === false ? "Put the answer in a normal <p> inside <main>, near the top, not in a widget, image or carousel." : "",
          ].filter(Boolean),
          code: hidden ? `<details open>\n  <summary>${truncate(b.query, 80)}</summary>\n  <p>${truncate(a.evidence_quote, 200)}</p>\n</details>` : undefined,
          effort: inRaw === false ? "days" : "hours",
        },
        sources: ["agent", ...(inFetch !== null ? (["fetch"] as const) : []), ...(inRaw !== null ? (["browser"] as const) : [])],
      });
    }
  }

  // Overlays and walls the agent got past (when it was not fully blocked; that case is reported above).
  if (!(blocked && !a.answer_found)) {
    const serious = a.blockers.filter(
      (x) => ["login_wall", "paywall", "captcha", "region_block", "broken_page", "block_page"].includes(blockerType(x)) || (x.type === "other" && ACCESS_BLOCK.test(x.description)),
    );
    const covering = a.blockers.filter((x) => !serious.includes(x));
    if (serious.length || covering.length) {
      const all = [...serious, ...covering];
      // A banner or pop-up the agent dismissed and then answered anyway is friction, not a blocker.
      const answeredAnyway = a.answer_found;
      out.push({
        id: "answer-blockers",
        category: "answerability",
        severity: serious.length ? "high" : answeredAnyway ? "low" : "medium",
        confidence: "medium",
        title: `The agent had to get past ${[...new Set(all.map(blockerPhrase))].join(", ")}`,
        evidence: [
          ...all.map(blockerEvidence),
          !serious.length && answeredAnyway ? "The agent got past it and still answered." : "",
        ].filter(Boolean),
        visibilityImpact: "Browsing agents (ChatGPT agent, Claude in Chrome and similar) have to get past these to read the page. Each one is a chance to give up and use another source.",
        fix: {
          summary: serious.length ? "Let readers reach the content without a challenge or wall" : "Do not cover content with overlays",
          steps: [...new Set(all.map(blockerFix))],
          effort: "hours",
        },
        sources: ["agent"],
      });
    }
  }
}

function stageNotes(b: StageBundle, out: Finding[]) {
  const missing: string[] = [];
  if (fetchCallFailed(b)) missing.push(`Fetch stage failed: ${oneLineError(b.fetch!.error!)}`);
  if (b.browser && !b.browser.ok) missing.push(`Browser stage failed: ${oneLineError(b.browser.error || "unknown error")}`);
  if (b.agent && !b.agent.ok) missing.push(`Agent stage did not complete: ${oneLineError(b.agent.error || b.agent.status)}`);
  if (b.search && b.search.pagesChecked === 0) missing.push("Search stage returned no results.");
  if (!b.browser) missing.push("Browser stage skipped.");
  if (!b.agent) missing.push("Agent stage skipped.");
  if (missing.length) {
    const text = missing.join(" ");
    const steps: string[] = [];
    if (/timeout|timed out|did not finish/i.test(text))
      steps.push("A stage ran out of time: the page or the remote browser was slow. Re-run; slow pages often load on a second try. If it keeps happening, AI browsing agents are likely to give up on this page too.");
    if (/credit|402|404|not enabled/i.test(text)) steps.push("Check your TinyFish credits and that the Browser and Agent APIs are enabled on your account.");
    if (/\(429\)|rate limit/i.test(text)) steps.push("Wait a minute, then re-run: TinyFish limits how many calls run per minute.");
    if (/\(401\)|API key/i.test(text)) steps.push("Check TINYFISH_API_KEY in .env.local.");
    if (/skipped/.test(text)) steps.push("Tick the Browser and Agent boxes to run every check (they use TinyFish credits).");
    if (!steps.length) steps.push("Re-run the audit; if the same stage fails again, the error above says why.");
    out.push({
      id: "audit-coverage",
      category: "access",
      severity: "info",
      confidence: "high",
      title: "Some checks did not run",
      evidence: missing,
      visibilityImpact: "Findings that depend on these stages are missing from this report, so scores are based on fewer signals.",
      fix: { summary: "Re-run with all stages", steps, effort: "minutes" },
      sources: [],
    });
  }
}

/** True when the Fetch API call failed, so the Fetch result holds nothing about the page or robots.txt. */
export function fetchCallFailed(b: StageBundle): boolean {
  return !!b.fetch?.error && !b.fetch.page && !b.fetch.pageError;
}

/** Stages that gave the report no data about the page (failed, skipped, out of credits), in run order. */
export function missingStages(b: StageBundle): Source[] {
  const out: Source[] = [];
  if (!b.fetch || fetchCallFailed(b)) out.push("fetch");
  // A browser that met a bot challenge did run: the challenge is the finding.
  if (!b.browser || (!b.browser.raw && !b.browser.challenge)) out.push("browser");
  if (!b.search || b.search.pagesChecked === 0) out.push("search");
  if (!b.agent?.answer) out.push("agent");
  return out;
}

/**
 * Stage data that describes the page. The browser's HTML is dropped when it is a bot challenge, and a
 * Fetch result is dropped when the API call itself failed (its empty robots list would otherwise read
 * as "every crawler allowed").
 */
export function usableStages(b: StageBundle): StageBundle {
  let out = b;
  if (out.browser?.challenge) out = { ...out, browser: null };
  if (fetchCallFailed(out)) out = { ...out, fetch: null };
  return out;
}

function challengeChecks(b: StageBundle, out: Finding[]) {
  const ch = b.browser?.challenge;
  if (ch) {
    const fetchGotIt = !!b.fetch?.page && (b.fetch.stats?.words ?? 0) > 100;
    out.push({
      id: "access-browser-challenged",
      category: "access",
      severity: "high",
      confidence: "high",
      title: `A real browser got a bot challenge instead of the page${ch.title ? ` ("${truncate(ch.title, 60)}")` : ""}`,
      evidence: [
        `TinyFish Browser received a challenge page: HTTP ${b.browser?.status ?? "n/a"}, ${ch.words} words${ch.title ? `, title "${ch.title}"` : ""}.`,
        fetchGotIt ? `TinyFish Fetch did receive the content (${b.fetch!.stats!.words} words), so the block depends on how the request looks.` : "",
        "Checks that need the page HTML (rendering, tags, structured data, crawler user-agent probes) were skipped, because the HTML was the challenge page.",
        "Caveat: requests came from a TinyFish residential IP. Verified crawlers from published IP ranges may be let through.",
      ].filter(Boolean),
      visibilityImpact:
        "AI browsing agents load pages like a browser. If they get this challenge, they cannot read or cite the page and answer from other sources.",
      fix: {
        summary: "Do not challenge readers on public content pages",
        steps: [BLOCKER_FIX.captcha, "Re-run this audit; the browser should receive the real page."],
        effort: "hours",
      },
      sources: ["browser"],
    });
  }
  const rc = b.browser?.rawChallenge;
  if (rc && !ch) {
    out.push({
      id: "access-raw-challenge",
      category: "access",
      severity: "high",
      confidence: "high",
      title: "The first HTML response is a bot challenge; the content only appears after a JavaScript check",
      evidence: [
        `First HTML response: HTTP ${b.browser?.status ?? "n/a"}, ${rc.words} words${rc.title ? `, title "${truncate(rc.title, 60)}"` : ""} (${rc.reason}).`,
        `After JavaScript ran, the browser reached the page: ${b.browser?.rendered?.words ?? 0} words.`,
        "Crawlers that do not run JavaScript (GPTBot, ClaudeBot, PerplexityBot) stop at the first response.",
        "Caveat: requests came from a TinyFish residential IP. Verified crawlers from published IP ranges may be let through.",
      ],
      visibilityImpact: "An AI crawler that gets the challenge has nothing to index, so the page cannot be retrieved or cited by that engine.",
      fix: {
        summary: "Exempt verified crawlers from the JavaScript challenge",
        steps: [
          "In Cloudflare, allow Verified Bots and signed AI agents, or skip the JS challenge on public content paths. Other bot managers have equivalent allow lists.",
          "Re-run this audit; raw and rendered word counts should then be close.",
        ],
        effort: "hours",
      },
      sources: ["browser"],
    });
  }
  if (b.fetch?.robots.status === "unreadable") {
    out.push({
      id: "access-robots-unreadable",
      category: "access",
      severity: "low",
      confidence: "medium",
      title: "robots.txt could not be read, so crawler rules are unknown",
      evidence: [
        b.fetch.robots.note,
        `URL: ${b.fetch.robots.url}`,
        b.fetch.robots.excerpt ? `What came back starts with: "${truncate(b.fetch.robots.excerpt, 200)}"` : "",
      ].filter(Boolean),
      visibilityImpact:
        "If real crawlers get the same response, some treat an unreadable robots.txt as a reason to slow down or stop crawling. Real crawlers may receive the actual file.",
      fix: { summary: "Serve robots.txt to every client without a challenge", steps: ["Exclude /robots.txt and /sitemap.xml from bot challenges and WAF rules.", "Re-run this audit; the crawler rules table should fill in."], effort: "minutes" },
      sources: ["fetch"],
    });
  }
}

export function buildFindings(input: StageBundle): Finding[] {
  const out: Finding[] = [];
  const b = usableStages(input);
  challengeChecks(input, out);
  accessChecks(b, out);
  renderingChecks(b, out);
  extractionChecks(b, out);
  structuredDataChecks(b, out);
  visibilityChecks(b, out);
  contentGapChecks(b, out);
  answerabilityChecks(input, out);
  stageNotes(input, out);
  // De-duplicate by id (first wins) and sort.
  const seen = new Set<string>();
  return sortFindings(out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))));
}

export function buildStrengths(input: StageBundle): string[] {
  const s: string[] = [];
  const b = usableStages(input);
  const br = b.browser;
  const f = b.fetch;
  if (f && f.robots.status !== "unreadable" && f.robots.verdicts.filter((v) => v.bot.purpose === "ai_search").every((v) => v.allowed)) s.push("robots.txt allows every AI search crawler checked (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Applebot).");
  if (br?.raw && br.rendered && br.rendered.words > 0 && br.raw.words / br.rendered.words >= 0.9) s.push(`Content is in the server HTML (${br.raw.words} of ${br.rendered.words} words), so non-JavaScript AI crawlers can read it.`);
  const searchProbes = br?.botProbes.filter((p) => AI_BOTS.find((x) => x.token === p.bot)?.purpose !== "training") ?? [];
  if (searchProbes.length && searchProbes.every((p) => p.verdict === "ok"))
    s.push(`Requests with AI search crawler user-agents (${searchProbes.map((p) => p.bot).join(", ")}) got the same page as a normal browser.`);
  if (f?.stats && f.stats.words >= 600 && f.stats.headings.length >= 3) s.push(`Extraction is substantial and structured: ${f.stats.words} words under ${f.stats.headings.length} headings.`);
  if (br?.rendered && br.rendered.jsonLd.blocks > 0 && br.rendered.jsonLd.parseErrors === 0) s.push(`Valid structured data: ${br.rendered.jsonLd.types.join(", ") || "JSON-LD present"}.`);
  if (b.search?.target.position && b.search.target.position <= 3) s.push(`Ranks #${b.search.target.position} for "${b.search.query}".`);
  if (b.agent?.answer?.answer_found && b.agent.answer.answer_location === "visible_on_load" && !answeredOnOtherPage(b.agent.answer)) s.push("An AI agent answered the query from content visible on load.");
  return s;
}
