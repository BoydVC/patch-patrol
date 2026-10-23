import { requestJson, type FetchLike } from "../http";
import type { Advisory, Ecosystem, Severity } from "../types";
import { parseAdvisoryRange } from "../versions";
import { partitionAdvisories } from "./window";

const ECOSYSTEMS: Record<string, Ecosystem | undefined> = {
  npm: "npm",
  pip: "pypi",
  go: "go",
  rust: "crates",
};

const GITHUB_ECOSYSTEMS = ["npm", "pip", "go", "rust"] as const;

export interface GitHubAdvisory {
  ghsa_id?: string;
  cve_id?: string | null;
  html_url?: string;
  summary?: string;
  description?: string;
  severity?: string;
  cvss?: { score?: number | null };
  published_at?: string;
  updated_at?: string;
  withdrawn_at?: string | null;
  references?: string[];
  vulnerabilities?: Array<{
    package?: { ecosystem?: string; name?: string };
    vulnerable_version_range?: string;
    patched_versions?: string | null;
    vulnerable_functions?: string[] | null;
  }>;
}

export function normalizeGitHubAdvisory(raw: GitHubAdvisory): Advisory | null {
  if (!raw.ghsa_id || !raw.published_at) return null;
  const affected = [];
  const functions = new Set<string>();
  for (const vulnerability of raw.vulnerabilities ?? []) {
    const ecosystem = ECOSYSTEMS[(vulnerability.package?.ecosystem ?? "").toLowerCase()];
    const name = vulnerability.package?.name;
    if (!ecosystem || !name) continue;
    const ranges = parseAdvisoryRange(vulnerability.vulnerable_version_range ?? "");
    const patched = vulnerability.patched_versions?.trim();
    if (patched && ranges.length > 0 && !ranges.some((range) => range.fixed || range.lastAffected)) {
      ranges[ranges.length - 1].fixed = patched.split(/\s+/)[0];
    }
    if (ranges.length === 0 && patched) {
      ranges.push({ fixed: patched.split(/\s+/)[0] });
    }
    affected.push({ ecosystem, name, ranges });
    for (const fn of vulnerability.vulnerable_functions ?? []) functions.add(fn);
  }
  if ((raw.vulnerabilities?.length ?? 0) > 0 && affected.length === 0) {
    return null;
  }
  const aliases = [raw.cve_id].filter((id): id is string => Boolean(id));
  return {
    id: raw.ghsa_id,
    aliases,
    sources: ["github"],
    summary: raw.summary?.trim() || raw.ghsa_id,
    details: raw.description?.trim(),
    severity: mapSeverity(raw.severity),
    cvssScore: typeof raw.cvss?.score === "number" ? raw.cvss.score : undefined,
    publishedAt: raw.published_at,
    modifiedAt: raw.updated_at,
    references: unique([raw.html_url, ...(raw.references ?? [])].filter((item): item is string => Boolean(item))),
    affected,
    withdrawn: Boolean(raw.withdrawn_at),
    vulnerableFunctions: functions.size ? [...functions] : undefined,
  };
}

export async function fetchGitHubAdvisories(input: {
  since: Date;
  until: Date;
  token?: string;
  fetchImpl?: FetchLike;
  maxPerSource?: number;
}): Promise<{
  advisories: Advisory[];
  skippedEcosystem: number;
  skippedWithdrawn: number;
  skippedWindow: number;
  note?: string;
}> {
  const max = input.maxPerSource ?? 40;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  const collected: Advisory[] = [];
  const notes: string[] = [];
  let skippedEcosystem = 0;
  await Promise.all(
    GITHUB_ECOSYSTEMS.map(async (ecosystem) => {
      let url: string | null =
        `https://api.github.com/advisories?per_page=100&sort=published&direction=desc&ecosystem=${ecosystem}`;
      let pages = 0;
      while (url && pages < 3 && collected.length < max) {
        const response = await requestJson<GitHubAdvisory[]>(url, {
          fetchImpl: input.fetchImpl,
          headers,
        });
        if (response.status === 403 || response.status === 429) {
          notes.push(`GitHub rate limited the ${ecosystem} feed (${response.status}).`);
          return;
        }
        if (response.status >= 400) {
          throw new Error(`GitHub advisories returned ${response.status} for ${ecosystem}.`);
        }
        pages += 1;
        let olderThanWindow = false;
        for (const raw of response.json) {
          const published = raw.published_at ? new Date(raw.published_at) : null;
          if (published && published < input.since) {
            olderThanWindow = true;
            continue;
          }
          const advisory = normalizeGitHubAdvisory(raw);
          if (!advisory) {
            skippedEcosystem += 1;
            continue;
          }
          collected.push(advisory);
        }
        if (olderThanWindow) break;
        url = nextLink(response.headers.get("link"));
      }
    }),
  );
  const partitioned = partitionAdvisories(collected, input.since, input.until);
  return {
    advisories: partitioned.kept.slice(0, max),
    skippedEcosystem,
    skippedWithdrawn: partitioned.skippedWithdrawn,
    skippedWindow: partitioned.skippedWindow,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

export function mapSeverity(value: string | undefined): Severity {
  const severity = (value ?? "").toLowerCase();
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "moderate" || severity === "medium") return "medium";
  if (severity === "low") return "low";
  return "unknown";
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
