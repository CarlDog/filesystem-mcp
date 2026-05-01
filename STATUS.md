# Status

**Last updated:** 2026-05-01

## Phase

Scaffolded. Three working tools (`fs_list_roots`, `fs_list_directory`,
`fs_stat`) prove the env → safety → fs pipeline end-to-end. The
remaining read tools (`fs_read_file`, `fs_find_by_glob`) and all four
write tools (`fs_move`, `fs_copy`, `fs_delete`, `fs_mkdir`) are
registered as stubs that throw "not implemented" — the dev chat fills
them in. See [HANDOFF.md](HANDOFF.md) for acceptance criteria per tool.

## Done

- Repo initialized with TypeScript + MCP SDK + dual-transport entry,
  matching the architectural pattern of the sister MCPs.
- `FilesystemClient` with both safety primitives implemented:
  path-scoping (resolves symlinks, asserts membership in `FS_ROOTS`)
  and deny-pattern (glob match against basename, default covers
  `.env`/`*.key`/`id_rsa*`/etc.).
- Three read tools fully implemented and registered:
  `fs_list_roots`, `fs_list_directory`, `fs_stat`.
- Two read-tool stubs registered (returns "not implemented" error
  when called): `fs_read_file`, `fs_find_by_glob`.
- Four write-tool stubs registered (only when `FS_ALLOW_WRITE=true`):
  `fs_move`, `fs_copy`, `fs_delete`, `fs_mkdir`.
- McpServer ships with a populated `instructions` field (server-level
  prose handed to the LLM at session init) — covers idioms, safety
  story, and composition with sister MCPs.
- Dual transport: stdio (default) + Streamable HTTP (when `MCP_PORT`
  set). Per-session McpServer factory; `/health` endpoint.
- Multi-stage Dockerfile (alpine, non-root user `mcp`).
- `docker-compose.yml` on host port 3006, with a placeholder
  `/volume1/Media:/media:ro` mount and full env passthrough.
- Security baseline: `.gitignore`, `.gitleaks.toml`, `.githooks/pre-commit`
  (author identity + gitleaks + PII pattern scan).
- VS Code workspace config + ESLint 9 flat config + Prettier.
- GitHub Actions: `docker-publish.yml` (multi-arch GHCR) and `test.yml`
  (typecheck/build matrix on Linux/Win/macOS + lint/format on Linux).
- Project docs: CLAUDE.md, STATUS.md, README.md, HANDOFF.md.

## Next

See [HANDOFF.md](HANDOFF.md) for the prioritized list with per-tool
acceptance criteria. Summary:

1. Implement `fs_read_file` (binary detection, byte cap).
2. Implement `fs_find_by_glob` (full glob; honor deny-patterns + roots).
3. Smoke-test deploy on the NAS with a read-only mount.
4. Implement write tools, **all gated on `dry_run` default true**, in
   the order: `fs_mkdir` → `fs_move` → `fs_copy` → `fs_delete`.
5. Add tests once a sandbox dir is set up.
6. Wire into Claude Desktop / Claude Code at user scope.

## Open Decisions

None active. Decisions made during scaffolding (do NOT re-debate in
the dev chat unless evidence shows them wrong):

- **Separate repo, not fold into servarr-mcp.** Filesystem write
  operations are a different security tier than HTTP API reads;
  conflating them pollutes servarr-mcp's trust profile.
- **Read tools first, writes later.** Same pattern as sister MCPs.
- **Path scoping via `FS_ROOTS` env var.** Comma-separated absolute
  paths. Resolved through `realpath` at startup. Every tool call
  re-resolves and asserts membership.
- **Deny-pattern as defense-in-depth.** Stops the LLM from accidentally
  reading `.env` even within the configured roots.
- **Write tools env-gated AND defense-in-depth.** When
  `FS_ALLOW_WRITE=false`, tools aren't even registered. When `true`,
  the client's mutation methods still check the flag.
- **`dry_run` is a tool-level parameter, not server-level.** Default
  should be `true` per acceptance criteria — opt in to mutation per call.
- **Symlinks are resolved, not blocked.** Following symlinks is the
  expected behavior for media library operations (e.g. `/media/Movies`
  symlinking to a different volume). The safety check happens after
  resolution, so symlinks pointing outside `FS_ROOTS` are still rejected.
- **Glob pattern syntax for deny-pattern is intentionally minimal.**
  Supports `*` and `?` only — no `**`, no character classes. Sufficient
  for matching basenames; `fs_find_by_glob` will use a real glob lib
  for its own pattern argument.

## Known Gaps

- No tests yet — `tests/` is empty. Set up vitest with a temp-dir
  sandbox before implementing write tools.
- The `package-lock.json` will be generated on first `npm install`.
- `fs_find_by_glob` will need a glob library — `picomatch` (lightweight)
  or `fast-glob` (full-featured). HANDOFF.md recommends `picomatch`.
- Container logs returned by `tools/write.ts` stubs hard-code "not
  implemented" — when the dev chat fills them in, replace those error
  throws with real implementations.
