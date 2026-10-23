import { usableSecret } from "./env";
import { requestJson, type FetchLike } from "./http";
import type { PrMode } from "./types";

export interface PrFileChange {
  path: string;
  before: string;
  after: string;
  diff: string;
}

export interface PrRequest {
  mode: PrMode;
  owner: string;
  repo: string;
  title: string;
  body: string;
  branchName: string;
  commitMessage: string;
  changes: PrFileChange[];
}

export interface PrResult {
  mode: PrMode;
  dryRun: boolean;
  /** Patch Patrol has no merge call. This stays false. */
  merged: false;
  draft: true;
  opened: boolean;
  title: string;
  body: string;
  branchName: string;
  baseBranch?: string;
  url?: string;
  message: string;
  changes: Array<{ path: string; diff: string }>;
  requests: Array<{ method: string; path: string }>;
}

const BLOCKED = /\/merge\b|\/merges\b/;

export function assertGitHubPath(method: string, path: string): void {
  if (BLOCKED.test(path)) {
    throw new Error("Patch Patrol never merges pull requests.");
  }
  const allowed =
    (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) ||
    (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(path)) ||
    (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(path)) ||
    (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(path)) ||
    (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path));
  if (!allowed) throw new Error(`Blocked GitHub API call ${method} ${path}`);
}

export function branchNameFor(packageName: string, target: string | undefined): string {
  const slug = `${packageName}-${target ?? "review"}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return `patch-patrol/${slug || "fix"}`;
}

/**
 * Opens a draft pull request, or describes one.
 * Dry-run is the only default. The pulls payload always sets draft: true.
 */
export async function openFixPullRequest(
  request: PrRequest,
  options: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<PrResult> {
  const changes = request.changes.map((change) => ({ path: change.path, diff: change.diff }));
  const base: PrResult = {
    mode: request.mode,
    dryRun: request.mode !== "draft",
    merged: false,
    draft: true,
    opened: false,
    title: request.title,
    body: request.body,
    branchName: request.branchName,
    message: "",
    changes,
    requests: plannedRequests(request),
  };
  if (request.changes.length === 0 || request.changes.every((change) => change.before === change.after)) {
    return {
      ...base,
      dryRun: true,
      message: "The manifest edit is empty, so no pull request was opened.",
    };
  }
  if (request.mode !== "draft") {
    return {
      ...base,
      message: "Dry run. No GitHub request was sent. Patch Patrol never merges.",
    };
  }
  if (!options.token || !options.token.trim()) {
    throw new Error("GITHUB_TOKEN is not set. Refusing to open a draft pull request.");
  }
  if (!usableSecret(options.token)) {
    throw new Error(
      "GITHUB_TOKEN is still a placeholder from .env.example. Refusing to open a draft pull request.",
    );
  }
  const ownerRepo = `${request.owner}/${request.repo}`;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const repoInfo = await github<{ default_branch: string }>(
    "GET",
    `/repos/${ownerRepo}`,
    headers,
    undefined,
    options.fetchImpl,
  );
  const baseBranch = repoInfo.default_branch;
  const ref = await github<{ object: { sha: string } }>(
    "GET",
    `/repos/${ownerRepo}/git/ref/heads/${baseBranch}`,
    headers,
    undefined,
    options.fetchImpl,
  );
  await github(
    "POST",
    `/repos/${ownerRepo}/git/refs`,
    headers,
    { ref: `refs/heads/${request.branchName}`, sha: ref.object.sha },
    options.fetchImpl,
  );
  for (const change of request.changes) {
    const existing = await github<{ sha: string }>(
      "GET",
      `/repos/${ownerRepo}/contents/${change.path}`,
      headers,
      undefined,
      options.fetchImpl,
    );
    await github(
      "PUT",
      `/repos/${ownerRepo}/contents/${change.path}`,
      headers,
      {
        message: request.commitMessage,
        content: Buffer.from(change.after, "utf8").toString("base64"),
        sha: existing.sha,
        branch: request.branchName,
      },
      options.fetchImpl,
    );
  }
  const pull = await github<{ html_url: string; draft: boolean }>(
    "POST",
    `/repos/${ownerRepo}/pulls`,
    headers,
    {
      title: request.title,
      body: request.body,
      head: request.branchName,
      base: baseBranch,
      draft: true,
    },
    options.fetchImpl,
  );
  if (pull.draft !== true) {
    throw new Error("GitHub did not create the pull request as a draft. Patch Patrol will not continue.");
  }
  return {
    ...base,
    dryRun: false,
    opened: true,
    baseBranch,
    url: pull.html_url,
    message: "Opened a draft pull request. Patch Patrol did not merge it.",
  };
}

function plannedRequests(request: PrRequest): Array<{ method: string; path: string }> {
  const ownerRepo = `${request.owner}/${request.repo}`;
  return [
    { method: "GET", path: `/repos/${ownerRepo}` },
    { method: "GET", path: `/repos/${ownerRepo}/git/ref/heads/<default>` },
    { method: "POST", path: `/repos/${ownerRepo}/git/refs` },
    ...request.changes.flatMap((change) => [
      { method: "GET", path: `/repos/${ownerRepo}/contents/${change.path}` },
      { method: "PUT", path: `/repos/${ownerRepo}/contents/${change.path}` },
    ]),
    { method: "POST", path: `/repos/${ownerRepo}/pulls` },
  ];
}

async function github<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl?: FetchLike,
): Promise<T> {
  assertGitHubPath(method, path.split("?")[0]);
  const response = await requestJson<T>(`https://api.github.com${path}`, {
    fetchImpl,
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status >= 400) {
    throw new Error(`GitHub ${method} ${path} returned ${response.status}.`);
  }
  return response.json;
}
