// Extracts SEO and AI-readability facts from HTML. Runs on both the raw server HTML
// (what a non-JavaScript crawler gets) and the rendered DOM (what a browser user gets).

import * as cheerio from "cheerio";
import type { Heading, HtmlFacts, JsonLdSummary } from "../types";
import { wordCount } from "../analyze/text";

export const TEXT_CAP = 40_000;

function clean(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t || null;
}

function jsonLdTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => jsonLdTypes(n, out, depth + 1));
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
    if (obj["@graph"]) jsonLdTypes(obj["@graph"], out, depth + 1);
    for (const [k, v] of Object.entries(obj)) {
      if (k !== "@graph" && typeof v === "object") jsonLdTypes(v, out, depth + 1);
    }
  }
}

const FRAMEWORKS: [string, RegExp][] = [
  ["Next.js", /__NEXT_DATA__|\/_next\/static\//],
  ["Nuxt", /__NUXT__|\/_nuxt\//],
  ["Gatsby", /___gatsby|gatsby-/],
  ["Angular", /ng-version=|ng-app/],
  ["SvelteKit", /__sveltekit|data-sveltekit/],
  ["Remix", /__remixContext/],
  ["Astro", /astro-island|data-astro-/],
  ["Vite SPA", /\/@vite\/client|type="module" crossorigin src="\/assets\/index-/],
  ["Create React App", /\/static\/js\/main\.[a-f0-9]+\.js/],
  ["WordPress", /wp-content|wp-includes/],
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme/],
  ["Webflow", /webflow\.js|data-wf-page/],
  ["Wix", /static\.wixstatic\.com|wix-bolt/],
  ["Squarespace", /static1\.squarespace\.com/],
  ["Framer", /framerusercontent\.com|data-framer-/],
];

// Elements that start a new line when rendered. Text on either side of them must not be glued
// together ("Sign in" + "The Medium Blog" must not become "Sign inThe Medium Blog").
const BLOCK_TAGS = new Set(
  (
    "address article aside blockquote body br dd details dialog div dl dt fieldset figcaption figure footer form " +
    "h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul " +
    "button label option select textarea"
  ).split(" "),
);

interface DomNode {
  type: string;
  data?: string;
  name?: string;
  children?: DomNode[];
}

/** Text of a DOM subtree with spaces at block boundaries. */
export function blockText(root: unknown): string {
  const parts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.type === "text") {
      parts.push(node.data ?? "");
      return;
    }
    const block = node.name ? BLOCK_TAGS.has(node.name.toLowerCase()) : false;
    if (block) parts.push(" ");
    for (const c of node.children ?? []) walk(c);
    if (block) parts.push(" ");
  };
  if (root) walk(root as DomNode);
  return parts.join("");
}

export function frameworkHints(html: string): string[] {
  const head = html.slice(0, 300_000);
  const found = FRAMEWORKS.filter(([, re]) => re.test(head)).map(([n]) => n);
  const gen = head.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (gen && !found.some((f) => gen[1].toLowerCase().includes(f.toLowerCase()))) found.push(gen[1].slice(0, 40));
  return found.slice(0, 4);
}

export function htmlFacts(html: string): HtmlFacts {
  const $ = cheerio.load(html);
  const hints = frameworkHints(html);

  const meta = (sel: string) => clean($(sel).first().attr("content"));

  // Read every <head> value now: the head is removed further down to measure body text.
  const metaDescription = meta('meta[name="description" i]');
  const robotsValues = [meta('meta[name="robots" i]'), meta('meta[name="googlebot" i]')].filter(Boolean);
  const metaRobots = robotsValues.length ? robotsValues.join(", ") : null;
  const og = {
    title: meta('meta[property="og:title"]'),
    description: meta('meta[property="og:description"]'),
    type: meta('meta[property="og:type"]'),
    image: meta('meta[property="og:image"]'),
  };

  // JSON-LD before scripts are removed
  const ld: JsonLdSummary = { blocks: 0, types: [], parseErrors: 0, sample: null };
  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    ld.blocks++;
    try {
      const parsed = JSON.parse(raw);
      jsonLdTypes(parsed, types);
      if (!ld.sample) ld.sample = raw.length > 1200 ? raw.slice(0, 1200) + " …" : raw;
    } catch {
      ld.parseErrors++;
    }
  });
  ld.types = [...types].slice(0, 20);

  const scriptCount = $("script").length;
  const htmlLang = clean($("html").attr("lang"));
  const canonical = clean($('link[rel="canonical"]').first().attr("href"));
  const hreflangCount = $('link[rel="alternate"][hreflang]').length;
  const title = clean($("head title").first().text()) ?? clean($("title").first().text());

  const imgs = $("img");
  let imgMissingAlt = 0;
  imgs.each((_, el) => {
    const alt = $(el).attr("alt");
    const role = $(el).attr("role");
    const hidden = $(el).attr("aria-hidden") === "true";
    if (alt === undefined && role !== "presentation" && !hidden) imgMissingAlt++;
  });

  // Headings from the body, before removing hidden templates
  const headings: Heading[] = [];
  $("body h1, body h2, body h3, body h4").each((_, el) => {
    const text = clean($(el).text());
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 200) });
  });

  // Visible-ish text: drop non-content nodes. noscript is kept on purpose (a non-JS crawler reads it),
  // but its content arrives as raw markup, so it is parsed and reduced to text first.
  $("noscript").each((_, el) => {
    const inner = cheerio.load($(el).text());
    inner("script, style, iframe, link, meta, img").remove();
    $(el).replaceWith(` ${inner.root().text()} `);
  });
  $("script, style, template, svg, iframe, link, meta, head").remove();
  const bodyRoot = $("body")[0] ?? $.root()[0];
  const bodyText = clean(blockText(bodyRoot)) ?? "";

  const rootish = $("#root, #__next, #app, #__nuxt, [data-reactroot]").first();
  const emptyAppShell = rootish.length > 0 && wordCount(rootish.text()) < 20 && wordCount(bodyText) < 80;

  return {
    title,
    metaDescription,
    canonical,
    metaRobots,
    htmlLang,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings: headings.slice(0, 80),
    og,
    jsonLd: ld,
    hreflangCount,
    words: wordCount(bodyText),
    text: bodyText.slice(0, TEXT_CAP),
    imgCount: imgs.length,
    imgMissingAlt,
    hasMain: $("main, [role=main]").length > 0,
    hasArticle: $("article").length > 0,
    dataNosnippetCount: $("[data-nosnippet]").length,
    scriptCount,
    emptyAppShell,
    frameworkHints: hints,
  };
}

