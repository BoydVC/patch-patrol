import type { ScanResult } from "./types";

export function renderReport(scan: ScanResult): string {
  const lines: string[] = [];
  lines.push(
    `Patch Patrol  ·  ${scan.mode}  ·  window ${scan.windowHours}h  ·  ${scan.since} → ${scan.until}`,
  );
  if (scan.clock === "frozen") {
    lines.push("Clock is frozen so the fixture advisories stay inside the window.");
  }
  lines.push("", "Sources");
  for (const source of scan.sources) {
    const detail = source.error ? `error: ${source.error}` : `${source.kept} kept`;
    const skips = [
      source.skippedWindow ? `${source.skippedWindow} outside window` : "",
      source.skippedWithdrawn ? `${source.skippedWithdrawn} withdrawn` : "",
      source.skippedEcosystem ? `${source.skippedEcosystem} other ecosystems` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${source.name.padEnd(28)} ${detail}${skips ? ` (${skips})` : ""}`);
    if (source.note) lines.push(`    ${source.note}`);
  }
  lines.push("", "Repos");
  for (const repo of scan.repos) {
    const count = scan.matches.filter((match) => match.repo === repo.repo).length;
    const noun = count === 1 ? "match" : "matches";
    lines.push(
      `  ${repo.repo.padEnd(28)} ${String(repo.dependencies.length).padStart(2)} dependencies   ${count} ${noun}`,
    );
    if (repo.warnings.length) lines.push(`    ${repo.warnings.join(" ")}`);
  }
  lines.push("", scan.matches.length ? "Matches" : "Matches", "");
  if (scan.matches.length === 0) {
    lines.push("  No dependency matched an advisory in this window.");
  }
  for (const match of scan.matches) {
    const advisory = scan.advisories.find((item) => item.id === match.advisoryId);
    const version = match.dependency.version ?? match.dependency.requested ?? "unresolved";
    lines.push(
      `  ${String(match.score.score).padStart(3)}  ${(advisory?.severity ?? "unknown").toUpperCase().padEnd(8)} ${match.score.reachability.padEnd(10)} ${match.dependency.name}@${version}`,
    );
    lines.push(`       ${match.repo}  ·  ${match.advisoryId}`);
    lines.push(`       ${match.explanation}`);
    lines.push(`       ${match.fix.summary}`);
    for (const command of match.fix.commands) lines.push(`       $ ${command}`);
  }
  if (scan.unmatchedAdvisoryIds.length) {
    lines.push("", "Unmatched advisories");
    for (const id of scan.unmatchedAdvisoryIds) lines.push(`  ${id}`);
  }
  lines.push("", "Dry run is the default. Patch Patrol never merges pull requests.");
  return lines.join("\n");
}
