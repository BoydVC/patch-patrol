export type Ecosystem = "npm" | "pypi" | "go" | "crates";

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

export type SourceId = "github" | "osv" | "nvd" | "social";

export type Reachability = "likely" | "possible" | "unlikely" | "unknown";

export type ScanMode = "demo" | "live";

export type PrMode = "dry-run" | "draft";

/** Inclusive lower bound unless `introducedExclusive` is set. Upper bound is `fixed` (exclusive) or `lastAffected` (inclusive). */
export interface VersionRange {
  introduced?: string;
  introducedExclusive?: boolean;
  fixed?: string;
  lastAffected?: string;
}

export interface AffectedPackage {
  ecosystem: Ecosystem;
  name: string;
  ranges: VersionRange[];
  versions?: string[];
}

export interface Advisory {
  id: string;
  aliases: string[];
  sources: SourceId[];
  summary: string;
  details?: string;
  severity: Severity;
  cvssScore?: number;
  publishedAt: string;
  modifiedAt?: string;
  references: string[];
  affected: AffectedPackage[];
  withdrawn?: boolean;
  vulnerableFunctions?: string[];
}

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  requested?: string;
  direct: boolean;
  dev: boolean;
  manifestPath: string;
}

export interface RepoDependencies {
  repo: string;
  source: "local" | "github";
  files: string[];
  dependencies: Dependency[];
  warnings: string[];
}

export interface ScoreBreakdown {
  severityPoints: number;
  reachFactor: number;
  score: number;
  reachability: Reachability;
  reasons: string[];
}

export interface FileEdit {
  path: string;
  diff: string;
}

export interface FixPlan {
  action: "upgrade" | "remove" | "review";
  summary: string;
  targetVersion?: string;
  edits: FileEdit[];
  commands: string[];
  prTitle: string;
  prBody: string;
}

export interface Match {
  id: string;
  advisoryId: string;
  repo: string;
  dependency: Dependency;
  score: ScoreBreakdown;
  fix: FixPlan;
  explanation: string;
}

export interface SourceReport {
  id: string;
  name: string;
  status: "ok" | "error" | "empty";
  kept: number;
  skippedWithdrawn: number;
  skippedWindow: number;
  skippedEcosystem: number;
  error?: string;
  note?: string;
}

export interface ScanResult {
  scannedAt: string;
  windowHours: number;
  since: string;
  until: string;
  mode: ScanMode;
  clock: "frozen" | "live";
  sources: SourceReport[];
  advisories: Advisory[];
  repos: RepoDependencies[];
  matches: Match[];
  unmatchedAdvisoryIds: string[];
}

export interface LoadedRepo extends RepoDependencies {
  fileContents: Record<string, string>;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

export const SOURCE_NAMES: Record<SourceId, string> = {
  github: "GitHub Advisory Database",
  osv: "OSV",
  nvd: "NVD",
  social: "Social slot",
};
