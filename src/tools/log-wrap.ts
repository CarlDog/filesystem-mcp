import { logger, summarizeArgs } from "../shared/log.js";

const log = logger("tools");

/**
 * Wraps a tool handler with a single info-level "tool called" log line —
 * standard MCP-P05. Argument KEYS only (never values: these are filesystem
 * paths, and the deny-pattern filter exists specifically to keep sensitive
 * basenames out of responses — dumping raw values here would route denied
 * basenames straight into the logs anyway).
 */
export function logged<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    log.info("tool_call", { name, args: summarizeArgs(args[0]) });
    return handler(...args);
  };
}
