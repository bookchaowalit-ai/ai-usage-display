export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  json: () => Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

/** Thin wrapper around global fetch so tests can inject a mock. */
export const defaultFetch: FetchLike = async (input, init) => {
  const res = await fetch(input, init);
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text,
    json: async () => {
      if (!text) return null;
      return JSON.parse(text) as unknown;
    },
  };
};

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = res.text;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}
