// Text the report writes for the site owner: URLs, errors, drafts, wording taken from the page,
// and how the agent's quote is matched. Cases follow live runs on all six demo pages.
import { describe, expect, it } from "vitest";
import { answeredOnOtherPage, buildFindings, pageCasing, plainDashes, snippetDraft, suggestDescription, withoutPageFraming } from "../lib/analyze/findings";
import { AGENT_OUTPUT_SCHEMA, agentGoal } from "../lib/stages/agentStage";
import { buildReport, domainList } from "../lib/analyze/report";
import { reportToMarkdown } from "../lib/analyze/markdownReport";
import { quoteAppearsIn } from "../lib/analyze/text";
import { robotsVerdicts } from "../lib/parse/robots";
import { displayUrl, oneLineError, pageUrlAfterRedirect } from "../lib/url";
import type { FetchStageResult } from "../lib/types";
import { agent, browserStage, bundle, fetchStage, LONG_TEXT, PAGE_URL, REDDIT_URL, search } from "./helpers";

// Fetch result shaped like Reddit's r/SEO page: a title and no meta description.
const redditFetch = (md: string, over: Partial<FetchStageResult> = {}) => fetchStage(md, over, REDDIT_URL, { title: "The SEO Authority", description: null });

describe("URLs and errors in the report", () => {
  it("keeps the requested URL when a challenge redirect only adds query parameters (Reddit)", () => {
    const final = "https://www.reddit.com/r/SEO/?solution=3f50&js_challenge=1&jsc_token=2824be&jsc_orig_r=";
    expect(pageUrlAfterRedirect(REDDIT_URL, final)).toBe(REDDIT_URL);
    expect(pageUrlAfterRedirect("https://a.com/old", "https://a.com/new")).toBe("https://a.com/new");
    expect(pageUrlAfterRedirect(REDDIT_URL, null)).toBe(REDDIT_URL);
  });

  it("shortens long share and tracking query strings for display (Substack)", () => {
    const long =
      "https://goodbetterbest.substack.com/p/3-simple-steps-to-make-pricing-changes?publication_id=22060&post_id=149705595&isFreemail=true&r=e0pzy&triedRedirect=true&utm_source=www.plg.news";
    expect(displayUrl(long)).toBe("https://goodbetterbest.substack.com/p/3-simple-steps-to-make-pricing-changes?\u2026");
    expect(displayUrl("https://shop.example/item?id=42")).toBe("https://shop.example/item?id=42");
  });

  it("puts errors on one line without terminal color codes (Substack browser timeout)", () => {
    const msg = 'page.goto: Timeout 45000ms exceeded.\nCall log:\n\u001b[2m  - navigating to "https://substack.com/@pricingsaas"\u001b[22m\n';
    expect(oneLineError(msg)).toBe("page.goto: Timeout 45000ms exceeded.");
  });

  it("keeps every TinyFish call on one row of the Markdown table", () => {
    const error = "page.goto: Timeout 45000ms exceeded.\nCall log:\n\u001b[2m  - navigating\u001b[22m\n";
    const br = { ...browserStage("<p>x</p>", undefined, {}, REDDIT_URL), ok: false, error };
    br.calls = [{ endpoint: "browser", purpose: "Load page over CDP", ms: 46484, ok: false, detail: error }];
    const md = reportToMarkdown(buildReport(bundle({ fetch: redditFetch("Reddit's No.1 SEO Community!"), browser: br }, REDDIT_URL), { url: REDDIT_URL }));
    const row = md.split("\n").find((l) => l.startsWith("| browser | Load page over CDP"))!;
    expect(row).toBe("| browser | Load page over CDP | 46.5s | failed: page.goto: Timeout 45000ms exceeded. |");
    expect(md).not.toContain("\u001b");
  });

  it("names a domain once with a page count", () => {
    expect(domainList(["https://pricingsaas.com/a", "https://www.pricingsaas.com/b", "https://pricingsaas.com/c", "https://en.wikipedia.org/x"])).toBe("pricingsaas.com (3 pages), en.wikipedia.org");
    expect(domainList(["https://newsletter.pricingsaas.com/", "https://pricingsaas.com/"])).toBe("newsletter.pricingsaas.com, pricingsaas.com");
  });
});

