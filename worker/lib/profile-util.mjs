// profile-util.mjs — small helpers shared across the worker.

/** A plain contact line for document headers. Uses only comma/period-style
 *  separators (a middot spacer), never fancy punctuation. */
/** Turn a role description paragraph into up to `max` complete sentences,
 *  so a resume bullet is never cut off mid word. */
export function sentencesFrom(text, max = 3) {
  if (!text) return [];
  return String(text)
    .split(/(?<=[.])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, max);
}

export function contactFromProfile(p) {
  const linkedin = p.linkedin && !/^https?:/.test(p.linkedin) ? `linkedin.com/in/${p.linkedin}` : p.linkedin;
  const github = p.github && !/^https?:/.test(p.github) ? `github.com/${p.github}` : p.github;
  return [p.email, p.phone, linkedin, github, p.portfolio, p.country]
    .filter(Boolean)
    .join("  .  ");
}
