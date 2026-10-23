import { unifiedDiff } from "./diff";
import { runDemoScan } from "./demo";
import {
  editCargoToml,
  editGoMod,
  editPackageJson,
  editPyproject,
  editRequirements,
} from "./edits";
import { branchNameFor, openFixPullRequest, type PrFileChange, type PrResult } from "./pr";
import { demoRepoDir } from "./demo";
import { assertOwnerRepo, loadGitHubRepo, loadLocalRepo } from "./repos";
import type { Ecosystem, PrMode } from "./types";

export async function planDemoFix(input: {
  matchId: string;
  mode: PrMode;
  windowHours?: number;
  root?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<PrResult> {
  const scan = await runDemoScan({ windowHours: input.windowHours, root: input.root });
  const match = scan.matches.find((item) => item.id === input.matchId);
  if (!match) throw new Error(`No demo match with id ${input.matchId}.`);
  const directory = demoRepoDir(match.repo, input.root);
  if (!directory) throw new Error(`${match.repo} is not a demo fixture.`);
  const loaded = loadLocalRepo(match.repo, directory);
  const changes = applyEdits(loaded.fileContents, match.dependency.ecosystem, match.dependency.name, match.fix.targetVersion, match.dependency.direct);
  if (input.mode === "draft") {
    return {
      mode: "dry-run",
      dryRun: true,
      merged: false,
      draft: true,
      opened: false,
      title: match.fix.prTitle,
      body: match.fix.prBody,
      branchName: branchNameFor(match.dependency.name, match.fix.targetVersion),
      message:
        "Northwind repos are local fixtures. Patch Patrol did not call GitHub. Point a live scan at owner/name to open a draft.",
      changes: changes.map((change) => ({ path: change.path, diff: change.diff })),
      requests: [],
    };
  }
  const { owner, name } = splitDisplayRepo(match.repo);
  return openFixPullRequest(
    {
      mode: "dry-run",
      owner,
      repo: name,
      title: match.fix.prTitle,
      body: match.fix.prBody,
      branchName: branchNameFor(match.dependency.name, match.fix.targetVersion),
      commitMessage: match.fix.prTitle,
      changes,
    },
    { token: input.token, fetchImpl: input.fetchImpl },
  );
}

export async function planLiveFix(input: {
  mode: PrMode;
  repo: string;
  ecosystem: Ecosystem;
  name: string;
  targetVersion?: string;
  direct: boolean;
  title: string;
  body: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<PrResult> {
  const { owner, name } = assertOwnerRepo(input.repo);
  const loaded = await loadGitHubRepo(input.repo, { token: input.token, fetchImpl: input.fetchImpl });
  const changes = applyEdits(loaded.fileContents, input.ecosystem, input.name, input.targetVersion, input.direct);
  return openFixPullRequest(
    {
      mode: input.mode,
      owner,
      repo: name,
      title: input.title,
      body: input.body,
      branchName: branchNameFor(input.name, input.targetVersion),
      commitMessage: input.title,
      changes,
    },
    { token: input.token, fetchImpl: input.fetchImpl },
  );
}

export function applyEdits(
  files: Record<string, string>,
  ecosystem: Ecosystem,
  name: string,
  target: string | undefined,
  direct: boolean,
): PrFileChange[] {
  if (!target) return [];
  const changes: PrFileChange[] = [];
  const consider = (filePath: string, after: string) => {
    const before = files[filePath];
    if (before === undefined || before === after) return;
    changes.push({ path: filePath, before, after, diff: unifiedDiff(filePath, before, after) });
  };
  if (ecosystem === "npm") {
    const filePath = Object.keys(files).find((file) => file.endsWith("package.json"));
    if (filePath) consider(filePath, editPackageJson(files[filePath], name, target, direct ? "direct" : "override"));
  }
  if (ecosystem === "pypi") {
    for (const filePath of Object.keys(files)) {
      if (filePath.endsWith("requirements.txt") || filePath.endsWith("requirements-dev.txt")) {
        consider(filePath, editRequirements(files[filePath], name, target));
      } else if (filePath.endsWith("pyproject.toml")) {
        consider(filePath, editPyproject(files[filePath], name, target));
      }
    }
  }
  if (ecosystem === "go") {
    const filePath = Object.keys(files).find((file) => file.endsWith("go.mod"));
    if (filePath) consider(filePath, editGoMod(files[filePath], name, target));
  }
  if (ecosystem === "crates") {
    const filePath = Object.keys(files).find((file) => file.endsWith("Cargo.toml"));
    if (filePath) consider(filePath, editCargoToml(files[filePath], name, target));
  }
  return changes;
}

function splitDisplayRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner || "local", name: name || repo };
}