describe("drafts and wording taken from the page", () => {
  it("writes query words the way the page writes them", () => {
    expect(pageCasing("pricingsaas newsletter", ["@pricingsaas · CEO and co-founder of PricingSaaS."])).toBe("PricingSaaS Newsletter");
    expect(pageCasing("learn react", ["LEARN REACT Describing the UI. React apps are made of components."])).toBe("Learn React");
    expect(pageCasing("seo subreddit", ["Reddit's No.1 SEO Community"])).toBe("SEO Subreddit");
  });

  it("drafts the description from the agent's answer even when it got past a block first (Reddit)", () => {
    const a = agent({
      answer_summary: "The SEO subreddit is a community for search engine optimization discussions and news.",
      blockers: [{ type: "other", description: "Initially blocked by network security; required a US proxy" }],
    });
    const md = "Reddit's No.1 SEO Community!\n\nso after seeing all the threads i wanted to actually test it instead of guessing from logs.";
    const finding = buildFindings(bundle({ fetch: redditFetch(md), agent: a }, REDDIT_URL)).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).toContain("The SEO subreddit is a community");
  });

  it("does not cut a sentence at 'No.1' (Reddit)", () => {
    const a = agent({
      answer_summary:
        "The SEO subreddit on Reddit is a community dedicated to search engine optimization discussions and news. It is known as Reddit's No.1 SEO Community and hosts discussions on Google updates.",
    });
    const finding = buildFindings(bundle({ fetch: redditFetch("text"), agent: a }, REDDIT_URL)).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).not.toMatch(/Reddit's No\."/);
    expect(finding.fix.code).toContain("The SEO subreddit on Reddit is a community dedicated to search engine optimization discussions and news.");
  });

  it("gives timeout advice for a timeout, not credit advice (Substack)", () => {
    const br = { ...browserStage("<p>x</p>"), ok: false, error: "page.goto: Timeout 45000ms exceeded." };
    const note = buildFindings(bundle({ fetch: fetchStage("x"), browser: br, agent: agent({}) })).find((x) => x.id === "audit-coverage")!;
    expect(note.fix.steps.join(" ")).toContain("ran out of time");
    expect(note.fix.steps.join(" ")).not.toContain("credits");
  });
});

describe("the agent's quote", () => {
  const raw = "Sign up Sign in The Medium Blog 3.4M followers· 5+ editors Product News Latest Newsletter Get the best of Medium";

  it("matches a quote with an added label (Medium)", () => {
    expect(quoteAppearsIn("The Medium Blog: 3.4M followers, 5+ editors. Available sections: Product News, Latest, Newsletter.", raw)).toBe(true);
  });

  it("still rejects a paraphrase in different words (react.dev)", () => {
    const text = "Welcome to the React documentation! This page will give you an introduction to 80% of the React concepts that you will use on a daily basis.";
    expect(quoteAppearsIn("This Quick Start guide provides all you need to start learning React: 80% of what you'll use in your daily React development.", text)).toBe(false);
  });

  it("rates a short quote that only extraction drops as low, and says crawlers do receive it (tinyfish.ai)", () => {
    const html = "<html><body><nav>Works with any AI</nav><p>Web APIs built for agents.</p><main><p>Search, fetch and browse the web.</p></main></body></html>";
    const b = bundle({ fetch: fetchStage("Search, fetch and browse the web."), browser: browserStage(html), agent: agent({ evidence_quote: "Web APIs built for agents" }) });
    const finding = buildFindings(b).find((x) => x.id === "answer-hidden")!;
    expect(finding.severity).toBe("low");
    expect(finding.confidence).toBe("low");
    expect(finding.visibilityImpact).toContain("Crawlers receive this text in the HTML");
    expect(finding.evidence.join(" ")).toContain("only 5 words");
  });
});

describe("description drafts when the agent could not answer", () => {
  it("uses the search snippet instead of the first post on a feed page (Reddit)", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "login_wall", description: "You've been blocked by network security." }] });
    const md = "Reddit's No.1 SEO Community!\n\nso after seeing all the 'are AI bots ignoring robots.txt' threads i wanted to actually test it instead of guessing from logs.";
    const snippet = "r/SEO: The leading authority on all things SEO: AI SEO, GEO, LLM SEO, Technical SEO, Content SEO and SEO Architecture. Bring your ideas, problems\u2026";
    const s = search(1, { target: { position: 1, matchedUrl: REDDIT_URL, serpTitle: "The SEO Authority - Reddit", serpSnippet: snippet } }, REDDIT_URL, "seo subreddit");
    const finding = buildFindings(bundle({ fetch: redditFetch(md), agent: a, search: s }, REDDIT_URL, "seo subreddit")).find((x) => x.id === "meta-description-missing")!;
    expect(finding.fix.code).toContain('content="r/SEO: The leading authority on all things SEO: AI SEO, GEO, LLM SEO, Technical SEO, Content SEO and SEO Architecture."');
    expect(finding.fix.code).not.toContain("Bring your ideas");
    expect(finding.fix.code).not.toContain("so after seeing");
  });

  it("drops a leading date and an unfinished last sentence from snippets", () => {
    expect(snippetDraft("Jan 5, 2024 \u2014 Our guide explains how pricing pages work and what to test first on them. More tips for\u2026")).toBe(
      "Our guide explains how pricing pages work and what to test first on them.",
    );
    expect(snippetDraft("Too short\u2026")).toBeNull();
  });
});

