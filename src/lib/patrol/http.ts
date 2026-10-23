export const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "api.osv.dev",
  "osv-vulnerabilities.storage.googleapis.com",
  "services.nvd.nist.gov",
]);

export type FetchLike = typeof fetch;

export function assertAllowedHost(url: string): void {
  const host = new URL(url).host;
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Refusing to fetch ${host}. Patch Patrol only calls GitHub, OSV, and NVD.`);
  }
}

export async function requestText(
  url: string,
  options: {
    fetchImpl?: FetchLike;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  assertAllowedHost(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      "user-agent": "patch-patrol",
      ...options.headers,
    },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

export async function requestJson<T>(
  url: string,
  options: {
    fetchImpl?: FetchLike;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; json: T; headers: Headers }> {
  const response = await requestText(url, options);
  const json = response.text ? (JSON.parse(response.text) as T) : ({} as T);
  return { status: response.status, json, headers: response.headers };
}
