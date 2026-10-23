import semver from "semver";
import type { Ecosystem, VersionRange } from "./types";

const PEP440 =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|rc|c|pre|preview)[-_.]?(\d*))?(?:[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+.*)?$/i;

const PRE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  rc: 2,
  c: 2,
  pre: 2,
  preview: 2,
};

interface PepVersion {
  epoch: number;
  release: number[];
  pre: { rank: number; n: number } | "infinity" | "neginf";
  post: number | "neginf";
  dev: number | "infinity";
}

export function normalizeName(ecosystem: Ecosystem, name: string): string {
  const trimmed = name.trim();
  if (ecosystem === "npm" || ecosystem === "crates") return trimmed.toLowerCase();
  if (ecosystem === "pypi") return trimmed.toLowerCase().replace(/[-_.]+/g, "-");
  return trimmed;
}

export function namesEqual(ecosystem: Ecosystem, left: string, right: string): boolean {
  return normalizeName(ecosystem, left) === normalizeName(ecosystem, right);
}

export function parseAdvisoryRange(input: string): VersionRange[] {
  return input
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseOneRange)
    .filter(rangeIsBounded);
}

function parseOneRange(input: string): VersionRange {
  const range: VersionRange = {};
  for (const clause of input.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = clause.match(/^(>=|<=|>|<|=)\s*(.+)$/);
    if (!match) continue;
    const [, operator, rawVersion] = match;
    const version = rawVersion.trim();
    if (operator === ">=") range.introduced = version;
    else if (operator === ">") {
      range.introduced = version;
      range.introducedExclusive = true;
    } else if (operator === "<") range.fixed = version;
    else if (operator === "<=") range.lastAffected = version;
    else if (operator === "=") {
      range.introduced = version;
      range.lastAffected = version;
    }
  }
  return range;
}

export function rangeIsBounded(range: VersionRange): boolean {
  return Boolean(range.introduced || range.fixed || range.lastAffected);
}

export function compareVersions(ecosystem: Ecosystem, left: string, right: string): number | null {
  if (ecosystem === "pypi") {
    const a = parsePep440(left);
    const b = parsePep440(right);
    if (!a || !b) return null;
    return comparePep(a, b);
  }
  const a = parseSemverish(left);
  const b = parseSemverish(right);
  if (!a || !b) return null;
  return a.compare(b);
}

export function versionInRange(
  ecosystem: Ecosystem,
  version: string,
  range: VersionRange,
): boolean | null {
  if (!rangeIsBounded(range)) return null;
  if (range.introduced && !isZeroBound(range.introduced)) {
    const order = compareVersions(ecosystem, version, range.introduced);
    if (order === null) return null;
    if (range.introducedExclusive ? order <= 0 : order < 0) return false;
  }
  if (range.fixed) {
    const order = compareVersions(ecosystem, version, range.fixed);
    if (order === null) return null;
    if (order >= 0) return false;
  } else if (range.lastAffected) {
    const order = compareVersions(ecosystem, version, range.lastAffected);
    if (order === null) return null;
    if (order > 0) return false;
  }
  return true;
}

export interface VersionHit {
  match: boolean;
  uncertain: boolean;
  range?: VersionRange;
  explicit?: string;
}

export function versionMatchesAffected(
  ecosystem: Ecosystem,
  version: string | undefined,
  ranges: VersionRange[],
  explicitVersions: string[] | undefined,
): VersionHit {
  if (!version) return { match: false, uncertain: true };
  if (explicitVersions?.length) {
    for (const pinned of explicitVersions) {
      const order = compareVersions(ecosystem, version, pinned);
      if (order === 0) return { match: true, uncertain: false, explicit: pinned };
    }
  }
  const bounded = ranges.filter(rangeIsBounded);
  if (bounded.length === 0) {
    return explicitVersions?.length
      ? { match: false, uncertain: false }
      : { match: false, uncertain: true };
  }
  let uncertain = false;
  for (const range of bounded) {
    const inside = versionInRange(ecosystem, version, range);
    if (inside === null) {
      uncertain = true;
      continue;
    }
    if (inside) return { match: true, uncertain: false, range };
  }
  return { match: false, uncertain };
}