describe("an answer behind a click that crawlers already receive (tinyfish.ai)", () => {
  it("is info, with an optional fix and no server-HTML advice", () => {
    const quote = "Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English.";
    const html = `<html><body><main><h2>TinyAgent</h2><p>${quote}</p></main></body></html>`;
    const a = agent({ answer_location: "after_interaction", interactions_needed: ["Dismissed banner", "Clicked TinyAgent product card"], evidence_quote: quote });
    const finding = buildFindings(bundle({ fetch: fetchStage(quote), browser: browserStage(html), agent: a })).find((x) => x.id === "answer-hidden")!;
    expect(finding.severity).toBe("info");
    expect(finding.visibilityImpact).toContain("No effect on AI visibility");
    expect(finding.fix.summary).toBe("Optional: show it to people without a click");
    expect(finding.fix.code).toBeUndefined();
  });
});

describe("the robots.txt line in the summary", () => {
  it("is hedged when the page ranks even though robots.txt closes it (Reddit)", () => {
    const v = robotsVerdicts("User-agent: *\nDisallow: /\n", REDDIT_URL);
    const f = redditFetch("text", { robots: { found: true, url: "https://www.reddit.com/robots.txt", note: "", verdicts: v.verdicts, sitemaps: [], status: "parsed" } });
    const r = buildReport(bundle({ fetch: f, search: search(1, {}, REDDIT_URL, "seo subreddit") }, REDDIT_URL, "seo subreddit"), { url: REDDIT_URL });
    const line = r.connection.find((l) => l.includes("search crawlers"))!;
    expect(line).toContain("as served to TinyFish");
    expect(line).toContain("The page still ranks");
  });
});

describe("an agent that answers from another page (tinyfish.ai)", () => {
  const quote = "TinyFish Web Agent is a web agent API for programmatic workflows that need to complete goals on live websites.";
  const steps = [
    "Click 'TinyAgent' from the Products dropdown to navigate to the agent page",
    "Click the FAQ accordion 'What is TinyFish Web Agent, and is it a web agent API?' to expand the answer",
  ];
  const homepage = "<html><body><main><h1>The web stack for AI agents</h1><p>Search, extract, browse, and act on the web with one platform.</p></main></body></html>";
  const b = () =>
    bundle(
      { fetch: fetchStage("Search, extract, browse, and act on the web with one platform."), browser: browserStage(homepage), agent: agent({ answer_location: "after_interaction", interactions_needed: steps, evidence_quote: quote }) },
      undefined,
      "web agent api",
    );

  it("says the answer is on another page instead of blaming a click on this one", () => {
    const ids = buildFindings(b()).map((f) => f.id);
    expect(ids).toContain("answer-other-page");
    expect(ids).not.toContain("answer-hidden");
    const r = buildReport(b(), { url: "https://example.com/page" });
    expect(r.scores.answerability).toBe("answered_elsewhere");
    expect(r.connection.join(" ")).toContain("only on another page it opened");
    expect(r.strengths.join(" ")).not.toContain("answered the query");
  });

  it("asks the agent to stay on the exact page and offers an 'other page' answer", () => {
    const goal = agentGoal("https://www.tinyfish.ai/", "web agent api");
    expect(goal).toContain("Stay on this exact page (https://www.tinyfish.ai/). Do not open other pages");
    expect(goal).toContain("other_page if this page only links to the answer");
    expect((AGENT_OUTPUT_SCHEMA.properties.answer_location as { enum: string[] }).enum).toContain("other_page");
  });

  it("still treats in-page clicks as in-page", () => {
    expect(answeredOnOtherPage({ ...agent({}).answer!, interactions_needed: ["Clicked the FAQ accordion to expand the answer"] })).toBe(false);
  });
});

