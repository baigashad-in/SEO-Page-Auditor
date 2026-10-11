// Shared types for every audit stage and the report.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Source = "fetch" | "browser" | "search" | "agent";
export type Confidence = "high" | "medium" | "low";
export type Category =
  | "access"
  | "rendering"
  | "extraction"
  | "metadata"
  | "structured_data"
  | "visibility"
  | "content_gap"
  | "answerability";

export interface AuditInput {
  url: string;
  query?: string;
  location?: string; // ISO country code for Search, e.g. "US"
}

/** One TinyFish API call, logged so the report can show exactly how TinyFish was used. */
export interface CallLog {
  endpoint: Source;
  purpose: string;
  ms: number;
  ok: boolean;
  detail?: string;
}

/* Fetch stage */

export interface Heading {
  level: number;
  text: string;
}

export interface MarkdownStats {
  words: number;
  headings: Heading[];
  h1Count: number;
  listItems: number;
  tableRows: number;
  paragraphs: number;
  firstWords: string; // first ~60 words of body text
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  language: string | null;
  author: string | null;
  publishedDate: string | null;
  markdown: string;
  links: string[];
  imageLinks: string[];
  latencyMs: number | null;
}

export interface FetchFailure {
  url: string;
  error: string;
  status?: number;
}

export type BotPurpose = "classic_search" | "ai_search" | "user_fetch" | "training";

export interface BotInfo {
  token: string;
  operator: string;
  purpose: BotPurpose;
  respectsRobots: boolean;
  note: string;
}

export interface RobotsVerdict {
  bot: BotInfo;
  allowed: boolean;
  matchedGroup: string | null; // user-agent group that applied, "*" or a token
  matchedRule: string | null; // e.g. "Disallow: /blog/"
}

export interface FetchStageResult {
  input: AuditInput;
  page: FetchedPage | null;
  pageError: FetchFailure | null;
  stats: MarkdownStats | null;
  robots: {
    found: boolean;
    url: string;
    note: string;
    verdicts: RobotsVerdict[];
    sitemaps: string[];
    status?: "parsed" | "absent" | "unreadable"; // unreadable: a challenge or HTML page came back instead
    source?: "fetch" | "browser"; // browser: the plain-text copy read through TinyFish Browser
    excerpt?: string; // start of what came back, kept as evidence when the file could not be parsed
    reflowed?: boolean; // line breaks were missing and the rules were reconstructed
  };
  llmsTxt: { found: boolean; url: string; chars: number };
  sitemap: { checkedUrl: string | null; containsUrl: boolean | null; note: string };
  links: { internal: number; external: number };
  calls: CallLog[];
  /** The Fetch API call itself failed (credits, rate limit, server error): nothing was learned about the page. */
  error?: string;
}

/* Browser stage */

export interface JsonLdSummary {
  blocks: number;
  types: string[];
  parseErrors: number;
  sample: string | null; // first block, trimmed, for the report
}

export interface HtmlFacts {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  metaRobots: string | null;
  htmlLang: string | null;
  h1: string[];
  headings: Heading[];
  og: { title: string | null; description: string | null; type: string | null; image: string | null };
  jsonLd: JsonLdSummary;
  hreflangCount: number;
  words: number;
  text: string; // visible-ish text, capped
  imgCount: number;
  imgMissingAlt: number;
  hasMain: boolean;
  hasArticle: boolean;
  dataNosnippetCount: number;
  scriptCount: number;
  emptyAppShell: boolean; // e.g. <div id="root"></div> with almost no text
  frameworkHints: string[]; // e.g. "Next.js", "WordPress", used to tailor fixes
}

export interface BotProbe {
  bot: string;
  userAgent: string;
  status: number | null;
  words: number;
  challenge: boolean;
  verdict: "ok" | "blocked" | "degraded" | "error";
  error?: string;
}

