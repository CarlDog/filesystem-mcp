// CANONICAL SHARED FILE — standard MCP-S01 / MCP-P07. Copied verbatim into
// every ts-mcp-server repo; /repo-standards-audit hash-compares it.
//
// Env parsing helpers with ONE rule that the whole fleet got wrong: an
// empty-string env var means UNSET, not "empty value".
//
// MCP hosts inject "" for a blank config field. A server that checks
// `process.env.X !== undefined` therefore sees a configured-but-empty value,
// skips its default, and fails at request time with an auth error that is
// invisible from a shell (where the var simply is not set). The survey found
// zero of nine TS servers handling this, despite the rule being written down.
//
// Worse than absent is inconsistent: one server's int parser treated "" as
// unset while its deny-pattern parser treated "" as "deny nothing", so an empty
// env var silently switched off a sensitive-file filter. Hence parseListStrict
// below, and the rule that a safety control must fail loudly rather than
// default to off.

export type Env = Record<string, string | undefined>;

/** Raw read with empty-string-is-unset applied. The basis for everything else. */
export function raw(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function parseString(
  env: Env,
  key: string,
  fallback?: string,
): string | undefined {
  return raw(env, key) ?? fallback;
}

/** Required string. Throws with the variable name so the fix is obvious. */
export function requireString(env: Env, key: string): string {
  const v = raw(env, key);
  if (v === undefined) {
    throw new Error(
      `Missing required environment variable ${key}. Set it in the MCP host config or the container environment.`,
    );
  }
  return v;
}

export function parseInt_(env: Env, key: string, fallback: number): number {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be an integer, got "${v}".`);
  }
  return n;
}

export function parseBool(env: Env, key: string, fallback: boolean): boolean {
  const v = raw(env, key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be a boolean, got "${v}".`);
}

/** Comma-separated list. Unset or empty yields the fallback. */
export function parseList(env: Env, key: string, fallback: string[]): string[] {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

/**
 * Comma-separated list backing a SAFETY control (deny patterns, allowed hosts,
 * permitted roots).
 *
 * Unset falls back to the secure default. A value that is present but parses to
 * nothing THROWS rather than yielding an empty list, because for a safety
 * control an empty list means "allow everything" — the one interpretation that
 * must never be reachable by a typo.
 */
export function parseListStrict(
  env: Env,
  key: string,
  fallback: string[],
): string[] {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(
      `${key} is set but contains no usable entries. Leave it unset to use the default (${fallback.join(", ") || "none"}); an empty value would disable this safety control.`,
    );
  }
  return items;
}

/** Mask a credential for diagnostics: first 4 chars, then a fixed marker. */
export function maskKey(value: string | undefined): string {
  if (!value) return "<unset>";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 4)}${"*".repeat(8)}`;
}

/**
 * Config shared by every server in the fleet. A repo extends this with its own
 * fields in src/config.ts and calls loadBaseConfig() from there.
 *
 * `env` is a parameter rather than a direct process.env read so config parsing
 * is unit-testable without mutating global state — kindroid-mcp's pattern, and
 * the only one in the fleet that was actually tested.
 */
export type BaseConfig = {
  logLevel: string;
  port: number | undefined;
  bindHost: string;
  allowedHosts: string[] | undefined;
  authToken: string | undefined;
  requestTimeoutMs: number;
  sessionIdleMs: number;
};

export function loadBaseConfig(env: Env = process.env): BaseConfig {
  return {
    logLevel: parseString(env, "LOG_LEVEL", "info") as string,
    // Unset MCP_PORT means stdio transport. This is the switch between the two
    // modes, so it must distinguish unset from 0.
    port:
      raw(env, "MCP_PORT") === undefined
        ? undefined
        : parseInt_(env, "MCP_PORT", 3000),
    // Loopback by default: a container that binds 0.0.0.0 with no auth is
    // reachable by anything on the Docker network. Opt in to wider exposure.
    bindHost: parseString(env, "MCP_BIND_HOST", "127.0.0.1") as string,
    allowedHosts:
      raw(env, "MCP_ALLOWED_HOSTS") === undefined
        ? undefined
        : parseListStrict(env, "MCP_ALLOWED_HOSTS", []),
    authToken: raw(env, "MCP_AUTH_TOKEN"),
    requestTimeoutMs: parseInt_(env, "REQUEST_TIMEOUT_MS", 60_000),
    sessionIdleMs: parseInt_(env, "MCP_SESSION_IDLE_MS", 30 * 60_000),
  };
}
