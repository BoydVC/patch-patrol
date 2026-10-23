import { requestJson, type FetchLike } from "../http";
import type { Advisory, Ecosystem, Severity, VersionRange } from "../types";
import { extractAliases } from "./ids";
import { partitionAdvisories } from "./window";

const DENY_PRODUCTS = new Set([
  "linux",
  "linux_kernel",
  "windows",
  "android",
  "iphone_os",
  "mac_os",
  "mac_os_x",
  "kernel",
  "http_server",
]);

const CPE_ALIASES: Record<string, { ecosystem: Ecosystem; name: string }> = {
  "golang:net": { ecosystem: "go", name: "golang.org/x/net" },
  "golang:crypto": { ecosystem: "go", name: "golang.org/x/crypto" },
  "golang:text": { ecosystem: "go", name: "golang.org/x/text" },
  "golang:image": { ecosystem: "go", name: "golang.org/x/image" },
  "golang:sys": { ecosystem: "go", name: "golang.org/x/sys" },
};

interface CpeMatch {
  vulnerable?: boolean;
  criteria?: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
}

export interface NvdCve {
  id?: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang?: string; value?: string }>;
  metrics?: {
    cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>;
    cvssMetricV30?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>;
    cvssMetricV2?: Array<{ cvssData?: { baseScore?: number } }>;
  };
  references?: Array<{ url?: string }>;
  configurations?: Array<{
    nodes?: Array<{ cpeMatch?: CpeMatch[] }>;
  }>;
}

export function normalizeNvdCve(cve: NvdCve): { advisory: Advisory | null; skippedEcosystem: boolean } {
  if (!cve.id || !cve.published) return { advisory: null, skippedEcosystem: false };
  const description =
    cve.descriptions?.find((item) => item.lang === "en")?.value ?? cve.descriptions?.[0]?.value ?? "";
  const references = (cve.references ?? []).map((item) => item.url).filter((url): url is string => Boolean(url));
  const aliases = extractAliases(`${cve.id} ${description} ${references.join(" ")}`).filter((id) => id !== cve.id);
  const affected = cpeAffected(cve);
  if (affected.length === 0 && aliases.length === 0) {
    return { advisory: null, skippedEcosystem: true };
  }
  const cvss = cvssOf(cve);
  return {
    skippedEcosystem: false,
    advisory: {
      id: cve.id,
      aliases,
      sources: ["nvd"],
      summary: description.split(". ")[0]?.trim() || cve.id,
      details: description.trim() || undefined,
      severity: cvss.severity,
      cvssScore: cvss.score,
      publishedAt: cve.published,
      modifiedAt: cve.lastModified,
      references,
      affected,
      withdrawn: cve.vulnStatus === "Rejected",
    },
  };
}

export function cpeAffected(cve: NvdCve): Advisory["affected"] {
  const found = new Map<string, { ecosystem: Ecosystem; name: string; ranges: VersionRange[] }>();
  for (const configuration of cve.configurations ?? []) {
    for (const node of configuration.nodes ?? []) {
      for (const match of node.cpeMatch ?? []) {
        if (match.vulnerable === false || !match.criteria) continue;
        const mapped = mapCpe(match.criteria);
        if (!mapped) continue;
        const key = `${mapped.ecosystem}:${mapped.name}`;
        const current = found.get(key) ?? { ...mapped, ranges: [] };
        current.ranges.push(cpeRange(match));
        found.set(key, current);
      }
    }
  }
  return [...found.values()];
}

export function mapCpe(criteria: string): { ecosystem: Ecosystem; name: string } | null {
  const parts = criteria.split(":");
  if (parts.length < 5 || parts[2] !== "a") return null;
  const vendor = parts[3] ?? "";
  const product = parts[4] ?? "";
  const target = parts[10] ?? "*";
  if (DENY_PRODUCTS.has(product) || DENY_PRODUCTS.has(vendor)) return null;
  const alias = CPE_ALIASES[`${vendor}:${product}`];
  if (alias) return alias;
  if (target !== "node.js" && target !== "nodejs" && target !== "python" && target !== "rust") {
    return null;
  }
  const ecosystem: Ecosystem =
    target === "python" ? "pypi" : target === "rust" ? "crates" : "npm";
  return { ecosystem, name: product.replace(/_/g, "-") };
}

