/** Largest fenced block with the given info string (e.g. "diff"), or null. */
export function fenced(text: string, lang: string): string | null {
  const re = new RegExp("```" + lang + "[^\\n]*\\n([\\s\\S]*?)```", "g");
  let best: string | null = null;
  for (const m of text.matchAll(re)) if (!best || m[1]!.length > best.length) best = m[1]!;
  return best;
}
/** Text after a markdown heading (e.g. "## Self-review") up to the next same-level heading. */
export function section(text: string, heading: string): string | null {
  const i = text.search(new RegExp(`^#{1,3}\\s*${heading}`, "im"));
  if (i < 0) return null;
  const rest = text.slice(i);
  const j = rest.slice(1).search(/^#{1,2}\s/m);
  return (j < 0 ? rest : rest.slice(0, j + 1)).trim();
}
