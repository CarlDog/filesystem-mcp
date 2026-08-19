// CANONICAL SHARED FILE — standard MCP-S01 / MCP-P02. Copied verbatim into
// every ts-mcp-server repo; /repo-standards-audit hash-compares it.
//
// Named annotation bundles. Every registerTool call passes exactly one of these
// rather than an inline literal, so a tool's safety category is visible at the
// registration site and greppable across the repo.
//
// This matters more than it looks. One server in the fleet registers 14 write
// tools with NO annotations at all, including one that deletes a stack with all
// its containers and one that sends SIGKILL. Its prose instructions tell the
// model to confirm first, but the machine-readable channel a client reads to
// decide whether to PROMPT the human is empty — so a careful client and a
// careless one behave identically.

/** Read-only, scoped to the configured upstream. No external fanout. */
export const ANN_READ = {
  readOnlyHint: true,
  openWorldHint: false,
} as const;

/**
 * Read-only, but reaches a third party (metadata lookup, indexer search).
 * openWorldHint tells the client this call can be slow or rate-limited.
 */
export const ANN_READ_EXTERNAL = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

/** Additive write. Not destructive; not idempotent (a duplicate add errors). */
export const ANN_ADD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Update an existing entity. Idempotent — re-applying the same edit is a no-op.
 * destructiveHint stays FALSE only when the edit cannot move or drop data; an
 * edit that relocates files on disk uses ANN_DESTRUCTIVE instead.
 */
export const ANN_EDIT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Irreversible or data-losing. Delete, kill, purge, overwrite.
 *
 * A tool with this annotation must ALSO gate on a human-readable name
 * (MCP-P06), because the annotation only asks the client to prompt — it does
 * not prevent anything on its own.
 */
export const ANN_DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Triggers an async command upstream (a scan, a refresh, a search). Idempotent
 * at the queue level; open-world because of what the command then reaches.
 */
export const ANN_COMMAND = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Name patterns used by annotations.test.ts to check that a tool's annotations
 * match what its name claims it does.
 *
 * Extend READ_VERBS / DESTRUCTIVE_VERBS in the repo's own test if it has verbs
 * these miss — the test is meant to be tightened per repo, not loosened.
 */
export const READ_VERBS =
  /_(list|get|search|lookup|browse|read|stat|history|status|health|info|show|find|query|recent|version)(_|$)/;

export const DESTRUCTIVE_VERBS =
  /_(delete|remove|destroy|purge|kill|drop|clear|wipe|prune|reset)(_|$)/;
