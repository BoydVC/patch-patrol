import { requestJson, requestText, type FetchLike } from "../http";
import type { Advisory, Dependency, Ecosystem, Severity } from "../types";
import type { VersionRange } from "../types";
import { partitionAdvisories } from "./window";

const OSV_ECOSYSTEM: Record<string, Ecosystem> = {
  npm: "npm",
  PyPI: "pypi",
  Go: "go",
  "crates.io": "crates",
};

const INDEX_ECOSYSTEMS = new Set(["npm", "PyPI", "Go", "crates.io"]);
const INDEX_URL = "https://osv-vulnerabilities.storage.googleapis.com/modified_id.csv";
const CHUNK = 256 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;

export interface OsvVuln {
  id?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  withdrawn?: string;
  references?: Array<{ url?: string }>;
  severity?: Array<{ type?: string; score?: string | number }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{
      type?: string;
      events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
    }>;
    versions?: string[];
    database_specific?: { severity?: string };
    ecosystem_specific?: { severity?: string };
  }>;
}

export function normalizeOsv(raw: OsvVuln): Advisory | null {
  if (!raw.id || !raw.published) return null;
  const affected = [];
  for (const item of raw.affected ?? []) {
    const ecosystem = item.package?.ecosystem ? OSV_ECOSYSTEM[item.package.ecosystem] : undefined;
    const name = item.package?.name;
    if (!ecosystem || !name) continue;
    const ranges: VersionRange[] = [];
    for (const range of item.ranges ?? []) {
      if (range.type === "GIT") continue;
      ranges.push(...eventsToRanges(range.events ?? []));
    }
    affected.push({
      ecosystem,
      name,
      ranges,
      versions: item.versions?.filter(Boolean),
    });
  }
  const severity = osvSeverity(raw);
  return {
    id: raw.id,
    aliases: raw.aliases ?? [],
    sources: ["osv"],
    summary: raw.summary?.trim() || firstLine(raw.details) || raw.id,
    details: raw.details?.trim(),
    severity: severity.severity,
    cvssScore: severity.cvssScore,
    publishedAt: raw.published,
    modifiedAt: raw.modified,
    references: (raw.references ?? []).map((item) => item.url).filter((url): url is string => Boolean(url)),
    affected,
    withdrawn: Boolean(raw.withdrawn),
  };
}

