// CANONICAL SHARED FILE — standard MCP-S01 / MCP-F02 / MCP-F04 / MCP-F08.
// Copied verbatim into every ts-mcp-server repo; /repo-standards-audit
// hash-compares it.
//
// Typed API errors plus the retry policy. Generalized from kindroid-mcp, the
// only server in the fleet with either.

/**
 * An upstream API failure.
 *
 * `status: 0` means the request never got a response (DNS, connect, timeout,
 * abort). Callers need to distinguish that from a real 5xx: a transport failure
 * on a non-idempotent operation may have been applied server-side anyway, so it
 * must NOT be blindly retried.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly body: string | undefined;

  constructor(
    message: string,
    opts: { status: number; retryAfterMs?: number; body?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }

  get isTransport(): boolean {
    return this.status === 0;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Describe a transport-level failure (status: 0) with its real cause.
 *
 * Node's global `fetch()` throws a bare `TypeError: fetch failed` on any
 * network-level error (DNS, connect, TLS) — the actual reason lives in
 * `error.cause` and is discarded if nothing reads it, making a live
 * connectivity fault undiagnosable from the tool's error output alone
 * (MCP-F08; found live in downloader-mcp, 2026-08-18: a stale upstream URL
 * stayed silently broken because every failure just said "fetch failed").
 *
 * Callers MUST fold this into the `ApiError`'s `message` itself, not rely on
 * `cause` surviving on the Error object — the MCP SDK's own tool-error
 * conversion reads only `error.message`, so `cause` is discarded again at
 * that boundary regardless of what the client preserved.
 *
 * `undici`'s own low-level `request()` already throws the raw underlying
 * error with the real reason in `.message` — a call site using it doesn't
 * need this helper, though it's harmless to apply anyway. This does NOT
 * extend to `fetch()`: undici's own spec-compliant `fetch()` shares the
 * identical WHATWG error-wrapping behavior with Node's global `fetch` (they
 * are, in fact, the same underlying implementation) — verified empirically
 * 2026-08-18, both throw a bare `fetch failed` with the real cause only in
 * `.cause`. A call site on either `fetch()` needs this helper.
 */
export function describeTransportError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const causeMsg =
    cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return causeMsg ? `${base}: ${causeMsg}` : base;
}

/**
 * Build the fleet-standard error message.
 *
 * Shape: `<Service> <status> <statusText> for <path>: <body excerpt>`. Seven
 * repos converged on this independently, which is good evidence it is the right
 * shape — it puts the three things you need (which service, what code, which
 * endpoint) before the noisy part, and truncates the body so an HTML error page
 * cannot flood the transcript.
 */
export function formatApiError(
  service: string,
  status: number,
  statusText: string,
  path: string,
  body: string,
): string {
  const excerpt = body.slice(0, 200);
  return `${service} ${status} ${statusText} for ${path}: ${excerpt}`;
}

/** Hard ceiling on an honoured Retry-After. See parseRetryAfterMs. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) to milliseconds.
 *
 * Returns undefined when absent or unparseable. THROWS when the server asks for
 * longer than MAX_RETRY_AFTER_MS: honouring an unbounded wait stalls the whole
 * tool queue behind one rate-limited call, and a caller that gets an error can
 * retry later on its own terms. Bounded, or thrown — never an unbounded sleep.
 * See reference/rules/api-integration.md.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  let ms: number;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds)) {
    ms = asSeconds * 1000;
  } else {
    const when = Date.parse(trimmed);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }

  if (ms <= 0) return 0;
  if (ms > MAX_RETRY_AFTER_MS) {
    throw new ApiError(
      `Upstream asked to retry after ${Math.round(ms / 1000)}s, over the ${MAX_RETRY_AFTER_MS / 1000}s cap. Failing fast rather than stalling the queue.`,
      { status: 429, retryAfterMs: ms },
    );
  }
  return ms;
}

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters: without it, N callers rate-limited at the same moment retry
 * in lockstep and re-trigger the limit together.
 */
export function backoffMs(attempt: number, baseMs = 2000): number {
  const exponential = Math.min(baseMs * 2 ** attempt, 30_000);
  return Math.round(exponential + Math.random() * 250);
}

/**
 * Should this failure be retried?
 *
 * 429 only, and only for idempotent operations. Deliberately narrow: a 5xx on a
 * write may have been applied before the error, and retrying it duplicates the
 * effect. Ambiguity resolves to "do not retry".
 */
export function shouldRetry(err: unknown, idempotent: boolean): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.isRateLimit) return true;
  if (!idempotent) return false;
  return err.isTransport || err.status >= 500;
}
