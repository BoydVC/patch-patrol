import type { Advisory } from "../types";

export function advisoryInWindow(
  advisory: { publishedAt: string; modifiedAt?: string; withdrawn?: boolean },
  since: Date,
  until: Date,
): boolean {
  if (advisory.withdrawn) return false;
  return inWindow(advisory.publishedAt, since, until) || inWindow(advisory.modifiedAt, since, until);
}

/** NVD timestamps omit the zone and are UTC. Zoneless values are read as UTC. */
export function parseInstant(iso: string): Date {
  const trimmed = iso.trim();
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) return new Date(trimmed);
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return new Date(`${trimmed.replace(/\.\d+$/, "")}Z`);
  return new Date(trimmed);
}

export function inWindow(iso: string | undefined, since: Date, until: Date): boolean {
  if (!iso) return false;
  const time = parseInstant(iso).getTime();
  return time >= since.getTime() && time <= until.getTime();
}

export function partitionAdvisories(
  advisories: Advisory[],
  since: Date,
  until: Date,
): { kept: Advisory[]; skippedWithdrawn: number; skippedWindow: number } {
  const kept: Advisory[] = [];
  let skippedWithdrawn = 0;
  let skippedWindow = 0;
  for (const advisory of advisories) {
    if (advisory.withdrawn) {
      skippedWithdrawn += 1;
      continue;
    }
    if (!advisoryInWindow(advisory, since, until)) {
      skippedWindow += 1;
      continue;
    }
    kept.push(advisory);
  }
  return { kept, skippedWithdrawn, skippedWindow };
}