describe("description tags (react.dev has og:description but no meta description)", () => {
  const og = "The library for web and native user interfaces";
  const snippet = "This page will give you an introduction to 80% of the React concepts that you will use on a daily basis.";
  const html = (head: string) => `<html><head><title>Quick Start - React</title>${head}</head><body><main><h1>Quick Start</h1><p>${LONG_TEXT}</p></main></body></html>`;
  const ranked = () => search(1, { target: { position: 1, matchedUrl: PAGE_URL, serpTitle: null, serpSnippet: snippet } });

  it("reports the missing tag instead of comparing the snippet with og:description", () => {
    const page = html(`<meta property="og:description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: og }), browser: browserStage(page), search: ranked(), query: "learn react" }));
    const ogOnly = all.find((x) => x.id === "meta-description-og-only")!;
    expect(ogOnly.severity).toBe("low");
    expect(ogOnly.evidence.join(" ")).toContain(snippet.slice(0, 40));
    expect(all.find((x) => x.id === "vis-snippet-rewritten")).toBeUndefined();
    expect(all.find((x) => x.id === "meta-description-missing")).toBeUndefined();
  });

  it("still compares a real meta description with the snippet", () => {
    const page = html(`<meta name="description" content="${og}"><meta property="og:description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: og }), browser: browserStage(page), search: ranked(), query: "learn react" }));
    expect(all.find((x) => x.id === "vis-snippet-rewritten")).toBeDefined();
    expect(all.find((x) => x.id === "meta-description-og-only")).toBeUndefined();
  });

  it("confirms a missing description with the page HTML (Wikipedia)", () => {
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: null }), browser: browserStage(html("")) }));
    expect(all.find((x) => x.id === "meta-description-missing")!.evidence.join(" ")).toContain("no meta description tag either");
  });

  it("does not report a missing description that the page HTML has", () => {
    const page = html(`<meta name="description" content="${og}">`);
    const all = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT, {}, PAGE_URL, { description: null }), browser: browserStage(page) }));
    expect(all.find((x) => x.id === "meta-description-missing")).toBeUndefined();
  });
});

describe("description drafts from the agent's summary", () => {
  it("drops the 'this page is' lead-in", () => {
    expect(withoutPageFraming("The react.dev/learn page is the official Quick Start guide.")).toBe("The official Quick Start guide.");
    expect(withoutPageFraming("The page provides a Quick Start guide covering core concepts.")).toBe("A Quick Start guide covering core concepts.");
    expect(withoutPageFraming("This page is the official React guide.")).toBe("The official React guide.");
    expect(withoutPageFraming("The Medium Blog page is a hub.")).toBe("The Medium Blog page is a hub.");
    expect(withoutPageFraming("React is a library for web and native user interfaces.")).toBe("React is a library for web and native user interfaces.");
  });

  it("uses the cleaned summary in the draft", () => {
    const draft = suggestDescription("", null, "This page is the official React Quick Start guide that introduces components, JSX and state.", null);
    expect(draft.startsWith("The official React Quick Start guide")).toBe(true);
  });
});

describe("summary wording", () => {
  it("does not credit Google for a TinyFish Search ranking (Medium)", () => {
    const raw = `<html><head><title>Medium</title></head><body><p>Sign in Write Get app</p></body></html>`;
    const rendered = `<html><head><title>The Medium Blog</title></head><body><p>Sign in Write Get app</p><p>${LONG_TEXT}</p></body></html>`;
    const r = buildReport(bundle({ fetch: fetchStage("Sign in"), browser: browserStage(raw, rendered), search: search(2), query: "medium blog" }), { url: PAGE_URL, query: "medium blog" });
    const line = r.connection.find((l) => l.startsWith("Non-JavaScript crawlers"))!;
    expect(line).toContain("The page still ranks #2 in TinyFish Search");
    expect(line).not.toContain("Google");
  });

  it("reads correctly when the agent was blocked (Reddit)", () => {
    const blocked = agent({ answer_found: false, answer_summary: null, answer_location: "not_on_page", blockers: [{ type: "captcha", description: "A CAPTCHA covered the page." }] });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), agent: blocked, query: "seo subreddit" }), { url: PAGE_URL, query: "seo subreddit" });
    expect(r.connection.join(" ")).toContain('An AI browsing agent looking for "seo subreddit" was blocked');
  });

  it("names full hosts so two results on one domain stay apart (Substack, Wikipedia)", () => {
    const results = [
      { position: 1, title: "a", url: "https://developers.google.com/search/docs", snippet: "", siteName: "" },
      { position: 2, title: "b", url: "https://www.mtu.edu/seo", snippet: "", siteName: "" },
    ];
    const rank = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), search: search(3, { results }) })).find((x) => x.id === "vis-rank")!;
    expect(rank.evidence[0]).toContain("Above you: #1 developers.google.com, #2 mtu.edu");
  });
});

