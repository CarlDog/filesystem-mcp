# Status

**Last updated:** 2026-05-03

## Phase

All five read tools fully working: `fs_list_roots`, `fs_list_directory`,
`fs_stat`, `fs_read_file`, `fs_find_by_glob`. The four write tools
(`fs_move`, `fs_copy`, `fs_delete`, `fs_mkdir`) remain stubbed. Tests
not yet set up. See [HANDOFF.md](HANDOFF.md) for acceptance criteria
per remaining tool.

## Done

- Repo initialized with TypeScript + MCP SDK + dual-transport entry,
  matching the architectural pattern of the sister MCPs.
- `FilesystemClient` with both safety primitives implemented:
  path-scoping (resolves symlinks, asserts membership in `FS_ROOTS`)
  and deny-pattern (glob match against basename, default covers
  `.env`/`*.key`/`id_rsa*`/etc.).
- All five read tools fully implemented and registered:
  `fs_list_roots`, `fs_list_directory`, `fs_stat`, `fs_read_file`,
  `fs_find_by_glob`.
- `fs_read_file`: NUL-byte sniff over first 8 KiB, base64 for binary,
  UTF-8 for text, single-read with cap precedence (opts.maxBytes >
  config.maxReadBytes; cap=0 disables). Smoke-tested against the live
  NAS with text + binary, capped + uncapped, force_binary on/off.
- `fs_find_by_glob`: picomatch with `matchBase:true` (slashless patterns
  match basename), BFS walk with a single visited set across all roots
  (cycle protection + cross-root dedup), symlinks followed when target
  lands in any configured root, deny-pattern filters both descent and
  emission. Smoke-tested against `/media` for basename, multi-segment
  glob with startPath, and empty-result correctness.
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
- Public GitHub repo at [CarlDog/filesystem-mcp](https://github.com/CarlDog/filesystem-mcp).
  Initial scaffold + .gitattributes pushed; CI workflows green.
- Deployed as Portainer git stack (#152) on `carldog-nas` endpoint 2,
  pulling from `refs/heads/main`. Image:
  `ghcr.io/carldog/filesystem-mcp:latest`. Mount: parameterized via
  `FS_VOLUME` stack env (currently `/volume1/Media:/media:ro`).
  Env: `FS_ROOTS=/media`, all other config at compose defaults
  (write tools disabled).
- Smoke test passes end-to-end: `/health` returns `roots:1, allow_write:false`;
  MCP `initialize` succeeds and `tools/list` exposes the 5 read tools
  (no write tools registered, confirming the env-gate works); real
  `fs_list_directory` against `/media` returns the live Synology share contents.

## Next

See [HANDOFF.md](HANDOFF.md) for the prioritized list with per-tool
acceptance criteria. Summary:

1. ~~Implement `fs_read_file`~~ — done, deployed, smoke-tested.
2. ~~Implement `fs_find_by_glob`~~ — done, deployed, smoke-tested.
3. ~~Smoke-test deploy on the NAS~~ — done. Stack #152 live with
   `FS_VOLUME=/volume1/Media:/media:ro`.
4. Add vitest tests with a temp-dir sandbox helper, before write tools
   land. Once green, wire `npm test` into `test.yml`.
5. Implement write tools, **all gated on `dry_run` default true**, in
   the order: `fs_mkdir` → `fs_move` → `fs_copy` → `fs_delete`.
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
