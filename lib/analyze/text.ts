// Small, dependency-free text helpers: tokenizing, stopwords, term counts, query coverage.

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him himself his " +
    "how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out " +
    "over own same she should so some such than that the their theirs them themselves then there these they this those through to too " +
    "under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves " +
    "get got may might must shall us via per vs etc one two new use used using like make made way ways best top also within without " +
    "s t don isn aren wasn weren hasn haven doesn didn won wouldn shouldn couldn can't don't it's i'm you're we're they're " +
    "click here read more learn see view menu home page site cookie cookies privacy policy terms sign login log subscribe share"
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [])
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 1);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Very light stemming so "audits" matches "audit" and "pricing" stays "pricing". */
export function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("es") && /(ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

/**
 * Term counts for unigrams and bigrams of content words (stemmed). Bigrams only join words that are
 * directly adjacent in the original text, inside one phrase, so "start a free trial" yields
 * "free trial" but not "start free".
 */
export function termCounts(text: string, maxTerms = 250, minBigramCount = 2): Record<string, number> {
  const counts = new Map<string, number>();
  for (const phrase of text.split(/[.!?;:,()[\]{}|\n\r"]+/)) {
    const raw = tokenize(phrase);
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (STOPWORDS.has(a) || /^\d+$/.test(a)) continue;
      const sa = stem(a);
      counts.set(sa, (counts.get(sa) || 0) + 1);
      const b = raw[i + 1];
      if (b && !STOPWORDS.has(b) && !/^\d+$/.test(b)) {
        const bg = `${sa} ${stem(b)}`;
        counts.set(bg, (counts.get(bg) || 0) + 1);
      }
    }
  }
  return Object.fromEntries(
    [...counts.entries()]
      .filter(([k, v]) => v >= (k.includes(" ") ? minBigramCount : 1))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTerms),
  );
}

/** Every stemmed content word and adjacent word pair in the text, at any count. */
export function phraseSet(text: string): Set<string> {
  return new Set(Object.keys(termCounts(text, Number.MAX_SAFE_INTEGER, 1)));
}

export function queryTerms(query: string): string[] {
  const terms = contentTokens(query).map(stem);
  return [...new Set(terms)];
}

export function containsTerm(text: string, term: string): boolean {
  const set = new Set(contentTokens(text).map(stem));
  return set.has(term);
}

export interface QueryCoverage {
  terms: string[];
  inText: string[];
  missing: string[];
  inFirstWords: string[];
  inHeadings: string[];
}

export function queryCoverage(query: string, fullText: string, firstWords: string, headings: string[]): QueryCoverage {
  const terms = queryTerms(query);
  const full = new Set(contentTokens(fullText).map(stem));
  const first = new Set(contentTokens(firstWords).map(stem));
  const heads = new Set(contentTokens(headings.join(" ")).map(stem));
  return {
    terms,
    inText: terms.filter((t) => full.has(t)),
    missing: terms.filter((t) => !full.has(t)),
    inFirstWords: terms.filter((t) => first.has(t)),
    inHeadings: terms.filter((t) => heads.has(t)),
  };
}

/** Normalizes text for fuzzy "does this quote appear in that text" checks. */
export function normForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when 80% of the quote's words sit in runs of three or more that also occur in the text. */
function coveredIn(quote: string, t: string): boolean {
  const q = normForMatch(quote).split(" ").filter(Boolean);
  if (q.length === 0) return false;
  if (q.length < 3) return t.includes(` ${q.join(" ")} `);
  const found = new Array<boolean>(q.length).fill(false);
  for (let i = 0; i + 3 <= q.length; i++) {
    if (t.includes(` ${q[i]} ${q[i + 1]} ${q[i + 2]} `)) found[i] = found[i + 1] = found[i + 2] = true;
  }
  return found.filter(Boolean).length / q.length >= 0.8;
}

/**
 * True when the quote is on the page, allowing small edits. Every 3-word run of the quote that also
 * occurs in the text marks its words as found; the quote counts as present when at least 80% of its
 * words are found. An agent that adds a label ("Available sections:") or changes punctuation still
 * matches; a paraphrase in different words does not.
 */
export function quoteAppearsIn(quote: string, text: string): boolean {
  return quoteMatcher(text)(quote);
}

/** quoteAppearsIn for many quotes against one text, normalizing the text once. */
export function quoteMatcher(text: string): (quote: string) => boolean {
  const t = ` ${normForMatch(text)} `;
  return (quote) => quoteInNormalized(quote, t);
}

function quoteInNormalized(quote: string, t: string): boolean {
  if (coveredIn(quote, t)) return true;
  // Agents stitch short labels onto the sentences they quote ("Multi-step web automation. Navigate,
  // fill forms, ..." on tinyfish.ai, where the label is a product tab). Extractors drop such labels
  // as navigation, so a quote whose full sentences are all present counts as present.
  const parts = quote.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  // A label is under five words as written ("Multi-step web automation." is three).
  const sentences = parts.filter((s) => s.split(/\s+/).length >= 5);
  return sentences.length > 0 && sentences.length < parts.length && sentences.every((s) => coveredIn(s, t));
}

export function firstNWords(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
