import type { Advisory, AffectedPackage, Severity, SourceId } from "../types";
import { SEVERITY_RANK } from "../types";
import { normalizeName } from "../versions";

export function mergeAdvisories(advisories: Advisory[]): Advisory[] {
  const parent = advisories.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    parent[index] = cursor;
    return cursor;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const seen = new Map<string, number>();
  advisories.forEach((advisory, index) => {
    for (const id of [advisory.id, ...advisory.aliases]) {
      const key = id.toUpperCase();
      const previous = seen.get(key);
      if (previous === undefined) seen.set(key, index);
      else union(previous, index);
    }
  });
  const groups = new Map<number, Advisory[]>();
  advisories.forEach((advisory, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(advisory);
    groups.set(root, group);
  });
  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(group: Advisory[]): Advisory {
  const ids = group.flatMap((advisory) => [advisory.id, ...advisory.aliases]);
  const id = preferId(ids);
  const aliases = [...new Set(ids.filter((item) => item.toUpperCase() !== id.toUpperCase()))];
  const sources = [...new Set(group.flatMap((advisory) => advisory.sources))].sort() as SourceId[];
  const primary = group.find((advisory) => advisory.id.toUpperCase() === id.toUpperCase()) ?? group[0];
  const summary = primary.summary;
  const details = primary.details ?? group.find((advisory) => advisory.details)?.details;
  const severity = group.reduce<Severity>(
    (best, advisory) => (SEVERITY_RANK[advisory.severity] > SEVERITY_RANK[best] ? advisory.severity : best),
    "unknown",
  );
  const cvssScore = group.reduce<number | undefined>((best, advisory) => {
    if (advisory.cvssScore === undefined) return best;
    if (best === undefined) return advisory.cvssScore;
    return Math.max(best, advisory.cvssScore);
  }, undefined);
  const publishedAt = group.map((advisory) => advisory.publishedAt).sort()[0];
  const modifiedAt = group
    .map((advisory) => advisory.modifiedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const references = [...new Set(group.flatMap((advisory) => advisory.references))];
  const functions = [...new Set(group.flatMap((advisory) => advisory.vulnerableFunctions ?? []))];
  const precise = group.filter((advisory) =>
    advisory.sources.some((source) => source === "github" || source === "osv" || source === "social"),
  );
  const preciseAffected = precise.flatMap((advisory) => advisory.affected);
  const affected = dedupeAffected(preciseAffected.length ? preciseAffected : group.flatMap((item) => item.affected));
  return {
    id,
    aliases,
    sources,
    summary,
    details,
    severity,
    cvssScore,
    publishedAt,
    modifiedAt,
    references,
    affected,
    withdrawn: group.every((advisory) => advisory.withdrawn),
    vulnerableFunctions: functions.length ? functions : undefined,
  };
}

function preferId(ids: string[]): string {
  const rank = (id: string) => {
    const upper = id.toUpperCase();
    if (upper.startsWith("GHSA-")) return 0;
    if (upper.startsWith("CVE-")) return 1;
    if (upper.startsWith("PYSEC-")) return 2;
    if (upper.startsWith("RUSTSEC-")) return 3;
    if (upper.startsWith("GO-")) return 4;
    return 5;
  };
  return [...ids].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))[0];
}

function dedupeAffected(items: AffectedPackage[]): AffectedPackage[] {
  const grouped = new Map<string, AffectedPackage>();
  for (const item of items) {
    const key = `${item.ecosystem}:${normalizeName(item.ecosystem, item.name)}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        ecosystem: item.ecosystem,
        name: item.name,
        ranges: [...item.ranges],
        versions: item.versions ? [...item.versions] : undefined,
      });
      continue;
    }
    current.ranges.push(...item.ranges);
    if (item.versions?.length) current.versions = [...(current.versions ?? []), ...item.versions];
  }
  return [...grouped.values()];
}
