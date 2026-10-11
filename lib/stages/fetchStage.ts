// Stage 1: TinyFish Fetch. What does an AI fetch tool actually extract from the page?
// One batch call gets the page plus robots.txt, llms.txt and sitemap.xml from the same origin.

import type { AuditInput, CallLog, FetchStageResult, FetchedPage, FetchFailure } from "../types";
import { tfFetch, tinyfishErrorText, type RawFetchResult } from "../tinyfish";
import { markdownStats } from "../parse/markdown";
import { looksLikeRobots, robotsVerdicts } from "../parse/robots";
import { looksLikeChallengeText } from "../parse/html";
import { normalizeUrl, originOf, pageUrlAfterRedirect, parseInputUrl, sameSite } from "../url";

function unescapeMd(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!$>|])/g, "$1");
}

function pick(results: RawFetchResult[], url: string): RawFetchResult | undefined {
  return results.find((r) => r.url === url) || results.find((r) => normalizeUrl(r.url) === normalizeUrl(url));
}

function toPage(r: RawFetchResult): FetchedPage {
  return {
    url: r.url,
    finalUrl: pageUrlAfterRedirect(r.url, r.final_url),
    title: r.title,
    description: r.description,
    language: r.language,
    author: r.author,
    publishedDate: r.published_date,
    markdown: typeof r.text === "string" ? r.text : "",
    links: r.links || [],
    imageLinks: r.image_links || [],
    latencyMs: r.latency_ms,
  };
}

/** A sitemap lists URLs. Anything without URLs (or with challenge markers) is not one. */
export function looksLikeSitemap(text: string, links: string[]): boolean {
  if (looksLikeChallengeText(text)) return false;
  if (/<urlset|<sitemapindex|<loc>/i.test(text)) return true;
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  return urls.length >= 3 || links.some((l) => /\.xml(\.gz)?$/i.test(l));
}

