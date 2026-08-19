// CANONICAL SHARED FILE — standard MCP-S01. Copied verbatim into every
// ts-mcp-server repo; /repo-standards-audit hash-compares it. Fix bugs HERE and
// re-propagate; a local edit will be reported as drift.
//
// Levelled logger that writes to STDERR ONLY. On a stdio MCP server, stdout IS
// the JSON-RPC wire — a single console.log corrupts the frame stream and the
// client sees malformed protocol rather than your message. See
// reference/rules/stdout-stderr-contract.md.

import { redact } from "./redact.js";

const LEVELS = ["trace", "debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LEVELS)[number];

function parseLevel(raw: string | undefined): LogLevel {
  const v = raw?.trim().toLowerCase();
  // Empty string means unset, not "invalid" — MCP hosts inject "" for blank
  // config fields (MCP-P07).
  if (!v) return "info";
  return (LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "info";
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  if (currentLevel === "silent") return false;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function emit(
  level: Exclude<LogLevel, "silent">,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (!enabled(level)) return;
  const pairs = fields
    ? " " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${redact(String(v))}`)
        .join(" ")
    : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${redact(msg)}${pairs}`;
  // Always stderr. Never console.log — see the header note.
  console.error(line);
}

export type Logger = {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

export function logger(scope: string): Logger {
  return {
    trace: (m, f) => emit("trace", scope, m, f),
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
  };
}

/**
 * Summarize tool arguments for logging — standard MCP-P05.
 *
 * At info level this returns argument KEYS ONLY. Values are logged only at
 * debug. Two servers in the fleet logged arguments verbatim at info, and for
 * the mail server those arguments carried search queries and recipient
 * addresses — user content written into container logs, which then need the
 * same handling as the mailbox itself. Keys answer the operational question
 * ("which tool, called with what shape") without the payload.
 */
export function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "{}";
  if (typeof args !== "object") return typeof args;
  const keys = Object.keys(args as Record<string, unknown>);
  if (currentLevel === "trace" || currentLevel === "debug") {
    return redact(JSON.stringify(args));
  }
  return `{${keys.join(",")}}`;
}
