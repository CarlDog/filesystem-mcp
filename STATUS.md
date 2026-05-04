# Status

**Last updated:** 2026-05-04

## Phase

**Feature-complete and rolled out.** All nine tools deployed and
registered with the operator's clients:
- Read: `fs_list_roots`, `fs_list_directory`, `fs_stat`,
  `fs_read_file`, `fs_find_by_glob`
- Write: `fs_mkdir`, `fs_move`, `fs_copy`, `fs_delete`

All write tools gated by `FS_ALLOW_WRITE` and default to `dry_run`;
`fs_delete` additionally requires `confirm=true` to actually mutate.
Vitest suite — 76 tests passing on Windows + Linux + macOS in CI
(11 symlink tests skip on Windows). Stack #152 on `your-nas` runs
with `FS_VOLUME=/volume1/Media:/media:rw` and `FS_ALLOW_WRITE=true`;
end-to-end smoke verified mkdir+stat+delete cycle against the live
mount. Wired into Claude Code (user scope) and Claude Desktop config.

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
- `fs_mkdir` implemented: `dry_run` default true, `recursive` opt-in,
  paths_to_create reported parent→leaf, idempotent on existing dirs,
  refuses non-directory targets, deny-pattern checked on basename,
  `FS_ALLOW_WRITE` gates even dry-run. Also generalized
  `assertWithinRoots(p, mustExist=false)` to walk multiple missing
  ancestors (needed for recursive mkdir).
- `fs_move` implemented: rename via `fs.rename` (atomic on same
  device); on EXDEV falls back to copy+delete with `cross_device:true`
  flag (NOT atomic). Refuses symlink sources to avoid dangling links.
  Refuses directory destinations regardless of overwrite. Refuses
  file destinations unless `overwrite=true`. Deny-pattern checked on
  both basenames. Cross-device path detected upfront by comparing
  device IDs; size guard applied to cross-device case.
- `fs_copy` implemented: walks source tree up-front and refuses with
  a clear error if it exceeds `config.maxCopyEntries` (default 10k)
  or `config.maxCopyBytes` (default 500 GiB). Error message points
  the caller at rsync or per-subdirectory iteration via
  fs_find_by_glob. Refuses non-recursive directory copy. Refuses
  directory destinations regardless of overwrite. Symlinks copied
  as symlinks by default (dereference opt-in). Bug fix worth noting:
  `assertWithinRoots` realpath's through symlinks; the copy path
  bypasses that for symlink sources when dereference=false to keep
  the link intact (otherwise fs.cp would copy the target, not the
  link). Same pattern reused by fs_delete.
- `fs_delete` implemented: two-flag mutation gate (`dry_run=false`
  AND `confirm=true` both required to actually delete — only write
  tool with this extra flag, since delete is the only irreversible
  op). Symlinks always unlinked (never traversed) — even mid-tree
  during recursive deletes, so a symlink pointing OUTSIDE FS_ROOTS
  cannot be used to reach external files. Empty dirs delete without
  `recursive`; non-empty dirs require it. No size guard (`fs.rm`
  is fast even on huge trees, unlike fs_copy).
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
  (typecheck/build/test matrix on Linux/Win/macOS + lint/format on
  Linux).
- Vitest test suite (`tests/sandbox.ts` + four feature-scoped files)
  covering safety primitives, list/stat, readFile, findByGlob (30
  tests, 6 symlink-gated tests skip on Windows). Wired into CI via
  `npm test` step in the matrix.
- Project docs: CLAUDE.md, STATUS.md, README.md, HANDOFF.md.
- Public GitHub repo at [CarlDog/filesystem-mcp](https://github.com/CarlDog/filesystem-mcp).
  Initial scaffold + .gitattributes pushed; CI workflows green.
- Deployed as Portainer git stack (#152) on `your-nas` endpoint 2,
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
4. ~~Add vitest tests with a temp-dir sandbox helper~~ — done; CI
   runs `npm test` across all three OSes.
5. ~~Implement write tools~~ — done. `fs_mkdir`, `fs_move`,
   `fs_copy`, `fs_delete` all implemented, tested, CI-green.
6. ~~Enable `FS_ALLOW_WRITE=true` on the deployed stack~~ — done.
   Stack #152 now runs with `:rw` mount and write tools registered.
   Live smoke (mkdir → stat → delete) verified.
7. ~~Wire into Claude Desktop / Claude Code at user scope~~ — done.
   Claude Code: `claude mcp add` user-scope HTTP. Claude Desktop:
   `filesystem` entry in `claude_desktop_config.json` alongside
   sister MCPs.

All HANDOFF.md items closed. Next move-forward work would be
out-of-scope feature additions (e.g. fs_copy_many for batched small
items, env-tunable copy limits, operator-side allowlist refinements).

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

- Container logs returned by `tools/write.ts` stubs hard-code "not
  implemented" — when the dev chat fills them in, replace those error
  throws with real implementations.
