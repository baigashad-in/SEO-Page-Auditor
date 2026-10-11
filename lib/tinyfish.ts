// Thin REST client for the four TinyFish APIs used by the auditor.
// Docs: https://docs.tinyfish.ai (Search, Fetch, Browser, Agent references).
// The API key is read from TINYFISH_API_KEY on the server only. It never reaches the browser.

import type { Source } from "./types";
import { oneLineError, withoutCallerInstructions } from "./url";

/**
 * A short, plain message for a failed TinyFish call, safe to show in a report. The API's own error
 * text can be long and is written for whoever calls the API (the 402 body asks the caller to show a
 * payment link and not to rephrase it), so reports never show it as is.
 */
export function tinyfishErrorText(err: unknown, what: string): string {
  const status = err instanceof TinyFishError ? err.status : (err as { status?: number } | null)?.status;
  if (err instanceof TinyFishError && err.code === "MISSING_API_KEY") return err.message;
  if (status === 401) return `TinyFish did not accept the API key for ${what} (401). Check TINYFISH_API_KEY in .env.local.`;
  if (status === 402) return `Not enough TinyFish credits for ${what} (402).`;
  if (status === 429) return `TinyFish rate limit reached for ${what} (429). Wait a minute and re-run.`;
  const msg = err instanceof Error ? err.message : String(err);
  return oneLineError(withoutCallerInstructions(msg), 200);
}

const DEFAULT_HOSTS = {
  search: "https://api.search.tinyfish.ai",
  fetch: "https://api.fetch.tinyfish.ai",
  browser: "https://api.browser.tinyfish.ai",
  agent: "https://agent.tinyfish.ai",
};

function host(kind: keyof typeof DEFAULT_HOSTS): string {
  const env = {
    search: process.env.TINYFISH_SEARCH_URL,
    fetch: process.env.TINYFISH_FETCH_URL,
    browser: process.env.TINYFISH_BROWSER_URL,
    agent: process.env.TINYFISH_AGENT_URL,
  }[kind];
  return (env && env.trim()) || DEFAULT_HOSTS[kind];
}

export class TinyFishError extends Error {
  constructor(
    public endpoint: Source,
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TinyFishError";
  }
}

