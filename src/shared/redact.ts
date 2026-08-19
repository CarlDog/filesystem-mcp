// CANONICAL SHARED FILE — standard MCP-S01 / MCP-P04. Copied verbatim into
// every ts-mcp-server repo; /repo-standards-audit hash-compares it.
//
// Two-detection secret redactor, generalized from portainer-mcp's
// implementation (the fleet reference, and the only one that reached tool
// RESPONSES rather than just logs).
//
// Detection 1 — key name: a field CALLED a secret is treated as one whatever
// its value looks like.
// Detection 2 — value shape: a recognizable credential is redacted wherever it
// appears, including inside a field with an innocuous name.
//
// Neither alone is sufficient. Key-name matching misses a token pasted into a
// `description`; value-shape matching misses a short opaque password that looks
// like ordinary text.

const SECRET_KEY_RE =
  /(pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth|bearer|session[-_]?id|cookie|signature)/i;

// Value shapes that are recognizably credentials. Deliberately specific: a
// pattern loose enough to catch "any long string" would redact legitimate
// content (file hashes, IDs, prose) and train the reader to ignore the marker.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/gi, // user:pass@ in a URL
];

export const REDACTED = "<redacted>";

/** Redact recognizable credential shapes inside a string. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Walk a value and redact secrets by key name and by value shape.
 *
 * DANGER — read before using this on a read-modify-write path. A redactor on
 * the read path makes round-tripping unsafe: GET an object, mutate one field,
 * PUT it back, and you have just written "<redacted>" over the real secret.
 * Internal round-trips must fetch through the `noRedact` escape hatch below,
 * and that raw value must never be returned to a caller.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (keyHint && SECRET_KEY_RE.test(keyHint)) return REDACTED;
    return redact(value);
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    // Docker/compose-style ["KEY=value"] entries carry the key inside the
    // string, so the key-name rule has to be applied to the left of the "=".
    return value.map((item) => {
      if (typeof item === "string") {
        const eq = item.indexOf("=");
        if (eq > 0) {
          const k = item.slice(0, eq);
          if (SECRET_KEY_RE.test(k)) return `${k}=${REDACTED}`;
        }
      }
      return walk(item, keyHint);
    });
  }

  const obj = value as Record<string, unknown>;

  // Portainer-style [{ Name, Value }] pairs: the key lives in a sibling field,
  // so a naive per-key walk would never see it.
  if (
    typeof obj.Name === "string" &&
    "Value" in obj &&
    SECRET_KEY_RE.test(obj.Name)
  ) {
    return { ...obj, Value: REDACTED };
  }
  if (
    typeof obj.name === "string" &&
    "value" in obj &&
    SECRET_KEY_RE.test(obj.name)
  ) {
    return { ...obj, value: REDACTED };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      SECRET_KEY_RE.test(k) && typeof v === "string" ? REDACTED : walk(v, k);
  }
  return out;
}

/**
 * Options accepted by the repo's HTTP request wrapper.
 *
 * `noRedact` is the ONE sanctioned bypass, named so it is greppable: a reviewer
 * can enumerate every exception with a single search instead of auditing every
 * call site for whether it went through the wrapper at all. Use it only for
 * internal read-modify-write round-trips, and never return its result to a
 * caller. See reference/rules/security.md on chokepoints.
 */
export type RedactOptions = { noRedact?: boolean };

export function maybeRedact<T>(value: T, opts?: RedactOptions): T {
  return opts?.noRedact ? value : redactSecrets(value);
}