/** True when an unresolved manifest range can still install a vulnerable version. */
export function requestedOverlaps(
  ecosystem: Ecosystem,
  requested: string | undefined,
  ranges: VersionRange[],
): boolean | null {
  if (!requested) return null;
  const bounded = ranges.filter(rangeIsBounded);
  if (bounded.length === 0) return null;
  if (ecosystem === "pypi") return pepSpecifierOverlaps(requested, bounded);
  const cleaned = semver.validRange(requested.trim());
  if (!cleaned) return null;
  let any = false;
  for (const range of bounded) {
    const asSemver = rangeToSemver(range);
    if (!asSemver) return null;
    try {
      if (semver.intersects(cleaned, asSemver, { includePrerelease: true })) any = true;
    } catch {
      return null;
    }
  }
  return any;
}

export function describeRange(range: VersionRange): string {
  const parts: string[] = [];
  if (range.introduced && !isZeroBound(range.introduced)) {
    parts.push(`${range.introducedExclusive ? ">" : ">="}${range.introduced}`);
  } else {
    parts.push(">=0");
  }
  if (range.fixed) parts.push(`<${range.fixed}`);
  else if (range.lastAffected) parts.push(`<=${range.lastAffected}`);
  else parts.push("(no patched release listed)");
  return parts.join(" ");
}

export function parsePep440(input: string): PepVersion | null {
  const match = PEP440.exec(input.trim());
  if (!match) return null;
  const epoch = match[1] ? Number(match[1]) : 0;
  const release = match[2].split(".").map((part) => Number(part));
  if (release.some((part) => Number.isNaN(part))) return null;
  const preTag = match[3]?.toLowerCase();
  const preNum = match[4] ? Number(match[4]) : 0;
  const postNum = match[6] !== undefined ? Number(match[6] || "0") : null;
  const hasPost = match[5] !== undefined;
  const devNum = match[7] !== undefined ? Number(match[7] || "0") : null;
  const pre =
    preTag !== undefined
      ? { rank: PRE_RANK[preTag] ?? 0, n: preNum }
      : hasPost || devNum === null
        ? "infinity"
        : "neginf";
  return {
    epoch,
    release,
    pre: preTag === undefined && !hasPost && devNum !== null ? "neginf" : pre,
    post: hasPost ? (postNum ?? 0) : "neginf",
    dev: devNum === null ? "infinity" : devNum,
  };
}

function comparePep(left: PepVersion, right: PepVersion): number {
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (delta !== 0) return delta;
  }
  const pre = compareSlot(left.pre, right.pre);
  if (pre !== 0) return pre;
  const post = compareSlot(left.post, right.post);
  if (post !== 0) return post;
  return compareSlot(left.dev, right.dev);
}

function compareSlot(
  left: PepVersion["pre"] | PepVersion["post"] | PepVersion["dev"],
  right: PepVersion["pre"] | PepVersion["post"] | PepVersion["dev"],
): number {
  const rank = (value: typeof left) => {
    if (value === "infinity") return Number.POSITIVE_INFINITY;
    if (value === "neginf") return Number.NEGATIVE_INFINITY;
    if (typeof value === "number") return value;
    return value.rank * 1_000_000 + value.n;
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank === rightRank) return 0;
  return leftRank < rightRank ? -1 : 1;
}

function parseSemverish(input: string): semver.SemVer | null {
  let version = input.trim();
  if (version.startsWith("v") || version.startsWith("V")) version = version.slice(1);
  version = version.replace(/\+incompatible$/, "");
  if (version === "0") version = "0.0.0";
  const valid = semver.valid(version);
  if (valid) return new semver.SemVer(valid, true);
  const coerced = semver.coerce(version);
  return coerced ? new semver.SemVer(coerced.version) : null;
}

function isZeroBound(version: string): boolean {
  return version === "0" || version === "0.0" || version === "0.0.0" || version === "v0.0.0";
}

function rangeToSemver(range: VersionRange): string | null {
  const parts: string[] = [];
  if (range.introduced && !isZeroBound(range.introduced)) {
    const version = parseSemverish(range.introduced);
    if (!version) return null;
    parts.push(`${range.introducedExclusive ? ">" : ">="}${version.version}`);
  }
  if (range.fixed) {
    const version = parseSemverish(range.fixed);
    if (!version) return null;
    parts.push(`<${version.version}`);
  } else if (range.lastAffected) {
    const version = parseSemverish(range.lastAffected);
    if (!version) return null;
    parts.push(`<=${version.version}`);
  }
  return parts.length > 0 ? parts.join(" ") : ">=0.0.0";
}

