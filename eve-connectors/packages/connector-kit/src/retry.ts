export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterSec?: number, message?: string) {
    super(message ?? `provider http ${status}`);
    this.name = "ProviderHttpError";
  }
}

export interface RetryOptions {
  retries?: number;          // additional attempts after the first
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called once per 401 so the caller can drop a cached token (Vercel Connect: deleteTokenCacheEntry). */
  onUnauthorized?: () => void | Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries 429/5xx/network errors with exponential backoff + full jitter; honors Retry-After; one 401 refresh. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 3, base = o.baseMs ?? 250, max = o.maxMs ?? 8000;
  const sleep = o.sleep ?? defaultSleep, rnd = o.random ?? Math.random;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const status = err instanceof ProviderHttpError ? err.status : undefined;
      if (status === 401 && !refreshed && o.onUnauthorized) {
        refreshed = true;
        await o.onUnauthorized();
        continue; // a token refresh does not consume a retry
      }
      const retryable = status !== undefined ? status === 429 || status >= 500 : isNetworkError(err);
      if (!retryable || attempt >= retries) throw err;
      const ra = err instanceof ProviderHttpError ? err.retryAfterSec : undefined;
      const delay = ra !== undefined ? Math.min(ra * 1000, max) : Math.min(max, base * 2 ** attempt) * Math.max(rnd(), 0.05);
      await sleep(delay);
    }
  }
}

/** Throw ProviderHttpError for non-2xx fetch responses (parses Retry-After seconds). */
export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  throw new ProviderHttpError(res.status, parseRetryAfter(res.headers.get("retry-after")), `provider http ${res.status}`);
}

/** Retry-After as delta-seconds or HTTP-date (RFC 9110). */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const d = Date.parse(s);
  return Number.isNaN(d) ? undefined : Math.max(0, Math.ceil((d - now) / 1000));
}

/** fetch() network failures surface as TypeError; timeouts as AbortError/TimeoutError. Programming errors are not retried. */
function isNetworkError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return err instanceof TypeError || name === "AbortError" || name === "TimeoutError";
}
