// CANONICAL SHARED FILE — standard MCP-S01. Copied verbatim into every
// ts-mcp-server repo; /repo-standards-audit hash-compares it.
//
// Tool result helpers. The naming here is deliberate and fixes a real
// collision: seven repos had an `asText()` that JSON-stringified its argument,
// while one had an `asText()` that passed raw text through unchanged. The same
// identifier meant opposite things in sibling repos, so copying a handler
// between them silently changed the response shape.
//
//   asJson(data)  — structured data  -> pretty-printed JSON in a text block
//   asText(text)  — already a string -> passed through verbatim
//
// One meaning each, fleet-wide.

import { maybeRedact, type RedactOptions } from "./redact.js";

export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

/** Structured data as a pretty-printed JSON text block. Redacted by default. */
export function asJson(data: unknown, opts?: RedactOptions): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(maybeRedact(data, opts), null, 2) },
    ],
  };
}

/** Text that is already text (a plain-text API reply, a rendered table). */
export function asText(text: string, opts?: RedactOptions): ToolResult {
  return { content: [{ type: "text", text: maybeRedact(text, opts) }] };
}

/** Binary as a base64 image block. */
export function asImage(bytes: Uint8Array, mimeType: string): ToolResult {
  return {
    content: [
      { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
    ],
  };
}

// ── Pagination — standard MCP-P03 ────────────────────────────────────────
// offset/limit, a cap that THROWS rather than clamping, and a stable sort.

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type Page<T> = {
  total: number;
  offset: number;
  size: number;
  items: T[];
};

/**
 * Slice a fully-materialized collection into a page.
 *
 * A limit over MAX_PAGE_SIZE throws. It does NOT clamp: a silently clamped
 * limit returns a short page that looks like the end of the data, so the caller
 * concludes it has everything and stops. Failing loudly costs one error and
 * saves a wrong answer.
 *
 * `tiebreak` must produce a UNIQUE, STABLE key. Without one, two records that
 * compare equal can swap order between calls, and paging then repeats one row
 * and skips another with nothing in the output to indicate it happened.
 */
export function paginate<T>(
  all: T[],
  opts: { offset?: number; limit?: number; tiebreak?: (item: T) => string },
): Page<T> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;

  if (limit > MAX_PAGE_SIZE) {
    throw new Error(
      `limit ${limit} exceeds the maximum of ${MAX_PAGE_SIZE}. Request a smaller page and use offset to continue.`,
    );
  }
  if (limit < 1) throw new Error(`limit must be at least 1, got ${limit}.`);

  const ordered = opts.tiebreak
    ? [...all].sort((a, b) => {
        const ka = opts.tiebreak!(a);
        const kb = opts.tiebreak!(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      })
    : all;

  const items = ordered.slice(offset, offset + limit);
  return { total: all.length, offset, size: items.length, items };
}

/** Keep only the requested fields — sparse projection to save context window. */
export function pickFields<T extends Record<string, unknown>>(
  items: T[],
  fields: string[] | undefined,
): Array<Partial<T>> | T[] {
  if (!fields || fields.length === 0) return items;
  return items.map((item) => {
    const out: Partial<T> = {};
    for (const f of fields) {
      if (f in item) out[f as keyof T] = item[f as keyof T];
    }
    return out;
  });
}
