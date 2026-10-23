import type { FetchLike } from "./http";
import { matchRepos } from "./match";
import { loadGitHubRepo } from "./repos";
import { mergeAdvisories } from "./sources/merge";
import { fetchGitHubAdvisories } from "./sources/github";
import { fetchNvdAdvisories } from "./sources/nvd";
import { fetchOsvAdvisories } from "./sources/osv";
import { SocialSourceSlot } from "./sources/social";
import { partitionAdvisories } from "./sources/window";
import type {
  Advisory,
  LoadedRepo,
  RepoDependencies,
  ScanMode,
  ScanResult,
  SourceReport,
} from "./types";
import { SOURCE_NAMES } from "./types";

export function clampWindow(hours: number | undefined): number {
  if (!hours || Number.isNaN(hours)) return 48;
  return Math.min(24 * 30, Math.max(1, Math.round(hours)));
}

export function buildScanResult(input: {
  mode: ScanMode;
  clock: "frozen" | "live";
  now: Date;
  windowHours: number;
  reports: SourceReport[];
  advisories: Advisory[];
  repos: LoadedRepo[];
}): ScanResult {
  const since = new Date(input.now.getTime() - input.windowHours * 60 * 60 * 1000);
  const partitioned = partitionAdvisories(input.advisories, since, input.now);
  const merged = mergeAdvisories(partitioned.kept).filter((advisory) => !advisory.withdrawn);
  const { matches, warnings } = matchRepos(merged, input.repos);
  const warningByRepo = new Map<string, string[]>();
  for (const warning of warnings) {
    const list = warningByRepo.get(warning.repo) ?? [];
    list.push(warning.message);
    warningByRepo.set(warning.repo, list);
  }
  const matchedIds = new Set(matches.map((match) => match.advisoryId));
  const repos: RepoDependencies[] = input.repos.map((repo) => ({
    repo: repo.repo,
    source: repo.source,
    files: repo.files,
    dependencies: repo.dependencies,
    warnings: [...repo.warnings, ...(warningByRepo.get(repo.repo) ?? [])],
  }));
  return {
    scannedAt: input.now.toISOString(),
    windowHours: input.windowHours,
    since: since.toISOString(),
    until: input.now.toISOString(),
    mode: input.mode,
    clock: input.clock,
    sources: input.reports,
    advisories: merged,
    repos,
    matches,
    unmatchedAdvisoryIds: merged.filter((advisory) => !matchedIds.has(advisory.id)).map((advisory) => advisory.id),
  };
}

export async function runLiveScan(options: {
  repos: string[];
  windowHours?: number;
  now?: Date;
  token?: string;
  nvdApiKey?: string;
  fetchImpl?: FetchLike;
  social?: SocialSourceSlot;
  maxPerSource?: number;
}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const windowHours = clampWindow(options.windowHours);
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const slot = options.social ?? new SocialSourceSlot();
  const [repos, github, nvd, social] = await Promise.all([
    Promise.all(
      options.repos.map((repo) =>
        loadGitHubRepo(repo, { token: options.token, fetchImpl: options.fetchImpl }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Could not load the repository.";
          return {
            repo,
            source: "github" as const,
            files: [],
            dependencies: [],
            warnings: [message],
            fileContents: {},
          };
        }),
      ),
    ),
    capture("github", () =>
      fetchGitHubAdvisories({
        since,
        until: now,
        token: options.token,
        fetchImpl: options.fetchImpl,
        maxPerSource: options.maxPerSource,
      }),
    ),
    capture("nvd", () =>
      fetchNvdAdvisories({
        since,
        until: now,
        apiKey: options.nvdApiKey,
        fetchImpl: options.fetchImpl,
        maxPerSource: options.maxPerSource,
      }),
    ),
    capture("social", async () => {
      const result = await slot.fetch({ since, until: now });
      const partitioned = partitionAdvisories(result.advisories, since, now);
      return {
        advisories: partitioned.kept,
        skippedWithdrawn: partitioned.skippedWithdrawn,
        skippedWindow: partitioned.skippedWindow,
        note: result.note,
        empty: result.empty || partitioned.kept.length === 0,
      };
    }),
  ]);
  const osv = await capture("osv", () =>
    fetchOsvAdvisories({
      since,
      until: now,
      dependencies: repos.flatMap((repo) => repo.dependencies),
      fetchImpl: options.fetchImpl,
      maxPerSource: options.maxPerSource,
    }),
  );
  const reports = [github, osv, nvd, social].map((item) => item.report);
  const advisories = [github, osv, nvd, social].flatMap((item) => item.advisories);
  return buildScanResult({
    mode: "live",
    clock: "live",
    now,
    windowHours,
    reports,
    advisories,
    repos,
  });
}

async function capture(
  id: "github" | "osv" | "nvd" | "social",
  run: () => Promise<{
    advisories: Advisory[];
    skippedEcosystem?: number;
    skippedWithdrawn?: number;
    skippedWindow?: number;
    note?: string;
    empty?: boolean;
  }>,
): Promise<{ report: SourceReport; advisories: Advisory[] }> {
  try {
    const result = await run();
    const kept = result.advisories.length;
    return {
      advisories: result.advisories,
      report: {
        id,
        name: SOURCE_NAMES[id],
        status: result.empty || kept === 0 ? "empty" : "ok",
        kept,
        skippedWithdrawn: result.skippedWithdrawn ?? 0,
        skippedWindow: result.skippedWindow ?? 0,
        skippedEcosystem: result.skippedEcosystem ?? 0,
        note: result.note,
      },
    };
  } catch (error) {
    return {
      advisories: [],
      report: {
        id,
        name: SOURCE_NAMES[id],
        status: "error",
        kept: 0,
        skippedWithdrawn: 0,
        skippedWindow: 0,
        skippedEcosystem: 0,
        error: error instanceof Error ? error.message : "The source failed.",
      },
    };
  }
}