function cpeRange(match: CpeMatch): VersionRange {
  const range: VersionRange = {};
  if (match.versionStartIncluding) range.introduced = match.versionStartIncluding;
  if (match.versionStartExcluding) {
    range.introduced = match.versionStartExcluding;
    range.introducedExclusive = true;
  }
  if (match.versionEndExcluding) range.fixed = match.versionEndExcluding;
  if (match.versionEndIncluding) range.lastAffected = match.versionEndIncluding;
  const version = match.criteria?.split(":")[5];
  if (version && version !== "*" && version !== "-" && !range.introduced && !range.fixed && !range.lastAffected) {
    range.introduced = version;
    range.lastAffected = version;
  }
  return range;
}

export async function fetchNvdAdvisories(input: {
  since: Date;
  until: Date;
  apiKey?: string;
  fetchImpl?: FetchLike;
  maxPerSource?: number;
}): Promise<{
  advisories: Advisory[];
  skippedEcosystem: number;
  skippedWithdrawn: number;
  skippedWindow: number;
}> {
  const max = input.maxPerSource ?? 40;
  const headers: Record<string, string> = {};
  if (input.apiKey) headers.apiKey = input.apiKey;
  const collected: Advisory[] = [];
  let skippedEcosystem = 0;
  let startIndex = 0;
  for (let page = 0; page < 3 && collected.length < max; page += 1) {
    const url = new URL("https://services.nvd.nist.gov/rest/json/cves/2.0");
    url.searchParams.set("pubStartDate", nvdStamp(input.since));
    url.searchParams.set("pubEndDate", nvdStamp(input.until));
    url.searchParams.set("resultsPerPage", "50");
    url.searchParams.set("startIndex", String(startIndex));
    const response = await requestJson<{
      vulnerabilities?: Array<{ cve?: NvdCve }>;
      totalResults?: number;
    }>(url.toString(), { fetchImpl: input.fetchImpl, headers });
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        `NVD rate limited the request (${response.status}). Set NVD_API_KEY or retry in a minute.`,
      );
    }
    if (response.status >= 400) throw new Error(`NVD returned ${response.status}.`);
    const vulnerabilities = response.json.vulnerabilities ?? [];
    for (const item of vulnerabilities) {
      if (!item.cve) continue;
      const normalized = normalizeNvdCve(item.cve);
      if (normalized.skippedEcosystem) {
        skippedEcosystem += 1;
        continue;
      }
      if (normalized.advisory) collected.push(normalized.advisory);
    }
    startIndex += vulnerabilities.length;
    if (vulnerabilities.length < 50 || startIndex >= (response.json.totalResults ?? 0)) break;
  }
  const partitioned = partitionAdvisories(collected, input.since, input.until);
  return {
    advisories: partitioned.kept.slice(0, max),
    skippedEcosystem,
    skippedWithdrawn: partitioned.skippedWithdrawn,
    skippedWindow: partitioned.skippedWindow,
  };
}

export function nvdStamp(date: Date): string {
  return date.toISOString().replace(/Z$/, "");
}

function cvssOf(cve: NvdCve): { severity: Severity; score?: number } {
  const v31 = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
  const v30 = cve.metrics?.cvssMetricV30?.[0]?.cvssData;
  const v2 = cve.metrics?.cvssMetricV2?.[0]?.cvssData;
  const score = v31?.baseScore ?? v30?.baseScore ?? v2?.baseScore;
  const label = (v31?.baseSeverity ?? v30?.baseSeverity ?? "").toLowerCase();
  if (label === "critical" || label === "high" || label === "medium" || label === "low") {
    return { severity: label, score };
  }
  if (score === undefined) return { severity: "unknown" };
  if (score >= 9) return { severity: "critical", score };
  if (score >= 7) return { severity: "high", score };
  if (score >= 4) return { severity: "medium", score };
  return { severity: "low", score };
}