export function eventsToRanges(
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>,
): VersionRange[] {
  const ranges: VersionRange[] = [];
  let current: VersionRange | null = null;
  for (const event of events) {
    if (event.introduced !== undefined) {
      if (current) ranges.push(current);
      current = { introduced: event.introduced };
      continue;
    }
    if (!current) continue;
    if (event.fixed !== undefined) {
      current.fixed = event.fixed;
      ranges.push(current);
      current = null;
    } else if (event.last_affected !== undefined) {
      current.lastAffected = event.last_affected;
      ranges.push(current);
      current = null;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

export function selectRecentOsvIds(csvChunk: string, since: Date, limit: number): { ids: string[]; exhausted: boolean } {
  const ids: string[] = [];
  let exhausted = false;
  for (const line of csvChunk.split("\n")) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const when = new Date(line.slice(0, comma));
    if (Number.isNaN(when.getTime())) continue;
    if (when < since) {
      exhausted = true;
      break;
    }
    const qualified = line.slice(comma + 1).trim();
    const slash = qualified.indexOf("/");
    if (slash < 0) continue;
    const ecosystem = qualified.slice(0, slash);
    if (!INDEX_ECOSYSTEMS.has(ecosystem)) continue;
    ids.push(qualified.slice(slash + 1));
    if (ids.length >= limit) break;
  }
  return { ids, exhausted };
}

export async function fetchOsvAdvisories(input: {
  since: Date;
  until: Date;
  dependencies: Dependency[];
  fetchImpl?: FetchLike;
  maxPerSource?: number;
}): Promise<{
  advisories: Advisory[];
  skippedWithdrawn: number;
  skippedWindow: number;
  note?: string;
}> {
  const max = input.maxPerSource ?? 30;
  const notes: string[] = [];
  const ids = new Set<string>();
  try {
    const indexed = await readOsvIndex(input.since, max, input.fetchImpl);
    for (const id of indexed) ids.add(id);
  } catch (error) {
    notes.push(
      `OSV modified index was skipped: ${error instanceof Error ? error.message : "request failed"}.`,
    );
  }
  const packageIds = await queryPackageIds(input.dependencies, input.since, input.fetchImpl);
  for (const id of packageIds) ids.add(id);
  const hydrated: Advisory[] = [];
  const queue = [...ids].slice(0, max);
  for (const id of queue) {
    try {
      const response = await requestJson<OsvVuln>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
        fetchImpl: input.fetchImpl,
      });
      if (response.status >= 400) continue;
      const advisory = normalizeOsv(response.json);
      if (advisory) hydrated.push(advisory);
    } catch {
      notes.push(`Could not load OSV ${id}.`);
    }
  }
  const partitioned = partitionAdvisories(hydrated, input.since, input.until);
  return {
    advisories: partitioned.kept,
    skippedWithdrawn: partitioned.skippedWithdrawn,
    skippedWindow: partitioned.skippedWindow,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

async function readOsvIndex(since: Date, limit: number, fetchImpl?: FetchLike): Promise<string[]> {
  const ids: string[] = [];
  let start = 0;
  let leftover = "";
  while (start < MAX_INDEX_BYTES && ids.length < limit) {
    const end = start + CHUNK - 1;
    const response = await requestText(INDEX_URL, {
      fetchImpl,
      headers: { Range: `bytes=${start}-${end}`, accept: "text/csv" },
    });
    if (response.status !== 206) {
      throw new Error(`index did not honor a range request (${response.status})`);
    }
    const combined = leftover + response.text;
    const lines = combined.split("\n");
    leftover = lines.pop() ?? "";
    const selected = selectRecentOsvIds(lines.join("\n"), since, limit - ids.length);
    ids.push(...selected.ids);
    if (selected.exhausted || response.text.length < CHUNK - 1) break;
    start += CHUNK;
  }
  return ids;
}

async function queryPackageIds(
  dependencies: Dependency[],
  since: Date,
  fetchImpl?: FetchLike,
): Promise<string[]> {
  const queries = dependencies
    .filter((dependency) => dependency.version)
    .slice(0, 100)
    .map((dependency) => ({
      package: { name: dependency.name, ecosystem: toOsvEcosystem(dependency.ecosystem) },
      version: dependency.version,
    }));
  if (queries.length === 0) return [];
  const response = await requestJson<{ results?: Array<{ vulns?: Array<{ id?: string; modified?: string }> }> }>(
    "https://api.osv.dev/v1/querybatch",
    {
      fetchImpl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries }),
    },
  );
  if (response.status >= 400) return [];
  const ids: string[] = [];
  for (const result of response.json.results ?? []) {
    for (const vuln of result.vulns ?? []) {
      if (!vuln.id || !vuln.modified) continue;
      if (new Date(vuln.modified) < since) continue;
      ids.push(vuln.id);
    }
  }
  return ids;
}

function toOsvEcosystem(ecosystem: Ecosystem): string {
  if (ecosystem === "npm") return "npm";
  if (ecosystem === "pypi") return "PyPI";
  if (ecosystem === "go") return "Go";
  return "crates.io";
}

function osvSeverity(raw: OsvVuln): { severity: Severity; cvssScore?: number } {
  let cvssScore: number | undefined;
  for (const entry of raw.severity ?? []) {
    if (typeof entry.score === "number" && entry.score <= 10) cvssScore = entry.score;
    else if (typeof entry.score === "string" && /^\d+(\.\d+)?$/.test(entry.score)) {
      cvssScore = Number(entry.score);
    }
  }
  const label = (
    raw.database_specific?.severity ??
    raw.affected?.find((item) => item.database_specific?.severity)?.database_specific?.severity ??
    raw.affected?.find((item) => item.ecosystem_specific?.severity)?.ecosystem_specific?.severity ??
    ""
  ).toLowerCase();
  const fromLabel = label.includes("critical")
    ? "critical"
    : label.includes("high")
      ? "high"
      : label.includes("moderate") || label.includes("medium")
        ? "medium"
        : label.includes("low")
          ? "low"
          : undefined;
  if (fromLabel) return { severity: fromLabel, cvssScore };
  if (cvssScore === undefined) return { severity: "unknown" };
  if (cvssScore >= 9) return { severity: "critical", cvssScore };
  if (cvssScore >= 7) return { severity: "high", cvssScore };
  if (cvssScore >= 4) return { severity: "medium", cvssScore };
  return { severity: "low", cvssScore };
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split("\n")[0]?.trim();
  return line || undefined;
}
