import semver from "semver";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Dependency, Ecosystem } from "./types";
import { normalizeName } from "./versions";

export const MANIFEST_NAMES = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Cargo.lock",
] as const;

const EDITABLE = new Set([
  "package.json",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
]);

export function parseManifestSet(
  files: Record<string, string>,
  warnings: string[],
): Dependency[] {
  const cargoName = readCargoPackageName(files["Cargo.toml"]);
  const parsed: Dependency[] = [];
  for (const [path, content] of Object.entries(files)) {
    const base = path.split("/").pop() ?? path;
    try {
      parsed.push(...parseManifest(base, path, content, cargoName));
    } catch (error) {
      warnings.push(
        `Could not parse ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  return mergeDependencies(parsed);
}

export function parseManifest(
  base: string,
  path: string,
  content: string,
  cargoPackageName?: string,
): Dependency[] {
  switch (base) {
    case "package.json":
      return parsePackageJson(content, path);
    case "package-lock.json":
      return parsePackageLock(content, path);
    case "yarn.lock":
      return parseYarnLock(content, path);
    case "pnpm-lock.yaml":
      return parsePnpmLock(content, path);
    case "requirements.txt":
      return parseRequirements(content, path, false);
    case "requirements-dev.txt":
      return parseRequirements(content, path, true);
    case "pyproject.toml":
      return parsePyproject(content, path);
    case "go.mod":
      return parseGoMod(content, path);
    case "Cargo.toml":
      return parseCargoToml(content, path);
    case "Cargo.lock":
      return parseCargoLock(content, path, cargoPackageName);
    default:
      return [];
  }
}

function dep(partial: Omit<Dependency, "ecosystem"> & { ecosystem: Ecosystem }): Dependency {
  return partial;
}

export function parsePackageJson(content: string, manifestPath = "package.json"): Dependency[] {
  const json = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const rows: Dependency[] = [];
  const push = (table: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, requested] of Object.entries(table ?? {})) {
      if (typeof requested !== "string" || isLocalSpec(requested)) continue;
      rows.push(
        dep({
          ecosystem: "npm",
          name,
          requested,
          version: exactSemver(requested),
          direct: true,
          dev,
          manifestPath,
        }),
      );
    }
  };
  push(json.dependencies, false);
  push(json.optionalDependencies, false);
  push(json.devDependencies, true);
  return rows;
}

export function parsePackageLock(content: string, manifestPath = "package-lock.json"): Dependency[] {
  const json = JSON.parse(content) as {
    packages?: Record<
      string,
      { name?: string; version?: string; dev?: boolean; link?: boolean }
    >;
  };
  const packages = json.packages ?? {};
  const root = packages[""] ?? {};
  const rootDeps = new Set([
    ...Object.keys((root as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...Object.keys((root as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    ...Object.keys(
      (root as { optionalDependencies?: Record<string, string> }).optionalDependencies ?? {},
    ),
  ]);
  const rootDev = new Set(
    Object.keys((root as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  );
  const rows: Dependency[] = [];
  for (const [packagePath, meta] of Object.entries(packages)) {
    if (!packagePath || meta.link || !meta.version) continue;
    const name = meta.name ?? nameFromNodeModules(packagePath);
    if (!name) continue;
    const topLevel = isTopLevelNodeModule(packagePath);
    const direct = topLevel && rootDeps.has(name);
    const dev = meta.dev === true || (direct && rootDev.has(name) && !rootHasProd(root, name));
    rows.push(
      dep({
        ecosystem: "npm",
        name,
        version: meta.version,
        direct,
        dev,
        manifestPath,
      }),
    );
  }
  return rows;
}

function rootHasProd(root: object, name: string): boolean {
  const dependencies = (root as { dependencies?: Record<string, string> }).dependencies ?? {};
  const optional =
    (root as { optionalDependencies?: Record<string, string> }).optionalDependencies ?? {};
  return name in dependencies || name in optional;
}

export function parseYarnLock(content: string, manifestPath = "yarn.lock"): Dependency[] {
  const rows: Dependency[] = [];
  const blocks = content.split(/\n{2,}/);
  for (const block of blocks) {
    const header = block.split("\n").find((line) => line && !line.startsWith(" ") && !line.startsWith("#"));
    const versionLine = block.match(/^\s+version\s+"([^"]+)"/m);
    if (!header || !versionLine || header.startsWith("#")) continue;
    const descriptors = header.replace(/:$/, "").split(",").map((part) => part.trim());
    for (const descriptor of descriptors) {
      const name = yarnDescriptorName(descriptor);
      if (!name) continue;
      rows.push(
        dep({
          ecosystem: "npm",
          name,
          version: versionLine[1],
          requested: descriptor.includes("@") ? descriptor.slice(descriptor.lastIndexOf("@") + 1) : undefined,
          direct: false,
          dev: false,
          manifestPath,
        }),
      );
    }
  }
  return rows;
}

export function parsePnpmLock(content: string, manifestPath = "pnpm-lock.yaml"): Dependency[] {
  const doc = parseYaml(content) as {
    lockfileVersion?: string | number;
    dependencies?: Record<string, { specifier?: string; version?: string }>;
    devDependencies?: Record<string, { specifier?: string; version?: string }>;
    importers?: Record<
      string,
      {
        dependencies?: Record<string, { specifier?: string; version?: string }>;
        devDependencies?: Record<string, { specifier?: string; version?: string }>;
      }
    >;
    packages?: Record<string, unknown>;
  };
  const rows: Dependency[] = [];
  const seen = new Set<string>();
  const add = (
    name: string,
    info: { specifier?: string; version?: string } | undefined,
    dev: boolean,
    direct: boolean,
  ) => {
    if (!info) return;
    const version = stripPnpmPeer(info.version);
    const key = `${name}@${version ?? ""}:${direct}:${dev}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(
      dep({
        ecosystem: "npm",
        name,
        version,
        requested: info.specifier,
        direct,
        dev,
        manifestPath,
      }),
    );
  };

  const importers = doc.importers ?? { ".": { dependencies: doc.dependencies, devDependencies: doc.devDependencies } };
  for (const importer of Object.values(importers)) {
    for (const [name, info] of Object.entries(importer.dependencies ?? {})) add(name, info, false, true);
    for (const [name, info] of Object.entries(importer.devDependencies ?? {})) add(name, info, true, true);
  }
  for (const key of Object.keys(doc.packages ?? {})) {
    const parsed = pnpmPackageKey(key);
    if (!parsed) continue;
    add(parsed.name, { version: parsed.version }, false, false);
  }
  return rows;
}

export function parseRequirements(
  content: string,
  manifestPath = "requirements.txt",
  dev = false,
): Dependency[] {
  const rows: Dependency[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.split(";")[0]?.trim() ?? "";
    if (!line || line.startsWith("-")) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(.*)$/);
    if (!match) continue;
    const [, name, spec] = match;
    const requested = spec.trim() || undefined;
    const exact = requested?.match(/^(?:==|===)\s*([^\s,]+)$/);
    rows.push(
      dep({
        ecosystem: "pypi",
        name,
        requested,
        version: exact?.[1],
        direct: true,
        dev,
        manifestPath,
      }),
    );
  }
  return rows;
}

export function parsePyproject(content: string, manifestPath = "pyproject.toml"): Dependency[] {
  const doc = parseToml(content) as {
    project?: {
      dependencies?: string[];
      "optional-dependencies"?: Record<string, string[]>;
    };
    tool?: {
      poetry?: {
        dependencies?: Record<string, string | { version?: string }>;
        "dev-dependencies"?: Record<string, string | { version?: string }>;
        group?: Record<string, { dependencies?: Record<string, string | { version?: string }> }>;
      };
    };
  };
  const rows: Dependency[] = [];
  for (const entry of doc.project?.dependencies ?? []) {
    const parsed = parseRequirements(entry, manifestPath, false);
    rows.push(...parsed);
  }
  for (const [extra, entries] of Object.entries(doc.project?.["optional-dependencies"] ?? {})) {
    const dev = /^(dev|test|tests|testing)$/i.test(extra);
    for (const entry of entries) rows.push(...parseRequirements(entry, manifestPath, dev));
  }
  const poetry = doc.tool?.poetry;
  if (poetry?.dependencies) rows.push(...poetryTable(poetry.dependencies, false, manifestPath));
  if (poetry?.["dev-dependencies"]) {
    rows.push(...poetryTable(poetry["dev-dependencies"], true, manifestPath));
  }
  for (const [group, body] of Object.entries(poetry?.group ?? {})) {
    const dev = group !== "main";
    if (body.dependencies) rows.push(...poetryTable(body.dependencies, dev, manifestPath));
  }
  return rows.filter((row) => row.name.toLowerCase() !== "python");
}

export function parseGoMod(content: string, manifestPath = "go.mod"): Dependency[] {
  const rows: Dependency[] = [];
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const comment = raw.includes("// indirect");
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("require (")) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(\S+)$/);
    const block = inBlock ? line.match(/^(\S+)\s+(\S+)$/) : null;
    const match = single ?? block;
    if (!match) continue;
    rows.push(
      dep({
        ecosystem: "go",
        name: match[1],
        version: match[2],
        direct: !comment,
        dev: false,
        manifestPath,
      }),
    );
  }
  return rows;
}

