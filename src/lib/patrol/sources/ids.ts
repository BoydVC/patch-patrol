const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/gi;
const CVE = /CVE-\d{4}-\d{4,}/gi;
const PYSEC = /PYSEC-\d{4}-\d+/gi;
const RUSTSEC = /RUSTSEC-\d{4}-\d+/gi;

export function extractAliases(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(GHSA)) ids.add(match[0]);
  for (const match of text.matchAll(CVE)) ids.add(match[0].toUpperCase());
  for (const match of text.matchAll(PYSEC)) ids.add(match[0]);
  for (const match of text.matchAll(RUSTSEC)) ids.add(match[0]);
  return [...ids];
}
