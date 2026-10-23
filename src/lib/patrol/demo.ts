import fs from "node:fs";
import path from "node:path";
import { buildScanResult, clampWindow } from "./scan";
import type { GitHubAdvisory } from "./sources/github";
import { normalizeGitHubAdvisory } from "./sources/github";
import type { NvdCve } from "./sources/nvd";
import { normalizeNvdCve } from "./sources/nvd";
import type { OsvVuln } from "./sources/osv";
import { normalizeOsv } from "./sources/osv";
import { fixtureSocialProvider, SocialSourceSlot, postToAdvisory, type SocialPost } from "./sources/social";
import { partitionAdvisories } from "./sources/window";
import { loadLocalRepo } from "./repos";
import type { Advisory, ScanResult, SourceReport } from "./types";
import { SOURCE_NAMES } from "./types";

/** Fixture clock. Advisory dates in fixtures/raw are written against this instant. */
export const DEMO_NOW = new Date("2026-10-23T22:00:00.000Z");

export const DEMO_REPOS: Record<string, string> = {
  "northwind/storefront": "fixtures/repos/northwind-storefront",
  "northwind/catalog": "fixtures/repos/northwind-catalog",
  "northwind/relay": "fixtures/repos/northwind-relay",
  "northwind/edge": "fixtures/repos/northwind-edge",
  "northwind/docs": "fixtures/repos/northwind-docs",
};

export function demoRepoDir(repo: string, root = process.cwd()): string | null {
  const relative = DEMO_REPOS[repo];
  if (!relative) return null;
  return path.join(root, relative);
}

export async function runDemoScan(options?: {
  windowHours?: number;
  root?: string;
  repos?: Record<string, string>;
  now?: Date;
}): Promise<ScanResult> {
  const root = options?.root ?? process.cwd();
  const now = options?.now ?? DEMO_NOW;
  const windowHours = clampWindow(options?.windowHours);
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const githubCollected: Advisory[] = [];
  let githubSkippedEcosystem = 0;
  for (const raw of readJson<GitHubAdvisory[]>(root, "fixtures/raw/github.json")) {
    const advisory = normalizeGitHubAdvisory(raw);
    if (!advisory) {
      githubSkippedEcosystem += 1;
      continue;
    }
    githubCollected.push(advisory);
  }
  const osvCollected = readJson<OsvVuln[]>(root, "fixtures/raw/osv.json")
    .map(normalizeOsv)
    .filter((advisory): advisory is Advisory => Boolean(advisory));
  const nvdCollected: Advisory[] = [];
  let nvdSkippedEcosystem = 0;
  for (const item of readJson<{ vulnerabilities?: Array<{ cve?: NvdCve }> }>(root, "fixtures/raw/nvd.json")
    .vulnerabilities ?? []) {
    if (!item.cve) continue;
    const normalized = normalizeNvdCve(item.cve);
    if (normalized.skippedEcosystem) nvdSkippedEcosystem += 1;
    if (normalized.advisory) nvdCollected.push(normalized.advisory);
  }

  const posts = readJson<SocialPost[]>(root, "fixtures/raw/social.json");
  const slot = new SocialSourceSlot();
  slot.register(fixtureSocialProvider(posts));
  const social = await slot.fetch({ since, until: now });
  const socialPart = partitionAdvisories(
    social.advisories.map((advisory) => ({ ...advisory, sources: ["social"] })),
    since,
    now,
  );

  const githubPart = partitionAdvisories(githubCollected, since, now);
  const osvPart = partitionAdvisories(osvCollected, since, now);
  const nvdPart = partitionAdvisories(nvdCollected, since, now);

  const reports: SourceReport[] = [
    sourceReport("github", githubPart, githubSkippedEcosystem),
    sourceReport("osv", osvPart, 0),
    sourceReport("nvd", nvdPart, nvdSkippedEcosystem),
    {
      id: "social",
      name: SOURCE_NAMES.social,
      status: socialPart.kept.length ? "ok" : "empty",
      kept: socialPart.kept.length,
      skippedWithdrawn: socialPart.skippedWithdrawn,
      skippedWindow: socialPart.skippedWindow,
      skippedEcosystem: 0,
      note: social.note,
    },
  ];

  const repoMap = options?.repos ?? DEMO_REPOS;
  const repos = Object.entries(repoMap).map(([name, relative]) => loadLocalRepo(name, path.join(root, relative)));
  return buildScanResult({
    mode: "demo",
    clock: "frozen",
    now,
    windowHours,
    reports,
    advisories: [...githubPart.kept, ...osvPart.kept, ...nvdPart.kept, ...socialPart.kept],
    repos,
  });
}

function sourceReport(
  id: "github" | "osv" | "nvd",
  part: { kept: Advisory[]; skippedWithdrawn: number; skippedWindow: number },
  skippedEcosystem: number,
): SourceReport {
  return {
    id,
    name: SOURCE_NAMES[id],
    status: part.kept.length ? "ok" : "empty",
    kept: part.kept.length,
    skippedWithdrawn: part.skippedWithdrawn,
    skippedWindow: part.skippedWindow,
    skippedEcosystem,
  };
}

function readJson<T>(root: string, relative: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")) as T;
}

export { postToAdvisory };
