// Stage 3: TinyFish Search (+ Fetch for competitors). How does the page show up, and who wins instead?
//   1. Target query: where does this URL rank (top 20)? Which URL of the same site ranks, if not this one?
//   2. Index probe: search the page's own title inside its own domain. Not found = likely not indexed.
//   3. Competitors: Fetch the top 3 other-domain results so the report can compare what AI tools extract.

import type { CallLog, CompetitorPage, SearchStageResult, SerpItem } from "../types";
import { tfFetch, tfSearch, tinyfishErrorText, type RawSearchResult } from "../tinyfish";
import { markdownStats, markdownToPlain } from "../parse/markdown";
import { termCounts } from "../analyze/text";
import { deriveQuery } from "../analyze/query";
import { parseInputUrl, rootDomain, sameSite, sameUrl } from "../url";

export interface SearchStageInput {
  url: string;
  query?: string;
  queryDerived?: boolean;
  location?: string;
  pageTitle?: string | null;
  h1?: string | null;
  finalUrl?: string | null;
  canonical?: string | null;
}

// Results that are not comparable pages (video and social posts).
const NON_PAGE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|pinterest\.com|linkedin\.com)$/i;

/**
 * Search results sometimes arrive as Google redirect links ("/url?q=https://site/page&sa=U...").
 * Unwrap them so the real URL can be matched, fetched and shown.
 */
export function cleanResultUrl(raw: string): string {
  const u = (raw || "").trim();
  try {
    const parsed = new URL(u, "https://www.google.com");
    if (parsed.pathname === "/url" && /(^|\.)google\./.test(parsed.hostname)) {
      const target = parsed.searchParams.get("q") || parsed.searchParams.get("url");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
    return /^https?:\/\//i.test(u) ? u : parsed.toString();
  } catch {
    return u;
  }
}

function toItem(r: RawSearchResult, offset: number): SerpItem {
  const url = cleanResultUrl(r.url);
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep empty */
  }
  return {
    position: (r.position ?? 0) + offset,
    title: r.title ?? "",
    url,
    snippet: r.snippet ?? "",
    siteName: r.site_name || host,
    date: r.date,
  };
}

