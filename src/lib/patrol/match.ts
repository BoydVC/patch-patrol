import { buildFix } from "./fix";
import { scoreMatch } from "./score";
import type { Advisory, LoadedRepo, Match } from "./types";
import {
  describeRange,
  namesEqual,
  requestedOverlaps,
  versionMatchesAffected,
} from "./versions";

export function matchRepos(
  advisories: Advisory[],
  repos: LoadedRepo[],
): { matches: Match[]; warnings: Array<{ repo: string; message: string }> } {
  const matches: Match[] = [];
  const warnings: Array<{ repo: string; message: string }> = [];
  for (const repo of repos) {
    for (const dependency of repo.dependencies) {
      for (const advisory of advisories) {
        if (advisory.withdrawn) continue;
        const affected = advisory.affected.find(
          (item) =>
            item.ecosystem === dependency.ecosystem &&
            namesEqual(item.ecosystem, item.name, dependency.name),
        );
        if (!affected) continue;
        const hit = versionMatchesAffected(
          dependency.ecosystem,
          dependency.version,
          affected.ranges,
          affected.versions,
        );
        if (dependency.version) {
          if (!hit.match) continue;
        } else {
          const overlap = requestedOverlaps(dependency.ecosystem, dependency.requested, affected.ranges);
          if (overlap === null) {
            warnings.push({
              repo: repo.repo,
              message: `Could not compare the requested range for ${dependency.name}${dependency.requested ? ` (${dependency.requested})` : ""}.`,
            });
            continue;
          }
          if (!overlap) continue;
        }
        const score = scoreMatch(advisory, dependency, Boolean(dependency.version));
        const range = hit.range ?? affected.ranges.find((item) => item.fixed || item.lastAffected || item.introduced);
        const explanation = dependency.version
          ? hit.explicit
            ? `${dependency.version} is listed as an affected version.`
            : range
              ? `${dependency.version} falls inside ${describeRange(range)}.`
              : `${dependency.version} matches ${advisory.id}.`
          : `${dependency.requested ?? "the requested range"} overlaps a vulnerable range.`;
        const fix = buildFix({
          advisory,
          dependency,
          repo: repo.repo,
          files: repo.fileContents,
          range: hit.range,
        });
        matches.push({
          id: `${repo.repo}::${dependency.ecosystem}::${dependency.name}::${advisory.id}`,
          advisoryId: advisory.id,
          repo: repo.repo,
          dependency,
          score,
          fix,
          explanation,
        });
      }
    }
  }
  matches.sort((left, right) => right.score.score - left.score.score || left.repo.localeCompare(right.repo));
  return { matches, warnings };
}
