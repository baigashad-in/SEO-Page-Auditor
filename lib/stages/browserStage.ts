// Stage 2: TinyFish Browser. What does the server send BEFORE JavaScript runs, and what exists AFTER?
// GPTBot, ClaudeBot and PerplexityBot do not execute JavaScript (Vercel, Dec 2024), so content that
// only exists after rendering is invisible to them. Fetch cannot answer this because it returns
// cleaned, already-rendered content, so this stage drives a real remote Chromium over CDP.

import { chromium, type Browser, type CDPSession, type Page, type Route } from "playwright-core";
import type { AuditInput, BotProbe, BrowserStageResult, CallLog, HtmlFacts } from "../types";
import { tfCreateBrowserSession, tfDeleteBrowserSession, tinyfishErrorText, TinyFishError } from "../tinyfish";
import { challengeReason, CHALLENGE_MAX_WORDS, htmlFacts } from "../parse/html";
import { normForMatch, wordCount } from "../analyze/text";
import { oneLineError, pageUrlAfterRedirect, parseInputUrl } from "../url";

// Representative user-agent strings from each operator's public docs. Real crawlers also come from
// verified IP ranges, so a block here is strong evidence and a pass is weak evidence.
// Search crawlers decide visibility in AI answers; ClaudeBot (training only) is kept as a reference,
// because sites often block training crawlers on purpose. CDNs match on the product token, so the
// Claude-SearchBot string is representative (Anthropic documents the token, not a full string).
export const PROBE_BOTS = [
  { bot: "OAI-SearchBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot" },
  { bot: "Claude-SearchBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)" },
  { bot: "PerplexityBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
  { bot: "ClaudeBot", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
];

function onlyAfterJs(raw: HtmlFacts, rendered: HtmlFacts) {
  const rawText = ` ${normForMatch(raw.text)} `;
  const rawHeads = new Set(raw.headings.map((h) => normForMatch(h.text)));
  const headings = rendered.headings
    .map((h) => h.text)
    .filter((t) => {
      const n = normForMatch(t);
      return n.length > 2 && !rawHeads.has(n) && !rawText.includes(` ${n} `);
    })
    .slice(0, 15);
  return {
    headings,
    title: !raw.title && !!rendered.title,
    description: !raw.metaDescription && !!rendered.metaDescription,
    canonical: !raw.canonical && !!rendered.canonical,
    h1: raw.h1.length === 0 && rendered.h1.length > 0,
    jsonLd: raw.jsonLd.blocks === 0 && rendered.jsonLd.blocks > 0,
  };
}

/**
 * Requests the page again with an AI crawler's user-agent, on the same tab that already loaded it.
 * TinyFish closes a session's browser context when its last tab closes, so probes never open or close
 * tabs or contexts: they reuse the open page and only load the HTML document (subresources are blocked).
 */
export async function probe(
  page: Page,
  url: string,
  bot: { bot: string; ua: string },
  baselineWords: number,
  baselineStatus: number | null,
): Promise<BotProbe> {
  const handler = (r: Route) =>
    r.request().resourceType() === "document"
      ? r.continue({ headers: { ...r.request().headers(), "user-agent": bot.ua } })
      : r.abort();
  let routed = false;
  let cdp: CDPSession | null = null;
  try {
    try {
      await page.route("**/*", handler);
      routed = true;
    } catch {
      // Request interception unavailable: set the user-agent at the network layer instead.
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.setUserAgentOverride", { userAgent: bot.ua });
    }
    // Only the HTML document matters here, so stop waiting once the response arrives.
    const resp = await page.goto(url, { waitUntil: "commit", timeout: 20_000 });
    const status = resp?.status() ?? null;
    const body = resp ? await resp.text().catch(() => "") : "";
    const facts = htmlFacts(body);
    const words = facts.words;
    const challenge = challengeReason(facts, body, status) !== null;
    let verdict: BotProbe["verdict"] = "ok";
    const baselineOk = baselineStatus !== null && baselineStatus < 400;
    if (baselineOk && (challenge || (status !== null && status >= 400))) verdict = "blocked";
    else if (baselineWords >= 100 && words < baselineWords * 0.5) verdict = "degraded";
    return { bot: bot.bot, userAgent: bot.ua, status, words, challenge, verdict };
  } catch (err) {
    return { bot: bot.bot, userAgent: bot.ua, status: null, words: 0, challenge: false, verdict: "error", error: oneLineError((err as Error).message) };
  } finally {
    if (routed) await page.unroute("**/*", handler).catch(() => {});
    if (cdp) await cdp.detach().catch(() => {});
  }
}

/** Reads /robots.txt from inside the loaded page (same origin), as plain text with its real line breaks. */
export async function readRobotsInPage(page: Page, pageUrl: string): Promise<BrowserStageResult["robotsTxt"]> {
  let url: string;
  try {
    url = `${new URL(pageUrl).origin}/robots.txt`;
  } catch {
    return null;
  }
  // Passed as a string expression: some TypeScript runners wrap functions in helpers the page does not have.
  const expr = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)}, { credentials: "omit", cache: "no-store", redirect: "follow" });
      const text = await r.text();
      return { url: ${JSON.stringify(url)}, status: r.status, contentType: r.headers.get("content-type"), text: text.slice(0, 200000) };
    } catch (e) {
      return { url: ${JSON.stringify(url)}, status: null, contentType: null, text: "", error: String(e).slice(0, 200) };
    }
  })()`;
  return page
    .evaluate(expr)
    .then((r) => r as BrowserStageResult["robotsTxt"])
    .catch((e: Error) => ({ url, status: null, contentType: null, text: "", error: e.message.slice(0, 200) }));
}

export async function runBrowserStage(input: AuditInput): Promise<BrowserStageResult> {
  const pageUrl = parseInputUrl(input.url).toString();
  const calls: CallLog[] = [];
  const out: BrowserStageResult = {
    ok: false,
    requestedUrl: pageUrl,
    finalUrl: null,
    status: null,
    redirectChain: [],
    headers: { xRobotsTag: null, contentType: null },
    raw: null,
    rendered: null,
    renderedInnerTextWords: 0,
    onlyAfterJs: { headings: [], title: false, description: false, canonical: false, h1: false, jsonLd: false },
    botProbes: [],
    screenshot: null,
    calls,
  };

  const t0 = Date.now();
  let session;
  try {
    session = await tfCreateBrowserSession({ timeout_seconds: 180 });
  } catch (err) {
    const e = err as TinyFishError;
    out.error =
      e.status === 404
        ? "Browser API is not enabled for this TinyFish account (404). Ask TinyFish support to enable it."
        : tinyfishErrorText(err, "a Browser session");
    calls.push({ endpoint: "browser", purpose: "Create remote browser session", ms: Date.now() - t0, ok: false, detail: out.error });
    return out;
  }
  calls.push({ endpoint: "browser", purpose: "Create remote browser session", ms: Date.now() - t0, ok: true });

  let browser: Browser | null = null;
  const t1 = Date.now();
  try {
    browser = await chromium.connectOverCDP(session.cdp_url, { timeout: 30_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

    // Wait for the server's response, then give the page time to build its DOM. A page whose scripts
    // keep "domcontentloaded" from firing (Substack took over 45 seconds once) is still audited from
    // what has loaded, instead of failing the whole stage.
    const resp = await page.goto(pageUrl, { waitUntil: "commit", timeout: 45_000 });
    const rawHtml = resp ? await resp.text().catch(() => "") : "";
    const domReady = await page
      .waitForLoadState("domcontentloaded", { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!domReady) out.slowLoad = true;
    out.status = resp?.status() ?? null;
    const headers = resp ? await resp.allHeaders().catch(() => ({}) as Record<string, string>) : {};
    out.headers = { xRobotsTag: headers["x-robots-tag"] ?? null, contentType: headers["content-type"] ?? null };
    const chain: string[] = [];
    let prev = resp?.request().redirectedFrom() ?? null;
    while (prev) {
      chain.unshift(prev.url());
      prev = prev.redirectedFrom();
    }
    out.redirectChain = chain;

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Scroll once to trigger lazy-loaded sections, then return to the top for the screenshot.
    await page
      .evaluate(async () => {
        window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
        await new Promise((r) => setTimeout(r, 1200));
        window.scrollTo(0, 0);
      })
      .catch(() => {});
    out.screenshot = await page
      .screenshot({ type: "jpeg", quality: 55 })
      .then((b) => `data:image/jpeg;base64,${b.toString("base64")}`)
      .catch(() => null);
    const renderedHtml = await page.content();
    out.renderedInnerTextWords = await page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .then((t) => wordCount(t))
      .catch(() => 0);
    out.finalUrl = pageUrlAfterRedirect(pageUrl, page.url());
    // Keep this tab open: closing the last tab ends the TinyFish browser context, and the probes reuse it.

    out.raw = htmlFacts(rawHtml);
    out.rendered = htmlFacts(renderedHtml);
    out.onlyAfterJs = onlyAfterJs(out.raw, out.rendered);
    // A challenge page can come back with HTTP 200. Detect it so it is never audited as the real page.
    // The rendered page decides: if the browser ends up on real content, it was not stopped, even if the
    // first HTML response was a challenge that JavaScript solved (non-JS crawlers still get that one).
    const rawReason = challengeReason(out.raw, rawHtml, out.status);
    const renderedReason = challengeReason(out.rendered, renderedHtml, null);
    if (renderedReason || (rawReason && out.rendered.words < CHALLENGE_MAX_WORDS)) {
      out.challenge = { title: out.rendered.title ?? out.raw.title, words: out.rendered.words, reason: renderedReason ?? rawReason ?? undefined };
    } else if (rawReason) {
      out.rawChallenge = { title: out.raw.title, words: out.raw.words, reason: rawReason };
    }
    // robots.txt as plain text, read from the page's own origin. Fetch returns markdown, which can lose
    // the line breaks robots.txt depends on; this copy is the file as served to a browser.
    out.robotsTxt = await readRobotsInPage(page, out.finalUrl || pageUrl);
    calls.push({
      endpoint: "browser",
      purpose: "Load page over CDP: capture raw server HTML, rendered DOM, headers, screenshot",
      ms: Date.now() - t1,
      ok: true,
      detail: `status ${out.status}, raw ${out.raw.words} words, rendered ${out.rendered.words} words${out.slowLoad ? " (still loading after a 30-second wait; audited what had loaded)" : ""}`,
    });

    const t2 = Date.now();
    // One at a time, on the same tab (see probe()). Skipped when the browser was challenged, on the
    // rendered page or in the first HTML response: there is no real page to compare the crawler responses with.
    out.botProbes = [];
    if (!out.challenge && !out.rawChallenge) {
      for (const b of PROBE_BOTS) {
        out.botProbes.push(await probe(page, out.finalUrl || pageUrl, b, out.raw!.words, out.status));
      }
    }
    await page.close().catch(() => {});
    calls.push({
      endpoint: "browser",
      purpose: `Request the page as ${PROBE_BOTS.map((b) => b.bot).join(", ")} (HTML document only) to detect edge blocking`,
      ms: Date.now() - t2,
      ok: true,
      detail: out.challenge
        ? `skipped: the browser itself received a bot challenge page (${out.challenge.reason})`
        : out.rawChallenge
          ? `skipped: the first HTML response was a bot challenge page (${out.rawChallenge.reason})`
        : out.botProbes.map((p) => `${p.bot}: ${p.verdict}`).join(", "),
    });
    out.ok = true;
  } catch (err) {
    out.error = oneLineError((err as Error).message, 300);
    calls.push({ endpoint: "browser", purpose: "Load page over CDP", ms: Date.now() - t1, ok: false, detail: out.error });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await tfDeleteBrowserSession(session.session_id);
  }
  return out;
}