function apiKey(endpoint: Source): string {
  const k = process.env.TINYFISH_API_KEY;
  if (!k) {
    throw new TinyFishError(endpoint, 401, "MISSING_API_KEY", "TINYFISH_API_KEY is not set on the server. Add it to .env.local.");
  }
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(
  endpoint: Source,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries = 2,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          "X-API-Key": apiKey(endpoint),
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: ctrl.signal,
        cache: "no-store",
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof TinyFishError) throw err;
      const aborted = (err as Error).name === "AbortError";
      if (attempt < retries && !aborted) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new TinyFishError(endpoint, 0, aborted ? "CLIENT_TIMEOUT" : "NETWORK_ERROR", `${endpoint}: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 300) };
    }

    if (res.ok) return body as T;

    // Retry on rate limits and temporary unavailability, honoring Retry-After.
    // Limits are per minute (free tiers can be as low as 5 searches/min), so back off in seconds, not milliseconds.
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      const fallback = res.status === 429 ? 12_000 * (attempt + 1) : 2_000 * (attempt + 1);
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : fallback);
      continue;
    }
    const errObj = (body as { error?: unknown })?.error;
    const code =
      typeof errObj === "object" && errObj && "code" in errObj
        ? String((errObj as { code: unknown }).code)
        : typeof errObj === "string"
          ? errObj
          : `HTTP_${res.status}`;
    const message =
      typeof errObj === "object" && errObj && "message" in errObj
        ? String((errObj as { message: unknown }).message)
        : text.slice(0, 300);
    throw new TinyFishError(endpoint, res.status, code, `${endpoint} ${res.status} ${code}: ${message}`);
  }
}

/* Search API: GET https://api.search.tinyfish.ai */

export interface RawSearchResult {
  position: number;
  site_name: string;
  title: string;
  snippet: string;
  url: string;
  date?: string;
}

export interface RawSearchResponse {
  query: string;
  results: RawSearchResult[];
  total_results: number;
  page: number;
}

export async function tfSearch(p: {
  query: string;
  location?: string;
  language?: string;
  page?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  purpose?: string;
}): Promise<RawSearchResponse> {
  const qs = new URLSearchParams({ query: p.query });
  if (p.location) qs.set("location", p.location);
  if (p.language) qs.set("language", p.language);
  if (p.page) qs.set("page", String(p.page));
  if (p.includeDomains?.length) qs.set("include_domains", p.includeDomains.join(","));
  if (p.excludeDomains?.length) qs.set("exclude_domains", p.excludeDomains.join(","));
  if (p.purpose) qs.set("purpose", p.purpose.slice(0, 2000));
  const res = await call<RawSearchResponse>("search", `${host("search")}?${qs}`, { method: "GET" }, 30_000);
  return { ...res, results: Array.isArray(res?.results) ? res.results : [] };
}

/* Fetch API: POST https://api.fetch.tinyfish.ai */

export interface RawFetchResult {
  url: string;
  final_url: string;
  title: string | null;
  description: string | null;
  language: string | null;
  author: string | null;
  published_date: string | null;
  text: string | null;
  links?: string[];
  image_links?: string[];
  latency_ms: number | null;
  format: string;
}

export interface RawFetchError {
  url: string;
  error: string;
  status?: number;
}

export interface RawFetchResponse {
  results: RawFetchResult[];
  errors: RawFetchError[];
}

export async function tfFetch(body: {
  urls: string[];
  format?: "markdown" | "html" | "json";
  links?: boolean;
  image_links?: boolean;
  ttl?: number;
  per_url_timeout_ms?: number;
  purpose?: string;
}): Promise<RawFetchResponse> {
  if (body.urls.length > 10) throw new Error("Fetch accepts at most 10 URLs per request");
  const res = await call<RawFetchResponse>(
    "fetch",
    host("fetch"),
    { method: "POST", body: JSON.stringify(body) },
    150_000, // docs: 110s per URL backend timeout, 120s CDN ceiling
  );
  return { results: res?.results ?? [], errors: res?.errors ?? [] };
}

/* Browser API: POST https://api.browser.tinyfish.ai */

export interface BrowserSession {
  session_id: string;
  cdp_url: string;
  base_url: string;
}

export async function tfCreateBrowserSession(body: { url?: string; timeout_seconds?: number }): Promise<BrowserSession> {
  return call<BrowserSession>("browser", host("browser"), { method: "POST", body: JSON.stringify(body) }, 60_000, 1);
}

export async function tfDeleteBrowserSession(sessionId: string): Promise<void> {
  try {
    await call<void>("browser", `${host("browser")}/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, 20_000, 1);
  } catch {
    // Session also ends on its inactivity timeout, so a failed delete is not fatal.
  }
}

/* Agent API: https://agent.tinyfish.ai/v1/automation/run-async and /v1/runs/{id} */

export interface RawRun {
  run_id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  // GET /v1/runs/{id} documents `result` (the SDK's run schema agrees). Older SSE
  // COMPLETE events used `resultJson`, so both are accepted.
  result: unknown;
  resultJson?: unknown;
  error: { code?: string; message?: string; help_message?: string; help_url?: string } | null;
  num_of_steps: number | null;
  streaming_url?: string | null;
}

export async function tfStartAgentRun(body: {
  url: string;
  goal: string;
  output_schema?: object;
  browser_profile?: "lite" | "stealth";
}): Promise<{ run_id: string | null; error: { code: string; message: string } | null }> {
  return call("agent", `${host("agent")}/v1/automation/run-async`, { method: "POST", body: JSON.stringify(body) }, 30_000, 1);
}

export async function tfGetAgentRun(runId: string): Promise<RawRun> {
  return call<RawRun>(
    "agent",
    `${host("agent")}/v1/runs/${encodeURIComponent(runId)}?screenshots=none&html=none`,
    { method: "GET" },
    30_000,
  );
}

export async function tfCancelAgentRun(runId: string): Promise<void> {
  try {
    await call("agent", `${host("agent")}/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" }, 20_000, 0);
  } catch {
    // best effort
  }
}

/** Times a TinyFish call and returns a log entry with it. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}