export function parseCargoToml(content: string, manifestPath = "Cargo.toml"): Dependency[] {
  const doc = parseToml(content) as Record<string, unknown>;
  const rows: Dependency[] = [];
  const read = (table: unknown, dev: boolean) => {
    if (!table || typeof table !== "object") return;
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
      const requested = cargoRequested(value);
      if (!requested) continue;
      rows.push(
        dep({
          ecosystem: "crates",
          name,
          requested,
          version: exactSemver(requested),
          direct: true,
          dev,
          manifestPath,
        }),
      );
    }
  };
  read(doc.dependencies, false);
  read(doc["dev-dependencies"], true);
  read(doc["build-dependencies"], true);
  return rows;
}

export function parseCargoLock(
  content: string,
  manifestPath = "Cargo.lock",
  rootName?: string,
): Dependency[] {
  const doc = parseToml(content) as {
    package?: Array<{ name?: string; version?: string }>;
  };
  return (doc.package ?? [])
    .filter((pkg) => pkg.name && pkg.version && pkg.name !== rootName)
    .map((pkg) =>
      dep({
        ecosystem: "crates",
        name: pkg.name!,
        version: pkg.version,
        direct: false,
        dev: false,
        manifestPath,
      }),
    );
}

export function mergeDependencies(rows: Dependency[]): Dependency[] {
  const groups = new Map<string, Dependency[]>();
  for (const row of rows) {
    const key = `${row.ecosystem}:${normalizeName(row.ecosystem, row.name)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const merged: Dependency[] = [];
  for (const group of groups.values()) {
    const manifest = group.find((row) => row.direct && EDITABLE.has(basename(row.manifestPath)));
    const versions = [...new Set(group.map((row) => row.version).filter((version): version is string => Boolean(version)))];
    if (versions.length === 0) {
      merged.push(finishMerge(group, manifest, group[0]));
      continue;
    }
    for (const version of versions) {
      const records = group.filter((row) => row.version === version);
      const directRecord = records.find((row) => row.direct);
      const onlyVersion = versions.length === 1;
      const base = directRecord ?? records[0];
      merged.push(
        finishMerge(group, manifest, {
          ...base,
          version,
          direct: Boolean(directRecord) || (onlyVersion && Boolean(manifest)),
        }),
      );
    }
  }
  return merged.sort((left, right) => left.name.localeCompare(right.name));
}

function finishMerge(group: Dependency[], manifest: Dependency | undefined, base: Dependency): Dependency {
  const direct = base.direct;
  const dev = direct
    ? !group.some((row) => row.direct && !row.dev)
    : group.some((row) => row.dev && row.version === base.version);
  const requested = manifest?.requested ?? group.find((row) => row.requested)?.requested;
  const manifestPath = manifest?.manifestPath ?? base.manifestPath;
  return {
    ecosystem: base.ecosystem,
    name: manifest?.name ?? base.name,
    version: base.version,
    requested,
    direct,
    dev,
    manifestPath,
  };
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function isLocalSpec(spec: string): boolean {
  return /^(file:|link:|workspace:|git\+|github:|http:|https:)/.test(spec.trim());
}

function exactSemver(spec: string): string | undefined {
  const bare = spec.trim().replace(/^=/, "").replace(/^v/, "");
  return semver.valid(bare) ? bare : undefined;
}

function nameFromNodeModules(packagePath: string): string | null {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index === -1) return null;
  return packagePath.slice(index + marker.length);
}

function isTopLevelNodeModule(packagePath: string): boolean {
  return /^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)$/.test(packagePath);
}

function yarnDescriptorName(descriptor: string): string | null {
  const trimmed = descriptor.replace(/^"|"$/g, "");
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash === -1) return null;
    const at = trimmed.indexOf("@", slash);
    return at === -1 ? trimmed : trimmed.slice(0, at);
  }
  const at = trimmed.lastIndexOf("@");
  return at <= 0 ? trimmed : trimmed.slice(0, at);
}

function stripPnpmPeer(version: string | undefined): string | undefined {
  if (!version) return undefined;
  return version.split("(")[0];
}

function pnpmPackageKey(key: string): { name: string; version: string } | null {
  const trimmed = key.replace(/^\//, "");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: trimmed.slice(0, at), version: stripPnpmPeer(trimmed.slice(at + 1)) ?? "" };
}

function poetryTable(
  table: Record<string, string | { version?: string }>,
  dev: boolean,
  manifestPath: string,
): Dependency[] {
  const rows: Dependency[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (name === "python") continue;
    const requested = typeof value === "string" ? value : value.version;
    if (!requested) continue;
    rows.push(
      dep({
        ecosystem: "pypi",
        name,
        requested,
        version: exactPepPin(requested),
        direct: true,
        dev,
        manifestPath,
      }),
    );
  }
  return rows;
}

function exactPepPin(spec: string): string | undefined {
  const match = spec.trim().match(/^(?:==|===)?\s*(\d+[^\s,]*)$/);
  return match?.[1];
}

function cargoRequested(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "version" in value) {
    const version = (value as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  }
  return undefined;
}

function readCargoPackageName(content: string | undefined): string | undefined {
  if (!content) return undefined;
  try {
    const doc = parseToml(content) as { package?: { name?: string } };
    return doc.package?.name;
  } catch {
    return undefined;
  }
}