describe("edge-block evidence (Medium blocks three AI search user-agents)", () => {
  it("names the bots that robots.txt allows in one line", () => {
    const probe = (bot: string) => ({ bot, userAgent: bot, status: 403, words: 119, challenge: true, verdict: "blocked" as const });
    const br = browserStage(`<html><body><p>${LONG_TEXT}</p></body></html>`, undefined, { botProbes: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"].map(probe) });
    const edge = buildFindings(bundle({ fetch: fetchStage(LONG_TEXT), browser: br })).find((x) => x.evidence.some((e) => e.includes("server or CDN")))!;
    const lines = edge.evidence.filter((e) => e.startsWith("robots.txt allows"));
    expect(lines).toEqual(["robots.txt allows OAI-SearchBot, Claude-SearchBot and PerplexityBot, so this block happens at the server or CDN, not in robots.txt."]);
  });
});

describe("scores built without every stage (TinyFish credits ran out, 2026-10-10)", () => {
  const failed = () =>
    browserStage("", "", { ok: false, raw: null, rendered: null, renderedInnerTextWords: 0, error: "Not enough TinyFish credits for a Browser session (402)." });
  const noCredits = () => ({ ...agent({}), ok: false, status: "NOT_STARTED", answer: null, error: "Not enough TinyFish credits for an Agent run (402)." });

  it("labels readability and answerability as partial", () => {
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: failed(), agent: noCredits(), search: search(2) }), { url: PAGE_URL });
    expect(r.scores.missingStages).toEqual(["browser", "agent"]);
    const md = reportToMarkdown(r);
    expect(md).toContain("(partial: Browser did not run)");
    expect(md).toContain("(the Agent stage gave no result)");
    expect(r.connection[0]).toContain("partial score");
  });

  it("does not call a bot challenge a missing stage (Reddit)", () => {
    const challenged = browserStage("<html><title>Prove your humanity</title></html>", undefined, { challenge: { title: "Prove your humanity", words: 3 } });
    const r = buildReport(bundle({ fetch: fetchStage(LONG_TEXT), browser: challenged, agent: agent({}), search: search(1) }), { url: PAGE_URL });
    expect(r.scores.missingStages).toEqual([]);
    expect(reportToMarkdown(r)).not.toContain("partial");
  });
});

describe("agent quotes with a label stitched on (tinyfish.ai, 2026-10-10)", () => {
  const fetchText = "Access the web that search can't reach. Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English. It works the live site.";
  const quote = "Multi-step web automation. Navigate, fill forms, authenticate, return structured results. Give it a goal in plain English.";

  it("counts the quote as present when its full sentences are, even if the short label was dropped", () => {
    expect(quoteAppearsIn(quote, fetchText)).toBe(true);
  });

  it("still fails when a full sentence is missing", () => {
    expect(quoteAppearsIn("Multi-step web automation. Navigate, fill forms, authenticate, return structured results. Book a demo with our sales team today.", fetchText)).toBe(false);
  });

  it("does not report the answer as dropped by extraction", () => {
    const raw = `<html><body><nav>TinyAgent Multi-step web automation</nav><p>${fetchText}</p><p>${LONG_TEXT}</p></body></html>`;
    const a = agent({ evidence_quote: quote, answer_location: "visible_on_load", interactions_needed: ["Dismiss notification banner"] });
    const all = buildFindings(bundle({ fetch: fetchStage(`${fetchText}\n\n${LONG_TEXT}`), browser: browserStage(raw), agent: a, query: "web agent api" }));
    expect(all.find((x) => x.evidence.join(" ").includes("In TinyFish Fetch extraction: no"))).toBeUndefined();
  });
});

describe("drafted descriptions use plain punctuation (react.dev)", () => {
  it("turns dashes from the agent's summary into commas", () => {
    const draft = suggestDescription("", null, "A structured path to learn React, starting with a Quick Start that covers 80% of core concepts\u2014components, JSX, styling and state.", null);
    expect(draft).not.toMatch(/[\u2014\u2013]/);
    expect(draft).toContain("core concepts, components");
  });

  it("keeps a numeric range readable", () => {
    expect(plainDashes("History 2012\u20132016 and later")).toBe("History 2012-2016 and later");
  });
});
