import type { Advisory, Dependency, ScoreBreakdown } from "./types";

const SEVERITY_POINTS = {
  critical: 96,
  high: 78,
  medium: 52,
  low: 28,
  unknown: 36,
} as const;

export function scoreMatch(
  advisory: Advisory,
  dependency: Dependency,
  versionResolved: boolean,
): ScoreBreakdown {
  const reasons: string[] = [];
  let severityPoints: number;
  if (advisory.cvssScore !== undefined) {
    severityPoints = Math.round(advisory.cvssScore * 10);
    reasons.push(`CVSS ${advisory.cvssScore.toFixed(1)} maps to ${severityPoints} severity points.`);
  } else {
    severityPoints = SEVERITY_POINTS[advisory.severity];
    reasons.push(`No CVSS score. Severity ${advisory.severity} stands in at ${severityPoints} points.`);
  }

  let reachFactor = 1;
  let reachability: ScoreBreakdown["reachability"] = "likely";
  if (!versionResolved) {
    reachFactor = 0.62;
    reachability = "unknown";
    reasons.push("The manifest gives a range and no lockfile pin, so the installed version may differ.");
  } else if (dependency.direct && !dependency.dev) {
    reachFactor = 1;
    reachability = "likely";
    reasons.push("Direct production dependency.");
  } else if (dependency.direct && dependency.dev) {
    reachFactor = 0.68;
    reachability = "possible";
    reasons.push("Direct development dependency. It is present for builds and tests.");
  } else if (!dependency.direct && !dependency.dev) {
    reachFactor = 0.8;
    reachability = "possible";
    reasons.push("Transitive production dependency. A parent package pulls it in.");
  } else {
    reachFactor = 0.42;
    reachability = "unlikely";
    reasons.push("Transitive development dependency.");
  }

  if (advisory.vulnerableFunctions?.length) {
    reasons.push(
      `Advisory names ${advisory.vulnerableFunctions.join(", ")}. Call sites were not scanned.`,
    );
  } else {
    reasons.push("No vulnerable function is listed. Reachability is inferred from the manifest only.");
  }

  const score = Math.max(1, Math.min(100, Math.round(severityPoints * reachFactor)));
  return { severityPoints, reachFactor, score, reachability, reasons };
}