function urlInSitemap(text: string, links: string[], pageUrl: string, finalUrl: string): boolean {
  const targets = new Set([normalizeUrl(pageUrl), normalizeUrl(finalUrl)]);
  const found: string[] = [...(text.match(/https?:\/\/[^\s<>"')\]]+/g) || []), ...links];
  return found.some((u) => targets.has(normalizeUrl(u.replace(/&amp;/g, "&"))));
}

function sitemapChildren(text: string, links: string[]): string[] {
  const inText: string[] = text.match(/https?:\/\/[^\s<>"')\]]+\.xml(\.gz)?/g) || [];
  return [...new Set([...inText, ...links.filter((l) => /\.xml(\.gz)?$/.test(l))])];
}

export async function runFetchStage(input: AuditInput): Promise<FetchStageResult> {
  const pageUrl = parseInputUrl(input.url).toString();
  const origin = originOf(pageUrl);
  const robotsUrl = `${origin}/robots.txt`;
  const llmsUrl = `${origin}/llms.txt`;
  const sitemapGuess = `${origin}/sitemap.xml`;
  const calls: CallLog[] = [];

  const result: FetchStageResult = {
    input,
    page: null,
    pageError: null,
    stats: null,
    robots: { found: false, url: robotsUrl, note: "", verdicts: [], sitemaps: [] },
    llmsTxt: { found: false, url: llmsUrl, chars: 0 },
    sitemap: { checkedUrl: null, containsUrl: null, note: "" },
    links: { internal: 0, external: 0 },
    calls,
  };

  const t0 = Date.now();
  let batch;
  try {
    batch = await tfFetch({
      urls: [pageUrl, robotsUrl, llmsUrl, sitemapGuess],
      format: "markdown",
      links: true,
      image_links: true,
      ttl: 0, // live fetch: audit the page as it is now, not a cached copy
      per_url_timeout_ms: 90_000,
      purpose: "SEO audit: measure what an AI fetch tool can extract from this live page, and read the site's crawler rules.",
    });
    calls.push({
      endpoint: "fetch",
      purpose: "Live extraction of the page + robots.txt + llms.txt + sitemap.xml (one batch)",
      ms: Date.now() - t0,
      ok: true,
      detail: `${batch.results.length} ok, ${batch.errors.length} failed`,
    });
  } catch (err) {
    // The call itself failed (credits, rate limit, server error). That says nothing about the site,
    // so it is recorded as a stage error, not as "AI fetch tools cannot read this page".
    result.error = tinyfishErrorText(err, "Fetch");
    calls.push({ endpoint: "fetch", purpose: "Live extraction of the page", ms: Date.now() - t0, ok: false, detail: result.error });
    result.robots.note = "Not checked: the Fetch call failed.";
    return result;
  }

  const errFor = (u: string): FetchFailure | undefined =>
    batch.errors.find((e) => e.url === u || normalizeUrl(e.url) === normalizeUrl(u));

  // The page itself
  const pageRaw = pick(batch.results, pageUrl);
  if (pageRaw) {
    result.page = toPage(pageRaw);
    result.stats = markdownStats(result.page.markdown);
    for (const l of result.page.links) {
      try {
        if (sameSite(l, pageUrl)) result.links.internal++;
        else if (/^https?:/.test(l)) result.links.external++;
      } catch {
        /* ignore malformed */
      }
    }
  } else {
    result.pageError = errFor(pageUrl) || { url: pageUrl, error: "missing_from_response" };
  }

  // robots.txt
  const robotsRaw = pick(batch.results, robotsUrl);
  const robotsErr = errFor(robotsUrl);
  const robotsText = robotsRaw?.text ? unescapeMd(String(robotsRaw.text)) : null;
  const finalForRules = result.page?.finalUrl || pageUrl;
  // An HTML page or bot challenge in place of robots.txt means the rules are unknown, not allow-all:
  // real crawlers may well receive the actual file.
  // A title or HTML tags only count against the file when it does not parse as rules.
  const robotsParses = !!robotsText && looksLikeRobots(robotsText);
  const robotsIsHtml =
    !!robotsText &&
    (looksLikeChallengeText(robotsText, robotsRaw?.title ?? null) ||
      (!robotsParses && (robotsRaw?.title != null || /<html|<body|<div/i.test(robotsText))));
  if (robotsText && robotsParses && !robotsIsHtml) {
    const v = robotsVerdicts(robotsText, finalForRules);
    result.robots = {
      found: true,
      url: robotsUrl,
      note: v.reflowed
        ? "Parsed with RFC 9309 matching. The copy Fetch returned had lost its line breaks, so the rules were reconstructed; treat them as less certain."
        : "Parsed with RFC 9309 matching.",
      verdicts: v.verdicts,
      sitemaps: v.sitemaps,
      status: "parsed",
      source: "fetch",
      reflowed: v.reflowed,
    };
  } else {
    const v = robotsVerdicts(null, finalForRules);
    let status: "absent" | "unreadable" = "unreadable";
    let note: string;
    if (robotsErr?.error === "page_not_found") {
      status = "absent";
      note = "No robots.txt (404). All crawlers are allowed by default.";
    } else if (robotsErr) {
      note = `TinyFish Fetch could not read robots.txt (${robotsErr.error}). Crawler rules unknown.`;
    } else if (robotsIsHtml) {
      note = "robots.txt came back as an HTML page (likely a bot challenge), not as rules. Crawler rules unknown.";
    } else if (!robotsText || !robotsText.trim()) {
      status = "absent";
      note = "robots.txt is empty. All crawlers are allowed.";
    } else {
      note = "robots.txt has no valid directives. Crawler rules unknown.";
    }
    const excerpt = status === "unreadable" && robotsText ? robotsText.replace(/\s+/g, " ").trim().slice(0, 240) : undefined;
    result.robots = { found: false, url: robotsUrl, note, verdicts: v.verdicts, sitemaps: [], status, source: "fetch", excerpt };
  }

  // llms.txt (informational only, see findings for why)
  const llmsRaw = pick(batch.results, llmsUrl);
  if (llmsRaw?.text && String(llmsRaw.text).trim().length > 20) {
    const text = String(llmsRaw.text);
    const htmlLike = llmsRaw.title != null && !text.trim().startsWith("#");
    result.llmsTxt = { found: !htmlLike, url: llmsUrl, chars: htmlLike ? 0 : text.length };
  }

  // sitemap: robots.txt Sitemap lines win over the /sitemap.xml guess
  const declared = result.robots.sitemaps;
  const guessRaw = pick(batch.results, sitemapGuess);
  let smUrl: string | null = null;
  let smText = "";
  let smLinks: string[] = [];
  let smError: string | null = null;
  if (guessRaw?.text && (!declared.length || declared.some((d) => normalizeUrl(d) === normalizeUrl(sitemapGuess)))) {
    smUrl = sitemapGuess;
    smText = String(guessRaw.text);
    smLinks = guessRaw.links || [];
  } else if (declared.length) {
    smUrl = declared[0];
    const t1 = Date.now();
    try {
      const r = await tfFetch({ urls: [smUrl], format: "markdown", links: true, ttl: 3600 });
      const sm = r.results[0];
      smText = sm?.text ? String(sm.text) : "";
      smLinks = sm?.links || [];
      if (!smText) smError = r.errors[0]?.error || "empty response";
      calls.push({
        endpoint: "fetch",
        purpose: "Sitemap declared in robots.txt",
        ms: Date.now() - t1,
        ok: !smError,
        detail: smError ? `could not read: ${smError}` : undefined,
      });
    } catch (err) {
      smError = tinyfishErrorText(err, "Fetch");
      calls.push({ endpoint: "fetch", purpose: "Sitemap declared in robots.txt", ms: Date.now() - t1, ok: false, detail: smError });
    }
  } else if (guessRaw?.text) {
    smUrl = sitemapGuess;
    smText = String(guessRaw.text);
    smLinks = guessRaw.links || [];
  }

  // A challenge page or HTML in place of the sitemap must not be read as "page not listed".
  if (smUrl && smText && !looksLikeSitemap(smText, smLinks)) {
    smError = looksLikeChallengeText(smText) ? "bot challenge page" : "not a sitemap";
    smText = "";
  }

  if (smUrl && smText) {
    const finalUrl = result.page?.finalUrl || pageUrl;
    if (urlInSitemap(smText, smLinks, pageUrl, finalUrl)) {
      result.sitemap = { checkedUrl: smUrl, containsUrl: true, note: "Page URL found in sitemap." };
    } else {
      const children = sitemapChildren(smText, smLinks).filter((c) => normalizeUrl(c) !== normalizeUrl(smUrl!));
      if (children.length) {
        // Sitemap index: check up to 3 child sitemaps, preferring ones that share a word with the page path.
        const pathWords = new URL(finalUrl).pathname.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        const ranked = children
          .map((c) => ({ c, score: pathWords.filter((w) => c.toLowerCase().includes(w.replace(/s$/, ""))).length }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((x) => x.c);
        const t2 = Date.now();
        try {
          const r = await tfFetch({ urls: ranked, format: "markdown", links: true, ttl: 3600 });
          calls.push({ endpoint: "fetch", purpose: `Child sitemaps from sitemap index (${ranked.length})`, ms: Date.now() - t2, ok: true });
          const hit = r.results.find((x) => urlInSitemap(String(x.text || ""), x.links || [], pageUrl, finalUrl));
          result.sitemap = hit
            ? { checkedUrl: hit.url, containsUrl: true, note: `Found in child sitemap ${hit.url}.` }
            : {
                checkedUrl: smUrl,
                containsUrl: null,
                note: `Sitemap index with ${children.length} child sitemaps. Checked ${ranked.length}, URL not found in those. Not conclusive.`,
              };
        } catch (err) {
          calls.push({ endpoint: "fetch", purpose: "Child sitemaps", ms: Date.now() - t2, ok: false, detail: tinyfishErrorText(err, "Fetch") });
          result.sitemap = { checkedUrl: smUrl, containsUrl: null, note: "Sitemap index found, child sitemaps could not be read." };
        }
      } else {
        result.sitemap = { checkedUrl: smUrl, containsUrl: false, note: "Sitemap read, page URL not listed." };
      }
    }
  } else if (smUrl) {
    // A sitemap exists (declared in robots.txt) but could not be read: say so instead of claiming there is none.
    result.sitemap = { checkedUrl: smUrl, containsUrl: null, note: `Sitemap declared in robots.txt (${smUrl}) but Fetch could not read it (${smError || "no content"}). Not checked.` };
  } else {
    const guessErr = errFor(sitemapGuess);
    if (guessErr && guessErr.error !== "page_not_found") {
      result.sitemap = { checkedUrl: sitemapGuess, containsUrl: null, note: `Could not read /sitemap.xml (${guessErr.error}). Not checked.` };
    } else if (result.robots.status === "unreadable") {
      result.sitemap = { checkedUrl: null, containsUrl: null, note: "No /sitemap.xml, and robots.txt could not be read to look for a declared sitemap." };
    } else {
      result.sitemap = { checkedUrl: null, containsUrl: null, note: "No sitemap found at /sitemap.xml or in robots.txt." };
    }
  }

  return result;
}
