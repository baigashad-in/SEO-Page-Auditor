// Short notes that say when a score rests on fewer stages than usual (a stage failed, was skipped or
// ran out of credits). The web report, the markdown export and the demo index all use these, so a
// partial score never looks like a full one.

import type { Scores, Source } from "../types";

const NAME: Record<Source, string> = { fetch: "Fetch", browser: "Browser", search: "Search", agent: "Agent" };

function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

export function scoreNotes(s: Scores): { readability: string | null; answerability: string | null } {
  const miss = s.missingStages ?? [];
  const forReadability = miss.filter((x) => x === "fetch" || x === "browser").map((x) => NAME[x]);
  return {
    readability: forReadability.length ? `partial: ${joinNames(forReadability)} did not run` : null,
    answerability: miss.includes("agent") ? "the Agent stage gave no result" : null,
  };
}
