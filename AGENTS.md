# filesystem-mcp

MCP server exposing scoped filesystem operations. Designed primarily as
a companion to media-management MCPs (servarr-mcp, plex-mcp): the LLM
can list/inspect/read files on disk, and — when explicitly enabled —
move/rename/delete them. Path-whitelisted, deny-pattern-aware,
dry-run-by-default writes.

**Fleet standards:** ts-mcp-server v1.1 — audited 2026-08-19

## Status

Single source of truth: [STATUS.md](STATUS.md). Do not duplicate status
into this file, MEMORY.md, or Serena memories — reference STATUS.md.

[HANDOFF.md](HANDOFF.md) is the original scaffold-to-feature-complete
build briefing — design decisions, acceptance criteria, and the
task list a fresh dev chat worked through. All of it has shipped;
kept for the rationale, not as a current-state doc. For what's done,
decided, and next, read STATUS.md.

## Stack

- TypeScript (Node 22+, ESM, `NodeNext` module resolution)
- `@modelcontextprotocol/sdk` v1.x — high-level `McpServer` API
- `zod` for tool input schemas
- `node:fs/promises` directly — no third-party fs library
- Multi-stage Docker build (alpine, non-root user `mcp`)

## Layout

```
filesystem-mcp/
├── src/
│   ├── index.ts                # entry: env parse, transport, McpServer + instructions
│   ├── config.ts               # root parsing/derivation/resolution (parseRoots, deriveRootsFromVolumes, resolveRoots)
│   ├── clients/
│   │   └── filesystem.ts       # FilesystemClient: safety primitives + read/write methods
│   ├── tools/
│   │   ├── index.ts            # registerFilesystemTools — dispatches to read + write
│   │   ├── read.ts             # read tools: list_roots, list_directory, stat, read_file, find_by_glob — all implemented
│   │   ├── write.ts            # write tools: move, copy, delete, mkdir — all implemented; only registered when FS_ALLOW_WRITE=true
│   │   └── log-wrap.ts         # arg-only call logging wrapper (fleet standard)
│   └── shared/                 # canonical fleet ts-mcp-server files (annotations, errors, redact, http-transport, version)
├── tests/                      # vitest suite + tests/sandbox.ts temp-dir fixture helper
├── Dockerfile                  # multi-stage alpine, non-root
├── docker-compose.yml          # HTTP transport, volume mount(s) for media
├── .githooks/pre-commit        # author identity + gitleaks + PII scan
└── (CLAUDE.md, AGENTS.md, STATUS.md, README.md, HANDOFF.md)
```

## Safety model

Two layers, both enforced inside `FilesystemClient`:

1. **Path scoping (`FS_ROOTS`).** Every input path is resolved through
   `fs.realpath` (so symlinks are followed) and rejected if the resolved
   path doesn't live under one of the configured roots. Roots are
   themselves realpath-resolved at startup so symlink-rooted entries are
   normalized once. Non-existent target paths (e.g. for `mkdir`, move
   destinations) are validated against their parent. When `FS_ROOTS` is
   unset, roots default to the container-side targets of the `FS_VOLUME*`
   bind specs (`deriveRootsFromVolumes` in `config.ts`) — one declaration,
   no drift; an explicit `FS_ROOTS` overrides and can only narrow. Startup
   is resilient: an invalid/unmounted root is logged and dropped rather
   than aborting; the server only refuses to start if *no* root survives.
2. **Deny-pattern (`FS_DENY_FILE_PATTERNS`).** Glob patterns matched
   against the basename. List operations silently filter matches; direct
   read/stat throws. Default patterns cover common sensitive file
   shapes (`.env`, `*.key`, `id_rsa*`, etc.).

Defense-in-depth: write tools are not registered at all when
`FS_ALLOW_WRITE=false` (the default), and the client's mutation methods
also check the flag.

## Transport modes

Same dual-transport pattern as the sister MCPs:

- **stdio (default)** — used when `MCP_PORT` is unset. For
  `docker run -i ...` invocation by an MCP client.
- **HTTP (Streamable HTTP)** — used when `MCP_PORT` is set. Server
  listens on `0.0.0.0:$MCP_PORT` with `POST/GET/DELETE /mcp` and
  `GET /health`. Per-session `McpServer` instances via `createServer()`
  factory; the `FilesystemClient` is module-scope.

## Common Commands

```bash
npm install            # install deps
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (requires FS_ROOTS set)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run format         # prettier --write .
docker build -t filesystem-mcp .
```

## Conventions

- All logging goes to **stderr** (`console.error`). stdout is the MCP
  wire protocol.
- Tool names: `fs_<verb_noun>` (e.g. `fs_list_directory`,
  `fs_read_file`). Always snake_case.
- Tool inputs validated with `zod`; outputs through `asText()`.
- Read tools and write tools live in separate files (`tools/read.ts`,
  `tools/write.ts`). The split mirrors the security tier — write tools
  are env-gated, never registered unless `FS_ALLOW_WRITE=true`.
- Mutation methods on the client MUST check `config.allowWrite` and
  throw if false. Defense-in-depth.
- Mutation methods MUST honor a `dry_run` parameter that returns a
  "would happen" preview without performing the operation.
