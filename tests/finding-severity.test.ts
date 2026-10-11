// Severity follows the evidence: what is missing, how much, and whether the page ranks anyway.
// Cases follow live runs on Medium, Substack and tinyfish.ai.
import { describe, expect, it } from "vitest";
import { markdownStats } from "../lib/parse/markdown";
import { browserRenderIncomplete, buildFindings, buildStrengths, fetchMissedJsContent, sortFindings, topicGaps } from "../lib/analyze/findings";
import { buildReport } from "../lib/analyze/report";
import type { Finding } from "../lib/types";
import { agent, browserStage, bundle, fetchStage, LONG_TEXT, PAGE_URL, search } from "./helpers";

describe("query words missing from the text", () => {
  it("rates a word that is in the title, on a page ranking #2, as low (Medium)", () => {
    const md = "Here is what stood out at our annual event and other news.";
    const b = bundle({ fetch: fetchStage(md, {}, PAGE_URL, { title: "The Medium Blog" }), search: search(2), query: "medium blog" });
    const finding = buildFindings(b).find((x) => x.id === "content-query-terms-missing")!;
    expect(finding.severity).toBe("low");
    expect(finding.title).toContain("only in the title or description");
  });

  it("keeps it high when the word is nowhere and the page does not rank (Substack)", () => {
    const md = "John Kotowski. CEO and co-founder of PricingSaaS. Good Better Best. 10K+ subscribers.";
    const b = bundle({ fetch: fetchStage(md, {}, PAGE_URL, { title: "John Kotowski | Substack", description: null }), search: search(null), query: "pricingsaas newsletter" });
    expect(buildFindings(b).find((x) => x.id === "content-query-terms-missing")!.severity).toBe("high");
  });
});

describe("thin and JavaScript-only text", () => {
  it("does not call a page thin as 'high' when the pages that rank have even less text", () => {
    const comps = [33, 28, 162].map((w, i) => ({ url: `https://other.com/${i}`, position: i + 1, title: "t", fetched: true, terms: {}, stats: markdownStats("word ".repeat(w)) }));
    const b = bundle({ fetch: fetchStage("word ".repeat(46)), search: search(null, { competitors: comps }) });
    const finding = buildFindings(b).find((x) => x.id === "extract-thin")!;
    expect(finding.severity).toBe("medium");
    expect(finding.evidence.join(" ")).toContain("competing pages are thin too");
  });

  it("rates 61 JavaScript-only words as medium, not high", () => {
    const raw = `<html><body><p>${"word ".repeat(46)}</p></body></html>`;
    const ren = `<html><body><p>${"word ".repeat(46)}</p><p>${"later ".repeat(61)}</p></body></html>`;
    const finding = buildFindings(bundle({ fetch: fetchStage("x"), browser: browserStage(raw, ren) })).find((x) => x.id === "render-js-dependent-content")!;
    expect(finding.severity).toBe("medium");
  });

  it("still rates a large JavaScript-only gap as critical", () => {
    const raw = `<html><body><p>${"word ".repeat(49)}</p></body></html>`;
    const ren = `<html><body><p>${"word ".repeat(49)}</p><p>${"later ".repeat(1780)}</p></body></html>`;
    expect(buildFindings(bundle({ fetch: fetchStage("x"), browser: browserStage(raw, ren) })).find((x) => x.id === "render-js-dependent-content")!.severity).toBe("critical");
  });

  it("says 'no headings' instead of 'only 0 heading(s)'", () => {
    expect(buildFindings(bundle({ fetch: fetchStage("word ".repeat(679)) })).find((x) => x.id === "struct-wall-of-text")!.title).toBe("679 extracted words and no headings");
  });
});

