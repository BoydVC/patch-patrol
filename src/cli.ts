import fs from "node:fs";
import { planDemoFix, planLiveFix } from "./lib/patrol/actions";
import { parseConfig } from "./lib/patrol/config";
import { loadLocalEnv, usableSecret } from "./lib/patrol/env";
import { renderReport } from "./lib/patrol/report";
import { runDemoScan } from "./lib/patrol/demo";
import type { PrResult } from "./lib/patrol/pr";
import { clampWindow, runLiveScan } from "./lib/patrol/scan";
import type { PrMode } from "./lib/patrol/types";

async function main(): Promise<void> {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const draft = args.includes("--draft");
  const windowHours = clampWindow(numberFlag(args, "--window") ?? 48);
  const repos = listFlag(args, "--repo");
  const matchId = stringFlag(args, "--match");
  const packageName = stringFlag(args, "--package");
  const configPath = stringFlag(args, "--config");
  const mode: PrMode = draft ? "draft" : "dry-run";
  const token = usableSecret(process.env.GITHUB_TOKEN);
  const nvdApiKey = usableSecret(process.env.NVD_API_KEY);

  if (draft && !packageName && !matchId) {
    console.error("Pass --package <name> or --match <id> with --draft so one fix is opened, not every match.");
    process.exit(2);
  }

  if (!live) {
    const configured = configPath ? configuredDemo(configPath, windowHours) : undefined;
    const scan = await runDemoScan({
      windowHours: configured?.windowHours ?? windowHours,
      repos: configured?.repos,
      now: configured?.now,
    });
    console.log(renderReport(scan));
    const match = matchId || packageName
      ? scan.matches.find((item) => item.id === matchId) ??
        scan.matches.find((item) => item.dependency.name === packageName)
      : scan.matches[0];
    if ((matchId || packageName) && !match) {
      console.error("No demo match for that package.");
      process.exit(1);
    }
    if (match) {
      const plan = await planDemoFix({
        matchId: match.id,
        mode: "dry-run",
        windowHours: configured?.windowHours ?? windowHours,
      });
      printDryRun(plan);
      if (draft) {
        console.log("Fixture mode ignored --draft. No pull request was opened.");
      }
    } else {
      console.log("");
      console.log("Dry-run result");
      console.log("  dryRun: true");
      console.log("  draft: true");
      console.log("  merged: false");
      console.log("  opened: false");
      console.log("  No match in this window, so no pull request was described.");
    }
    return;
  }

  if (draft && !token) {
    console.error(
      process.env.GITHUB_TOKEN
        ? "GITHUB_TOKEN is still a placeholder from .env.example. Refusing to open a draft pull request."
        : "GITHUB_TOKEN is not set. Refusing to open a draft pull request.",
    );
    process.exit(2);
  }

  if (repos.length === 0) {
    console.error("Pass at least one --repo owner/name for a live scan.");
    process.exit(1);
  }
  const scan = await runLiveScan({
    repos,
    windowHours,
    token,
    nvdApiKey,
  });
  console.log(renderReport(scan));
  if (!draft && !matchId && !packageName) return;
  const chosen = scan.matches.filter((item) => {
    if (matchId) return item.id === matchId;
    if (packageName) return item.dependency.name === packageName;
    return false;
  });
  if (chosen.length === 0) {
    console.error("No live match for that package.");
    process.exit(1);
  }
  for (const match of chosen) {
    const plan = await planLiveFix({
      mode,
      repo: match.repo,
      ecosystem: match.dependency.ecosystem,
      name: match.dependency.name,
      targetVersion: match.fix.targetVersion,
      direct: match.dependency.direct,
      title: match.fix.prTitle,
      body: match.fix.prBody,
      token,
    });
    console.log("");
    console.log(plan.message);
    if (plan.url) console.log(plan.url);
  }
}

function printDryRun(plan: PrResult): void {
  console.log("");
  console.log("Dry-run result");
  console.log("  source: fixtures");
  console.log("  githubToken: not used");
  console.log(`  mode: ${plan.mode}`);
  console.log(`  dryRun: ${plan.dryRun}`);
  console.log(`  draft: ${plan.draft}`);
  console.log(`  merged: ${plan.merged}`);
  console.log(`  opened: ${plan.opened}`);
  console.log("  githubRequestsSent: 0");
  console.log(`  ${plan.message}`);
  console.log(`  ${plan.title}`);
  for (const change of plan.changes) {
    console.log("");
    console.log(change.diff);
  }
}

function configuredDemo(configPath: string, windowHours: number): {
  windowHours: number;
  repos?: Record<string, string>;
  now?: Date;
} {
  const config = parseConfig(fs.readFileSync(configPath, "utf8"));
  const local = config.repos.filter((repo) => repo.path);
  if (local.length !== config.repos.length) {
    throw new Error("This config mixes GitHub remotes. Use --live --repo owner/name for those.");
  }
  return {
    windowHours: config.windowHours ?? windowHours,
    repos: Object.fromEntries(local.map((repo) => [repo.name, repo.path!])),
    now: config.now ? new Date(config.now) : undefined,
  };
}

function stringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numberFlag(args: string[], flag: string): number | undefined {
  const value = stringFlag(args, flag);
  if (!value) return undefined;
  return Number(value);
}

function listFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1]) values.push(args[index + 1]);
  });
  return values;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