// Bot challenge and block pages.
//
// Phrases are matched against the decoded title and visible text of the WHOLE page, never against
// scripts or a slice of the markup. Ordinary pages carry bot-manager code that mentions these words
// (Cloudflare adds a /cdn-cgi/challenge-platform/ detection script to normal pages, sign-in forms ship
// reCAPTCHA config), and a long <head> can push the real <title> past any fixed slice. Matching markup
// that way flagged Wikipedia and Medium as challenges and missed Reddit's "Prove your humanity" page.
const CHALLENGE_PHRASES = [
  "just a moment",
  "attention required",
  "access denied",
  "access to this page has been denied",
  "are you a robot",
  "not a robot",
  "verify you are human",
  "verifying you are human",
  "verify that you are human",
  "prove your humanity",
  "you've been blocked",
  "you have been blocked",
  "checking your browser",
  "checking if the site connection is secure",
  "enable javascript and cookies to continue",
  "please complete the security check",
  "complete the challenge",
  "request unsuccessful",
  "pardon our interruption",
  "press & hold",
  "press and hold",
  "unusual traffic",
  "blocked by network security",
  "solve the captcha",
  "complete the captcha",
  "enter the characters you see",
];

// Markup that only the challenge or block page itself carries (Cloudflare challenge and error pages,
// PerimeterX, DataDome). Not the detection scripts that run on normal pages.
const CHALLENGE_MARKUP = ["cf_chl_", "cf-browser-verification", 'id="challenge-form"', "px-captcha", "captcha-delivery.com", "cf-error-details"];

/** Challenge pages are short. A page with this many visible words is real content, whatever it mentions. */
export const CHALLENGE_MAX_WORDS = 400;

function normChallenge(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\s\u00a0]+/g, " ");
}

/**
 * Why this response looks like a bot challenge or block page, or null when it looks like real content.
 * Works on facts already extracted by htmlFacts (decoded title, visible text, word count of the whole body).
 */
export function challengeReason(
  facts: { title: string | null; text: string; words: number },
  html = "",
  status: number | null = null,
): string | null {
  if (facts.words >= CHALLENGE_MAX_WORDS) return null;
  if (status === 401 || status === 403 || status === 429 || status === 503) return `HTTP ${status}`;
  const visible = normChallenge(`${facts.title ?? ""} ${facts.text.slice(0, 4000)}`);
  const phrase = CHALLENGE_PHRASES.find((p) => visible.includes(p));
  if (phrase) return `the page says "${phrase}"`;
  const lowerHtml = html.toLowerCase();
  const mark = CHALLENGE_MARKUP.find((m) => lowerHtml.includes(m));
  if (mark) return `challenge markup (${mark})`;
  return null;
}

/** HTML response body in, true when it is a challenge or block page. */
export function looksLikeChallenge(html: string, status: number | null): boolean {
  return challengeReason(htmlFacts(html), html, status) !== null;
}

/** Plain text (for example what Fetch returned for robots.txt or a sitemap) that is a challenge page. */
export function looksLikeChallengeText(text: string, title: string | null = null): boolean {
  const visible = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return challengeReason({ title, text: visible, words: wordCount(visible) }, text) !== null;
}