export interface BrowserStageResult {
  ok: boolean;
  error?: string;
  challenge?: { title: string | null; words: number; reason?: string } | null; // the browser itself got a bot challenge page
  // The first HTML response was a challenge, but the browser got through after JavaScript ran.
  // Crawlers that do not run JavaScript stop at that first response.
  rawChallenge?: { title: string | null; words: number; reason: string } | null;
  slowLoad?: boolean; // the DOM was still not ready after the wait; the report uses what had loaded
  // robots.txt read as plain text from inside the page (same origin). Null when not attempted.
  robotsTxt?: { url: string; status: number | null; contentType: string | null; text: string; error?: string } | null;
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  redirectChain: string[];
  headers: { xRobotsTag: string | null; contentType: string | null };
  raw: HtmlFacts | null; // server HTML, before any JavaScript runs
  rendered: HtmlFacts | null; // DOM after JavaScript runs
  renderedInnerTextWords: number;
  onlyAfterJs: {
    headings: string[];
    title: boolean;
    description: boolean;
    canonical: boolean;
    h1: boolean;
    jsonLd: boolean;
  };
  botProbes: BotProbe[];
  screenshot: string | null; // data URL (jpeg)
  calls: CallLog[];
}

/* Search stage */

export interface SerpItem {
  position: number;
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  date?: string;
}

export interface CompetitorPage {
  url: string;
  position: number;
  title: string;
  fetched: boolean;
  error?: string;
  stats?: MarkdownStats;
  description?: string | null;
  terms: Record<string, number>; // term -> count (top terms only)
}

export interface SearchStageResult {
  query: string;
  queryDerived: boolean;
  location: string;
  results: SerpItem[];
  pagesChecked: number;
  target: { position: number | null; matchedUrl: string | null; serpTitle: string | null; serpSnippet: string | null };
  domain: { bestPosition: number | null; urls: { position: number; url: string }[] };
  indexProbe: { query: string; found: boolean; position: number | null; domainUrls: string[] };
  competitors: CompetitorPage[];
  calls: CallLog[];
}

/* Agent stage */

export type AnswerLocation = "visible_on_load" | "after_scroll" | "after_interaction" | "other_page" | "not_on_page";

export interface AgentAnswer {
  answer_found: boolean;
  answer_summary: string | null;
  evidence_quote: string | null;
  answer_location: AnswerLocation;
  interactions_needed: string[];
  blockers: { type: string; description: string }[];
  page_purpose: string;
  missing_information: string[];
}

export interface AgentStageResult {
  ok: boolean;
  runId: string | null;
  status: string;
  error?: string;
  numSteps?: number | null;
  query: string;
  answer: AgentAnswer | null;
  calls: CallLog[];
}

/* Report */

export interface Fix {
  summary: string;
  steps: string[];
  code?: string;
  effort: "minutes" | "hours" | "days";
}

export interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  title: string;
  evidence: string[];
  visibilityImpact: string;
  fix: Fix;
  sources: Source[];
}

export interface Scores {
  readability: number; // 0-100, can AI tools read the page
  visibility: number | null; // 0-100, does it show up in search; null when Search did not run
  answerability: "answered" | "answered_with_effort" | "answered_elsewhere" | "not_answered" | "unknown";
  quadrant: "readable_visible" | "readable_invisible" | "unreadable_visible" | "unreadable_invisible" | "unknown";
  readabilityParts: { label: string; score: number; max: number }[];
  visibilityParts: { label: string; score: number; max: number }[];
  /** Stages that gave these scores no data (failed, skipped or out of credits). Absent in reports saved before v16. */
  missingStages?: Source[];
}

export interface AuditReport {
  generatedAt: string;
  input: AuditInput;
  query: string;
  queryDerived: boolean;
  scores: Scores;
  connection: string[]; // plain-English lines linking readability to visibility
  findings: Finding[];
  strengths: string[];
  doToday: string[]; // finding ids, best first
  views: {
    blockedNote?: string | null; // why the browser word counts are missing (e.g. a bot challenge)
    rawWords: number | null;
    renderedWords: number | null;
    extractedWords: number | null;
    rawSample: string;
    extractedSample: string;
  };
  calls: CallLog[];
  stages: {
    fetch: FetchStageResult | null;
    browser: BrowserStageResult | null;
    search: SearchStageResult | null;
    agent: AgentStageResult | null;
  };
}