export async function runSearchStage(input: SearchStageInput): Promise<SearchStageResult> {
  const pageUrl = parseInputUrl(input.url).toString();
  const domain = rootDomain(pageUrl);
  const location = (input.location || "US").toUpperCase();
  const calls: CallLog[] = [];
  const candidates = [pageUrl, input.finalUrl, input.canonical].filter((x): x is string => !!x);
  const isTarget = (u: string) => candidates.some((c) => sameUrl(c, u));

  const derived = input.queryDerived ?? !input.query?.trim();
  const query = input.query?.trim() || deriveQuery({ h1: input.h1, title: input.pageTitle }) || domain;

  const out: SearchStageResult = {
    query,
    queryDerived: derived,
    location,
    results: [],
    pagesChecked: 0,
    target: { position: null, matchedUrl: null, serpTitle: null, serpSnippet: null },
    domain: { bestPosition: null, urls: [] },
    indexProbe: { query: "", found: false, position: null, domainUrls: [] },
    competitors: [],
    calls,
  };

  // 1. Target query, page 0 then page 1 if the audited URL itself is not in the top 10 (another URL from
  // the same site on page 1 does not stop the search: the audited page may still be on page 2).
  for (let page = 0; page < 2; page++) {
    const t = Date.now();
    try {
      const res = await tfSearch({
        query,
        location,
        page,
        purpose: "SEO audit: check where a specific page ranks for this query and which pages outrank it.",
      });
      out.pagesChecked++;
      const items = res.results.map((r) => toItem(r, page === 0 ? 0 : out.results.length));
      out.results.push(...items);
      calls.push({ endpoint: "search", purpose: `Rank check for "${query}" (page ${page + 1})`, ms: Date.now() - t, ok: true, detail: `${items.length} results` });
    } catch (err) {
      calls.push({ endpoint: "search", purpose: `Rank check for "${query}" (page ${page + 1})`, ms: Date.now() - t, ok: false, detail: tinyfishErrorText(err, "Search") });
      break;
    }
    if (out.results.some((r) => isTarget(r.url))) break;
  }

  // Renumber positions to be sequential across pages in case the API restarts at 1.
  out.results = out.results.map((r, i) => ({ ...r, position: i + 1 }));
  const hit = out.results.find((r) => isTarget(r.url));
  if (hit) out.target = { position: hit.position, matchedUrl: hit.url, serpTitle: hit.title, serpSnippet: hit.snippet };
  out.domain.urls = out.results.filter((r) => sameSite(r.url, pageUrl)).map((r) => ({ position: r.position, url: r.url }));
  out.domain.bestPosition = out.domain.urls[0]?.position ?? null;

  // 2. Index probe: the page's own title, restricted to its own domain.
  if (input.pageTitle && input.pageTitle.trim().length > 3) {
    const probeQuery = input.pageTitle.trim().slice(0, 150);
    out.indexProbe.query = probeQuery;
    const t = Date.now();
    try {
      const res = await tfSearch({
        query: probeQuery,
        location,
        includeDomains: [domain],
        purpose: "SEO audit: check whether this exact page is present in the search index.",
      });
      const items = res.results.map((r) => toItem(r, 0));
      const found = items.find((r) => isTarget(r.url));
      out.indexProbe.found = !!found;
      out.indexProbe.position = found?.position ?? null;
      out.indexProbe.domainUrls = items.slice(0, 5).map((r) => r.url);
      calls.push({
        endpoint: "search",
        purpose: "Index probe: page title searched within its own domain",
        ms: Date.now() - t,
        ok: true,
        detail: found ? `found at #${found.position}` : "page not returned",
      });
    } catch (err) {
      calls.push({ endpoint: "search", purpose: "Index probe", ms: Date.now() - t, ok: false, detail: tinyfishErrorText(err, "Search") });
    }
  }

  // 3. Competitors: top 3 results from other domains, fetched with TinyFish Fetch.
  const comp = out.results
    .filter((r) => !sameSite(r.url, pageUrl))
    .filter((r) => {
      try {
        return !NON_PAGE.test(new URL(r.url).hostname);
      } catch {
        return false;
      }
    })
    .slice(0, 3);
  if (comp.length) {
    const t = Date.now();
    try {
      const res = await tfFetch({
        urls: comp.map((c) => c.url),
        format: "markdown",
        ttl: 3600,
        per_url_timeout_ms: 60_000,
        purpose: "SEO audit: extract competing pages that outrank the audited page, to compare content coverage.",
      });
      calls.push({
        endpoint: "fetch",
        purpose: `Extract top ${comp.length} competing pages for "${query}"`,
        ms: Date.now() - t,
        ok: true,
        detail: `${res.results.length} ok, ${res.errors.length} failed`,
      });
      out.competitors = comp.map((c): CompetitorPage => {
        const r = res.results.find((x) => x.url === c.url || sameUrl(x.url, c.url));
        if (!r || typeof r.text !== "string") {
          const e = res.errors.find((x) => x.url === c.url || sameUrl(x.url, c.url));
          return { url: c.url, position: c.position, title: c.title, fetched: false, error: e?.error || "not returned", terms: {} };
        }
        const stats = markdownStats(r.text);
        const plain = markdownToPlain(r.text);
        return {
          url: c.url,
          position: c.position,
          title: r.title || c.title,
          fetched: true,
          stats,
          description: r.description,
          terms: termCounts(`${plain} ${stats.headings.map((h) => h.text).join(" ")}`),
        };
      });
    } catch (err) {
      calls.push({ endpoint: "fetch", purpose: "Extract competing pages", ms: Date.now() - t, ok: false, detail: tinyfishErrorText(err, "Fetch") });
      out.competitors = comp.map((c) => ({ url: c.url, position: c.position, title: c.title, fetched: false, error: "fetch failed", terms: {} }));
    }
  }

  return out;
}
