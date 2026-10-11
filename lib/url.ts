// URL helpers: validation and normalization so a page can be matched against search results.

const TRACKING = /^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$|ref$|ref_src$|_hs)/i;

export function parseInputUrl(input: string): URL {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https URLs are supported");
  const h = u.hostname;
  if (
    h === "localhost" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h.endsWith(".local") ||
    !h.includes(".")
  ) {
    throw new Error("Private or local hosts cannot be audited. Use a public URL.");
  }
  return u;
}

export function bareHost(u: string | URL): string {
  try {
    const h = (typeof u === "string" ? new URL(u) : u).hostname.toLowerCase();
    return h.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Registrable-ish domain: last two labels, or three for common 2-level TLDs like co.uk. */
export function rootDomain(u: string | URL): string {
  const h = bareHost(u);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const twoLevel = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    const params = [...x.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const qs = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    let path = x.pathname.replace(/\/+$/, "");
    path = path.replace(/\/(index\.html?|default\.aspx?)$/i, "");
    return `${bareHost(x)}${path || ""}${qs}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a) === normalizeUrl(b);
}

export function sameSite(a: string, b: string): boolean {
  return rootDomain(a) !== "" && rootDomain(a) === rootDomain(b);
}

/** File-name-safe slug for a URL, e.g. "example-com-blog-post". */
/**
 * The URL to report for a page that Fetch or a browser ended on. When only the query string changed
 * (Reddit's "?solution=...&js_challenge=1&jsc_token=..." challenge redirect, tracking parameters),
 * the requested URL is the page; the extra parameters must not end up in robots.txt rules or canonicals.
 */
export function pageUrlAfterRedirect(requested: string, final: string | null | undefined): string {
  if (!final) return requested;
  try {
    const a = new URL(requested);
    const b = new URL(final);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return a.origin === b.origin && path(a) === path(b) ? requested : final;
  } catch {
    return final;
  }
}

/** A URL short enough to read in a report: a long query string (share and tracking parameters) becomes "?…". */
export function displayUrl(u: string, maxQuery = 40): string {
  try {
    const x = new URL(u);
    const q = x.search.length > maxQuery ? "?\u2026" : x.search;
    return `${x.origin}${x.pathname}${q}`;
  } catch {
    return u;
  }
}

/** Error text on one line, without terminal color codes or Playwright's multi-line call log. */
/**
 * Drops the part of an API error that is addressed to the caller rather than describing the error
 * (TinyFish's 402 body asks the caller to show a payment link and not to rephrase it).
 */
export function withoutCallerInstructions(msg: string): string {
  return msg.replace(/\s*(?:Show the user|Pay \$|Do not retry|Then retry)[\s\S]*$/i, "");
}

export function oneLineError(msg: string, max = 200): string {
  const first = msg.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)[0].trim();
  return first.length > max ? first.slice(0, max - 1) + "\u2026" : first;
}

/** "2026-10-09-103012" (UTC) from an ISO time, so saved files sort by run time and old runs are easy to spot. */
export function stampForFile(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** File name (no extension) for a saved report, the same in the UI, the CLI and the batch demo. */
export function reportFileBase(url: string, generatedAt: string): string {
  return `ai-audit-${slugForUrl(url)}-${stampForFile(generatedAt)}`;
}

export function slugForUrl(url: string): string {
  try {
    const u = new URL(/^https?:/i.test(url) ? url : `https://${url}`);
    return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 70) || "page";
  } catch {
    return "page";
  }
}

export function originOf(u: string): string {
  const x = new URL(u);
  return `${x.protocol}//${x.host}`;
}