function pepSpecifierOverlaps(requested: string, ranges: VersionRange[]): boolean | null {
  const interval = pepInterval(requested);
  if (interval === null) return null;
  if (interval === "empty") return false;
  return ranges.some((range) => {
    const other = rangeInterval(range);
    return other ? intervalsOverlap(interval, other) : false;
  });
}

interface Interval {
  low: PepVersion | null;
  lowInclusive: boolean;
  high: PepVersion | null;
  highInclusive: boolean;
}

function pepInterval(requested: string): Interval | "empty" | null {
  const clauses = requested
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  let interval: Interval = { low: null, lowInclusive: true, high: null, highInclusive: true };
  for (const clause of clauses) {
    const match = clause.match(/^(===|==|~=|!=|>=|<=|>|<)\s*(.+)$/);
    if (!match) return null;
    const [, operator, raw] = match;
    if (operator === "!=") return null;
    const version = parsePep440(raw);
    if (!version) return null;
    let next: Interval;
    if (operator === "==" || operator === "===") {
      next = { low: version, lowInclusive: true, high: version, highInclusive: true };
    } else if (operator === ">=") {
      next = { low: version, lowInclusive: true, high: null, highInclusive: true };
    } else if (operator === ">") {
      next = { low: version, lowInclusive: false, high: null, highInclusive: true };
    } else if (operator === "<=") {
      next = { low: null, lowInclusive: true, high: version, highInclusive: true };
    } else if (operator === "<") {
      next = { low: null, lowInclusive: true, high: version, highInclusive: false };
    } else {
      const compatible = compatibleUpper(raw);
      if (!compatible) return null;
      next = { low: version, lowInclusive: true, high: compatible, highInclusive: false };
    }
    const merged = intersectIntervals(interval, next);
    if (!merged) return "empty";
    interval = merged;
  }
  return interval;
}

function compatibleUpper(raw: string): PepVersion | null {
  const parts = raw.split(".").filter((part) => /^\d+$/.test(part));
  if (parts.length < 2) return null;
  const prefix = parts.slice(0, -1).map(Number);
  prefix[prefix.length - 1] += 1;
  return {
    epoch: 0,
    release: prefix,
    pre: "neginf",
    post: "neginf",
    dev: "infinity",
  };
}

function rangeInterval(range: VersionRange): Interval | null {
  const low =
    range.introduced && !isZeroBound(range.introduced) ? parsePep440(range.introduced) : null;
  if (range.introduced && !isZeroBound(range.introduced) && !low) return null;
  const highSource = range.fixed ?? range.lastAffected;
  const high = highSource ? parsePep440(highSource) : null;
  if (highSource && !high) return null;
  return {
    low,
    lowInclusive: !range.introducedExclusive,
    high,
    highInclusive: !range.fixed && Boolean(range.lastAffected),
  };
}

function intersectIntervals(left: Interval, right: Interval): Interval | null {
  const low = pickLow(left, right);
  const high = pickHigh(left, right);
  if (!low || !high) return null;
  if (low.version && high.version) {
    const order = comparePep(low.version, high.version);
    if (order > 0 || (order === 0 && (!low.inclusive || !high.inclusive))) return null;
  }
  return {
    low: low.version,
    lowInclusive: low.inclusive,
    high: high.version,
    highInclusive: high.inclusive,
  };
}

function pickLow(left: Interval, right: Interval): { version: PepVersion | null; inclusive: boolean } | null {
  if (!left.low) return { version: right.low, inclusive: right.lowInclusive };
  if (!right.low) return { version: left.low, inclusive: left.lowInclusive };
  const order = comparePep(left.low, right.low);
  if (order > 0) return { version: left.low, inclusive: left.lowInclusive };
  if (order < 0) return { version: right.low, inclusive: right.lowInclusive };
  return { version: left.low, inclusive: left.lowInclusive && right.lowInclusive };
}

function pickHigh(left: Interval, right: Interval): { version: PepVersion | null; inclusive: boolean } | null {
  if (!left.high) return { version: right.high, inclusive: right.highInclusive };
  if (!right.high) return { version: left.high, inclusive: left.highInclusive };
  const order = comparePep(left.high, right.high);
  if (order < 0) return { version: left.high, inclusive: left.highInclusive };
  if (order > 0) return { version: right.high, inclusive: right.highInclusive };
  return { version: left.high, inclusive: left.highInclusive && right.highInclusive };
}

function intervalsOverlap(left: Interval, right: Interval): boolean {
  return intersectIntervals(left, right) !== null;
}
