export interface ConfigRepo {
  name: string;
  path?: string;
  github?: string;
}

export interface PatrolConfig {
  windowHours?: number;
  now?: string;
  repos: ConfigRepo[];
}

export function parseConfig(text: string): PatrolConfig {
  const value = JSON.parse(text) as {
    windowHours?: number;
    now?: string;
    repos?: Array<string | { name?: string; path?: string; github?: string }>;
  };
  if (!Array.isArray(value.repos) || value.repos.length === 0) {
    throw new Error("Config needs a repos list.");
  }
  const repos = value.repos.map((entry) => {
    if (typeof entry === "string") return { name: entry, github: entry };
    if (!entry.name && !entry.github) throw new Error("Each repo needs a name or a github owner/name.");
    const name = entry.name ?? entry.github!;
    return { name, path: entry.path, github: entry.github ?? (entry.path ? undefined : name) };
  });
  return { windowHours: value.windowHours, now: value.now, repos };
}
