export function retargetSpecifier(requested: string, target: string): string {
  const version = target.replace(/^v(?=\d)/, "");
  const trimmed = requested.trim();
  if (trimmed.startsWith("^")) return `^${version}`;
  if (trimmed.startsWith("~")) return `~${version}`;
  if (trimmed.startsWith("=")) return `=${version}`;
  if (/^[0-9]/.test(trimmed)) return version;
  return version;
}

export function editPackageJson(
  source: string,
  name: string,
  target: string,
  mode: "direct" | "override",
): string {
  const json = JSON.parse(source) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  if (mode === "direct") {
    const fields = [json.dependencies, json.devDependencies, json.optionalDependencies];
    let next = source;
    let changed = false;
    for (const field of fields) {
      const current = field?.[name];
      if (typeof current !== "string") continue;
      const updated = retargetSpecifier(current, target);
      if (updated === current) continue;
      const replaced = replaceJsonString(next, name, current, updated);
      if (replaced === next) continue;
      next = replaced;
      changed = true;
    }
    if (changed) return ensureTrailingNewline(next);
  }
  return ensureTrailingNewline(insertOverride(source, name, stripV(target)));
}

export function editRequirements(source: string, name: string, target: string): string {
  const lines = source.split(/\r?\n/);
  let changed = false;
  const next = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?\s*([^\s#;]*)(.*)$/);
    if (!match || !namesClose(match[2], name)) return line;
    changed = true;
    const tail = match[5] ?? "";
    return `${match[1]}${match[2]}${match[3] ?? ""}==${stripV(target)}${tail}`;
  });
  return changed ? next.join("\n") : source;
}

export function editPyproject(source: string, name: string, target: string): string {
  const escaped = escapeRegExp(name).replace(/[-_.]/g, "[-_.]");
  const version = stripV(target);
  let next = source.replace(
    new RegExp(`(${escaped}(?:\\[[^\\]]+\\])?)\\s*==\\s*[^\\s,"']+`, "gi"),
    `$1==${version}`,
  );
  next = next.replace(
    new RegExp(`(${escaped}(?:\\[[^\\]]+\\])?)\\s*>=\\s*[^\\s,"']+`, "gi"),
    `$1>=${version}`,
  );
  next = next.replace(
    new RegExp(`(${escaped}\\s*=\\s*["'])\\^?~?=?([^"']*)(["'])`, "gi"),
    `$1${version}$3`,
  );
  return next;
}

export function editGoMod(source: string, moduleName: string, target: string): string {
  const version = target.startsWith("v") ? target : `v${target}`;
  const pattern = new RegExp(`^(.*\\b${escapeRegExp(moduleName)}\\s+)v?[^\\s]+(.*)$`, "gm");
  return source.replace(pattern, `$1${version}$2`);
}

export function editCargoToml(source: string, name: string, target: string): string {
  const version = stripV(target);
  let next = source.replace(
    new RegExp(`^(\\s*${escapeRegExp(name)}\\s*=\\s*")[^"]*(")`, "m"),
    `$1${version}$2`,
  );
  next = next.replace(
    new RegExp(`(${escapeRegExp(name)}\\s*=\\s*\\{[^}]*version\\s*=\\s*")[^"]*(")`),
    `$1${version}$2`,
  );
  return next;
}

function insertOverride(source: string, name: string, target: string): string {
  const json = JSON.parse(source) as { overrides?: Record<string, string> };
  if (json.overrides && typeof json.overrides[name] === "string") {
    return replaceJsonString(source, name, json.overrides[name], target);
  }
  const block = `"overrides": {\n    "${name}": "${target}"\n  }`;
  const trimmed = source.replace(/\s*$/, "");
  if (!trimmed.endsWith("}")) {
    throw new Error("package.json must be a JSON object to add an override.");
  }
  const head = trimmed.slice(0, -1).replace(/\s*$/, "");
  const needsComma = !head.endsWith("{");
  return `${head}${needsComma ? "," : ""}\n  ${block}\n}\n`;
}

function replaceJsonString(source: string, name: string, current: string, next: string): string {
  const pattern = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")${escapeRegExp(current)}(")`);
  return source.replace(pattern, `$1${next}$2`);
}

function namesClose(left: string, right: string): boolean {
  return left.toLowerCase().replace(/[-_.]+/g, "-") === right.toLowerCase().replace(/[-_.]+/g, "-");
}

function stripV(version: string): string {
  return version.replace(/^v(?=\d)/, "");
}

function ensureTrailingNewline(source: string): string {
  return source.endsWith("\n") ? source : `${source}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
