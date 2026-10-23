import fs from "node:fs";
import path from "node:path";
import { requestJson, type FetchLike } from "./http";
import { MANIFEST_NAMES, parseManifestSet } from "./manifests";
import type { LoadedRepo } from "./types";

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assertOwnerRepo(repo: string): { owner: string; name: string } {
  if (!OWNER_REPO.test(repo)) {
    throw new Error(`Expected a GitHub repo as owner/name, received "${repo}".`);
  }
  const [owner, name] = repo.split("/");
  return { owner, name };
}

export function assertInsideProject(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error("Repo path escapes the project directory.");
  }
  return resolved;
}

export function loadLocalRepo(repo: string, directory: string): LoadedRepo {
  const absolute = path.resolve(directory);
  const fileContents: Record<string, string> = {};
  const warnings: string[] = [];
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    return {
      repo,
      source: "local",
      files: [],
      dependencies: [],
      warnings: [`${absolute} is not a directory.`],
      fileContents,
    };
  }
  for (const name of MANIFEST_NAMES) {
    const full = path.join(absolute, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    fileContents[name] = fs.readFileSync(full, "utf8");
  }
  if (Object.keys(fileContents).length === 0) {
    warnings.push("No supported manifest at the repository root.");
  }
  return {
    repo,
    source: "local",
    files: Object.keys(fileContents),
    dependencies: parseManifestSet(fileContents, warnings),
    warnings,
    fileContents,
  };
}

export async function loadGitHubRepo(
  repo: string,
  options: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<LoadedRepo> {
  const { owner, name } = assertOwnerRepo(repo);
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const warnings: string[] = [];
  const fileContents: Record<string, string> = {};
  const listing = await requestJson<Array<{ name?: string; type?: string }> | { message?: string }>(
    `https://api.github.com/repos/${owner}/${name}/contents/`,
    { fetchImpl: options.fetchImpl, headers },
  );
  if (listing.status === 404) {
    return emptyGitHub(repo, ["GitHub could not find this repository or its root listing."]);
  }
  if (listing.status >= 400) {
    return emptyGitHub(repo, [`GitHub returned ${listing.status} while listing ${repo}.`]);
  }
  if (!Array.isArray(listing.json)) {
    return emptyGitHub(repo, ["GitHub did not return a directory listing for the repository root."]);
  }
  const wanted = listing.json.filter(
    (entry) => entry.type === "file" && entry.name && (MANIFEST_NAMES as readonly string[]).includes(entry.name),
  );
  for (const entry of wanted) {
    const file = await requestJson<{ content?: string; encoding?: string }>(
      `https://api.github.com/repos/${owner}/${name}/contents/${entry.name}`,
      { fetchImpl: options.fetchImpl, headers },
    );
    if (file.status >= 400 || !file.json.content) {
      warnings.push(`Could not read ${entry.name} (${file.status}).`);
      continue;
    }
    fileContents[entry.name!] = Buffer.from(file.json.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  if (Object.keys(fileContents).length === 0) {
    warnings.push("No supported manifest at the repository root.");
  }
  return {
    repo,
    source: "github",
    files: Object.keys(fileContents),
    dependencies: parseManifestSet(fileContents, warnings),
    warnings,
    fileContents,
  };
}

function emptyGitHub(repo: string, warnings: string[]): LoadedRepo {
  return { repo, source: "github", files: [], dependencies: [], warnings, fileContents: {} };
}
