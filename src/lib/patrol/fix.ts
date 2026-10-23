import { unifiedDiff } from "./diff";
import {
  editCargoToml,
  editGoMod,
  editPackageJson,
  editPyproject,
  editRequirements,
} from "./edits";
import type { Advisory, Dependency, FileEdit, FixPlan } from "./types";
import { compareVersions, describeRange, namesEqual } from "./versions";
import type { VersionRange } from "./types";

export function buildFix(input: {
  advisory: Advisory;
  dependency: Dependency;
  repo: string;
  files: Record<string, string>;
  range?: VersionRange;
}): FixPlan {
  const affected = input.advisory.affected.find(
    (item) => item.ecosystem === input.dependency.ecosystem && namesEqual(item.ecosystem, item.name, input.dependency.name),
  );
  const targetVersion = pickTarget(input.dependency, affected?.ranges ?? [], input.range);
  const commands = commandsFor(input.dependency, targetVersion);
  const edits = targetVersion ? editsFor(input.dependency, targetVersion, input.files) : [];
  const action = targetVersion ? "upgrade" : input.advisory.summary.toLowerCase().includes("malicious") ? "remove" : "review";
  const current = input.dependency.version ?? input.dependency.requested ?? "unknown";
  const summary = targetVersion
    ? `Upgrade ${input.dependency.name} from ${current} to ${targetVersion}.`
    : `No patched release is listed for ${input.dependency.name}. Review ${input.advisory.id} before shipping.`;
  const prTitle = targetVersion
    ? `fix(deps): bump ${input.dependency.name} to ${targetVersion}`
    : `chore(deps): review ${input.dependency.name} (${input.advisory.id})`;
  const prBody = renderPrBody({
    repo: input.repo,
    advisory: input.advisory,
    dependency: input.dependency,
    targetVersion,
    summary,
    commands,
  });
  return { action, summary, targetVersion, edits, commands, prTitle, prBody };
}

export function pickTarget(
  dependency: Dependency,
  ranges: VersionRange[],
  matched?: VersionRange,
): string | undefined {
  const ordered = matched ? [matched, ...ranges] : ranges;
  for (const range of ordered) {
    if (!range.fixed) continue;
    if (!dependency.version) return displayVersion(dependency, range.fixed);
    const order = compareVersions(dependency.ecosystem, dependency.version, range.fixed);
    if (order === null || order < 0) return displayVersion(dependency, range.fixed);
  }
  return undefined;
}

function displayVersion(dependency: Dependency, version: string): string {
  if (dependency.ecosystem === "go" && !version.startsWith("v") && /^[0-9]/.test(version)) {
    return `v${version}`;
  }
  return version.replace(/^v(?=\d)/, dependency.ecosystem === "go" ? "v" : "");
}

function editsFor(dependency: Dependency, target: string, files: Record<string, string>): FileEdit[] {
  const edits: FileEdit[] = [];
  const push = (path: string, after: string) => {
    const before = files[path];
    if (before === undefined || before === after) return;
    edits.push({ path, diff: unifiedDiff(path, before, after) });
  };
  if (dependency.ecosystem === "npm") {
    const path = Object.keys(files).find((file) => file.endsWith("package.json"));
    if (path) push(path, editPackageJson(files[path], dependency.name, target, dependency.direct ? "direct" : "override"));
  }
  if (dependency.ecosystem === "pypi") {
    for (const path of Object.keys(files)) {
      if (path.endsWith("requirements.txt") || path.endsWith("requirements-dev.txt")) {
        push(path, editRequirements(files[path], dependency.name, target));
      } else if (path.endsWith("pyproject.toml")) {
        push(path, editPyproject(files[path], dependency.name, target));
      }
    }
  }
  if (dependency.ecosystem === "go") {
    const path = Object.keys(files).find((file) => file.endsWith("go.mod"));
    if (path) push(path, editGoMod(files[path], dependency.name, target));
  }
  if (dependency.ecosystem === "crates") {
    const path = Object.keys(files).find((file) => file.endsWith("Cargo.toml"));
    if (path) push(path, editCargoToml(files[path], dependency.name, target));
  }
  return edits;
}

function commandsFor(dependency: Dependency, target: string | undefined): string[] {
  if (!target) return [`Review ${dependency.name} and remove it if you cannot confirm a safe release.`];
  if (dependency.ecosystem === "npm" && dependency.direct) {
    return [`npm install ${dependency.name}@${target.replace(/^v/, "")}`];
  }
  if (dependency.ecosystem === "npm") {
    return ["npm install"];
  }
  if (dependency.ecosystem === "pypi") {
    return [`pip install "${dependency.name}==${target.replace(/^v/, "")}"`];
  }
  if (dependency.ecosystem === "go") {
    const version = target.startsWith("v") ? target : `v${target}`;
    return [`go get ${dependency.name}@${version}`];
  }
  return [`cargo update -p ${dependency.name} --precise ${target.replace(/^v/, "")}`];
}

function renderPrBody(input: {
  repo: string;
  advisory: Advisory;
  dependency: Dependency;
  targetVersion?: string;
  summary: string;
  commands: string[];
}): string {
  const current = input.dependency.version ?? input.dependency.requested ?? "unresolved";
  const lines = [
    "## Patch Patrol fix plan",
    "",
    input.summary,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Repo | ${input.repo} |`,
    `| Advisory | ${input.advisory.id} |`,
    `| Severity | ${input.advisory.severity} |`,
    `| CVSS | ${input.advisory.cvssScore ?? "n/a"} |`,
    `| Package | ${input.dependency.name} |`,
    `| Current | ${current} |`,
    `| Target | ${input.targetVersion ?? "review"} |`,
    "",
    input.dependency.direct
      ? input.dependency.dev
        ? "Direct development dependency."
        : "Direct production dependency."
      : "Transitive dependency.",
    "",
    "Patch Patrol does not merge pull requests. This pull request is opened as a draft so a person can review the manifest edit and refresh any lockfile.",
    "",
    "### Commands",
    "",
    ...input.commands.map((command) => `- \`${command}\``),
  ];
  if (input.advisory.references.length) {
    lines.push("", "### References", "", ...input.advisory.references.slice(0, 6).map((url) => `- ${url}`));
  }
  if (input.dependency.version && input.advisory.affected[0]) {
    const range = input.advisory.affected[0].ranges[0];
    if (range) lines.push("", `Matched range: \`${describeRange(range)}\`.`);
  }
  return lines.join("\n");
}