describe("obstacles the agent got past", () => {
  it("rates a banner the agent dismissed before answering on load as low (tinyfish.ai)", () => {
    const a = agent({ blockers: [{ type: "modal", description: "Promotional banner at the top of the page" }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blockers")!.severity).toBe("low");
    const notFound = agent({ answer_found: false, blockers: [{ type: "modal", description: "Newsletter pop-up" }] });
    expect(buildFindings(bundle({ agent: notFound })).find((x) => x.id === "answer-blockers")!.severity).toBe("medium");
  });
});

describe("blockers the agent labels wrongly", () => {
  it("treats a 'login wall' that says 'blocked by network security' as a block page (Reddit)", () => {
    const a = agent({
      answer_found: false,
      answer_location: "not_on_page",
      blockers: [{ type: "login_wall", description: "Reddit requires login to view the subreddit content, showing a 'You've been blocked by network security' message with a login button." }],
    });
    const finding = buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!;
    expect(finding.title).toContain("(a block page)");
    expect(finding.fix.steps.join(" ")).not.toContain("login wall");
    expect(finding.evidence.join(" ")).toContain("the agent called this a login wall, but it describes a bot block");
  });

  it("keeps a real login wall as a login wall", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "login_wall", description: "The page asks members to sign in before showing the article." }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!.title).toContain("(a login wall)");
  });

  it("rates a banner the agent dismissed as low even when it answered after clicking (tinyfish.ai)", () => {
    const a = agent({ answer_location: "after_interaction", blockers: [{ type: "cookie_wall", description: "Cookie/notification banner at the top about Search and Fetch APIs" }] });
    expect(buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blockers")!.severity).toBe("low");
  });
});

describe("content gaps", () => {
  it("ignores generic words like 'content' even when competitors use them in headings (Substack)", () => {
    const comp = (url: string) => ({ url, title: "t", terms: { content: 4, pricing: 9, "pricing change": 3 }, headings: ["Engage with our content", "Pricing changes this week"] });
    const gaps = topicGaps("John Kotowski, CEO of PricingSaaS.", [comp("https://a.com/"), comp("https://b.com/"), comp("https://c.com/")]);
    expect(gaps.map(([term]) => term)).not.toContain("content");
  });
});

describe("content gaps from single words", () => {
  it("keeps phrases used by 2 of 3 pages but drops single words unless every page has them in a heading (tinyfish.ai)", () => {
    const steel = { url: "https://steel.dev/", title: "Steel", terms: { stuck: 2, human: 4, "open source": 3, "browser session": 6 }, headings: ["Help your agent whenever it's stuck", "Browse like humans", "Open source browser sessions"] };
    const paper = { url: "https://a.github.io/agents/", title: "Paper", terms: { "api call": 13 }, headings: ["API calls for agents"] };
    const bb = { url: "https://browserbase.com/", title: "Browserbase", terms: { stuck: 2, human: 5, "open source": 10, "browser session": 4 }, headings: ["Unblock agents that get stuck", "Research at a scale no human could", "Open source browser sessions"] };
    const terms = topicGaps("Search, fetch and browse the web with one API.", [steel, paper, bb]).map(([term]) => term);
    expect(terms).toEqual(expect.arrayContaining(["open source", "browser session"]));
    expect(terms).not.toContain("stuck");
    expect(terms).not.toContain("human");
  });
});

describe("blocker labels", () => {
  it("adds no override note when the agent's label was just 'other' (Reddit)", () => {
    const a = agent({ answer_found: false, answer_location: "not_on_page", blockers: [{ type: "other", description: "Page shows 'You've been blocked by network security' instead of the subreddit." }] });
    const finding = buildFindings(bundle({ agent: a })).find((x) => x.id === "answer-blocked")!;
    expect(finding.title).toContain("(a block page)");
    expect(finding.evidence.join(" ")).not.toContain("the agent called this");
  });
});

describe("text that Fetch also misses because it only exists after JavaScript (medium.com/blog)", () => {
  const nav = "Sign in Write Get app ".repeat(8);
  const stories = Array.from({ length: 6 }, (_, i) => `<h2>Story number ${i} about writing</h2><p>${LONG_TEXT.slice(0, 1500)}</p>`).join("");
  const raw = `<html><head><title>Medium</title></head><body><main><p>${nav}</p></main></body></html>`;
  const rendered = `<html><head><title>The Medium Blog</title></head><body><main><p>${nav}</p>${stories}</main></body></html>`;
  const jsHeadings = Array.from({ length: 6 }, (_, i) => `Story number ${i} about writing`);
  const br = () => browserStage(raw, rendered, { onlyAfterJs: { headings: jsHeadings, title: false, description: false, canonical: false, h1: false, jsonLd: false } });
  const thinMd = "Write\n\nSign in\n\n## The Medium Blog\n\nGet the best of Medium delivered to you weekly.";

  it("reports one rendering problem instead of two extraction problems", () => {
    const b = bundle({ fetch: fetchStage(thinMd), browser: br(), search: search(2), query: "medium blog" });
    expect(fetchMissedJsContent(b)).toBe(true);
    const all = buildFindings(b);
    const js = all.find((x) => x.id === "render-js-dependent-content")!;
    expect(js.severity).toBe("critical");
    expect(js.evidence.join(" ")).toContain("no more than the raw HTML holds");
    expect(js.sources).toContain("fetch");
    expect(all.find((x) => x.id === "extract-content-lost")).toBeUndefined();
    expect(all.find((x) => x.id === "extract-thin")).toBeUndefined();
  });

  it("still blames extraction when Fetch got more than the raw HTML", () => {
    const md = `## The Medium Blog\n\n${"Writers share stories about craft and tools every week. ".repeat(20)}`;
    const b = bundle({ fetch: fetchStage(md), browser: br(), search: search(2), query: "medium blog" });
    expect(fetchMissedJsContent(b)).toBe(false);
    const all = buildFindings(b);
    expect(all.find((x) => x.id === "extract-content-lost")!.title).toContain("of the visible text");
    expect(all.find((x) => x.id === "extract-thin")).toBeDefined();
  });

  it("rates a raw title that JavaScript only lengthens as medium", () => {
    const b = bundle({ fetch: fetchStage(thinMd), browser: br(), search: search(2), query: "medium blog" });
    const tags = buildFindings(b).find((x) => x.id === "render-tags-js-only")!;
    expect(tags.severity).toBe("medium");
    expect(tags.evidence[0]).toContain("shorter, less specific title");
  });

  it("keeps a placeholder title that JavaScript replaces as high", () => {
    const body = `<body><main><p>${LONG_TEXT}</p></main></body>`;
    const b = bundle({ browser: browserStage(`<html><head><title>Loading</title></head>${body}</html>`, `<html><head><title>Pricing | Acme</title></head>${body}</html>`) });
    expect(buildFindings(b).find((x) => x.id === "render-tags-js-only")!.severity).toBe("high");
  });
});

describe("order of findings with the same severity (Reddit)", () => {
  const f = (id: string, confidence: Finding["confidence"], effort: Finding["fix"]["effort"]): Finding => ({
    id,
    category: "access",
    severity: "high",
    confidence,
    title: id,
    evidence: [],
    visibilityImpact: "",
    fix: { summary: "", steps: [], effort },
    sources: [],
  });

  it("puts confirmed findings before quick fixes the evidence only suggests", () => {
    const sorted = sortFindings([f("robots-low", "low", "minutes"), f("agent-medium", "medium", "hours"), f("challenge-high", "high", "hours")]);
    expect(sorted.map((x) => x.id)).toEqual(["challenge-high", "agent-medium", "robots-low"]);
  });
});

describe("a browser render that missed text Fetch got (medium.com/blog, 2026-10-11)", () => {
  const shell = "Sign in Write Get app The Medium Blog Follow Product News Latest Newsletter Subscribe Help Status About Careers";
  const raw = `<html><head><title>Medium</title></head><body><p>${shell}</p></body></html>`;
  const rendered = `<html><head><title>The Medium Blog</title></head><body><p>${shell} Editor's picks</p></body></html>`;
  const articles = [
    "Here is what stood out at Medium Day this year, from reading and writing to sharing.",
    "The State of Writing Report: most writers use AI in some way, but most writing happens in private.",
    "How twelve writers are using a new social writing app to write more, and more often.",
    "Try out custom footers on your stories, a new way to highlight the work you do.",
  ];
  const fetchMd = articles.join("\n\n");
  const b = () => bundle({ fetch: fetchStage(fetchMd), browser: browserStage(raw, rendered), search: search(null), query: "medium blog" });

  it("notices the gap and judges JavaScript from Fetch's text", () => {
    expect(browserRenderIncomplete(b())).not.toBeNull();
    const all = buildFindings(b());
    expect(all.find((x) => x.id === "render-incomplete")).toBeDefined();
    const js = all.find((x) => x.id === "render-js-dependent-content")!;
    expect(js.confidence).toBe("medium");
    expect(js.evidence[0]).toContain("in lines the raw HTML does not contain");
  });

  it("does not claim the content is in the server HTML", () => {
    expect(buildStrengths(b()).join(" ")).not.toContain("Content is in the server HTML");
    const r = buildReport(b(), { url: PAGE_URL, query: "medium blog" });
    expect(r.connection.join(" ")).toContain("render was incomplete");
    expect(r.views.blockedNote).toContain("incomplete");
    expect(r.scores.readabilityParts.find((p) => p.label === "Works without JavaScript")!.score).toBeLessThan(15);
  });

  it("stays quiet when the rendered page holds Fetch's text (a normal page)", () => {
    const full = `<html><head><title>The Medium Blog</title></head><body><p>${shell}</p>${articles.map((a) => `<p>${a}</p>`).join("")}</body></html>`;
    const normal = bundle({ fetch: fetchStage(fetchMd), browser: browserStage(full, full), query: "medium blog" });
    expect(browserRenderIncomplete(normal)).toBeNull();
    expect(buildFindings(normal).find((x) => x.id === "render-incomplete")).toBeUndefined();
  });

  it("skips the check when the stored page text was cut at its size limit", () => {
    const long = `<html><body><p>${LONG_TEXT.repeat(8)}</p></body></html>`;
    // Fetch's lines are not in the stored text, which would read as a gap if the cap were ignored.
    const capped = bundle({ fetch: fetchStage(fetchMd), browser: browserStage(long, long) });
    expect(capped.browser!.rendered!.text.length).toBeGreaterThanOrEqual(39_900);
    expect(browserRenderIncomplete(capped)).toBeNull();
  });
});
