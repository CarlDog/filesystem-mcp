# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The v0.1.0 entry is a backfill (standards UNI-12 / UNI-19) reconstructed from
git history and STATUS.md — this repo shipped to the NAS before it carried a
changelog. From here forward, update this file alongside the work rather than
after the fact.

## [Unreleased]

### Changed

- **`MCP_ALLOWED_HOSTS` matching now handles bracketed IPv6 correctly.**
  `hostAllowed()` split the incoming Host header at the first colon, turning
  `[::1]:3006` into the mangled `[` — bracketed IPv6 could never match. Host
  matching now delegates to the canonical `src/shared/mcp-environment.ts`
  (`parseAllowedHosts`/`requestAuthorityAllowed`, ported from the
  claude-fleet-kit `ts-mcp-server` template, previously present only in
  kindroid-mcp) instead of the ad hoc split-based check. A behavior change
  worth naming: when `MCP_ALLOWED_HOSTS` is unset, the allowlist now falls
  back to `localhost,127.0.0.1,[::1],host.docker.internal` rather than being
  fully open — the canonical module's default is safe-by-default, not
  open-by-default. Startup warning and README updated to match.
- **Package renamed to `@carldog/filesystem-mcp`.** The unscoped name
  `filesystem-mcp` is owned by an unrelated package (Adam Jones /
  `domdomegg`), so it was never available; a scope is reserved to the
  account, so no name inside it can be taken. Nothing is published to npm -
  this ships as a container - so the rename is invisible to consumers;
  `package-lock.json` was regenerated with it.

## [0.1.0] - 2026-08-28

First tagged release. Feature-complete and deployed as stack #152 on the NAS.

### Added

- Nine scoped filesystem tools over MCP, all path-validated against the
  `FS_ROOTS` allowlist with symlinks resolved before the check:
  - Read: `fs_list_roots`, `fs_list_directory`, `fs_stat`, `fs_read_file`,
    `fs_find_by_glob`.
  - Write: `fs_mkdir`, `fs_move`, `fs_copy`, `fs_delete`.
- Write tools are registered only when `FS_ALLOW_WRITE=true`, default to
  `dry_run`, and `fs_delete` additionally requires `confirm=true` to mutate.
- `confirm_name` required on overwrites and deletes (MCP-P06) — the caller
  must name the target, so a transposed path cannot destroy the wrong file.
- `offset`/`limit` pagination on `fs_list_directory` and `fs_find_by_glob`
  (MCP-P03), plus a hard byte cap on reads (`FS_MAX_READ_BYTES`) and on
  `fs_copy`.
- Deny-pattern filtering (`FS_DENY_FILE_PATTERNS`) so sensitive basenames —
  `*.env`, `*.key`, `id_rsa*` — are hidden from listings and refused for
  direct read or stat.
- Dual transport: stdio by default, Streamable HTTP when `MCP_PORT` is set,
  via the fleet-canonical `mountMcpHttp` (MCP-S01/F03).
- Opt-in DNS-rebinding protection (`MCP_ALLOWED_HOSTS`) and an opt-in bearer
  check (`MCP_AUTH_TOKEN`) on the HTTP transport.
- Tool annotations, argument-logging redaction, and content redaction wired
  through all nine tools.
- Vitest suite — 99 tests (11 symlink tests skip on Windows; all 99 run on
  Linux and macOS CI).

### Changed

- `FS_ROOTS` is derived from the container's actual bind mounts rather than
  declared twice, with fail-soft validation: one stale root is logged and
  skipped instead of aborting startup. A single invalid entry under
  `restart: unless-stopped` had previously turned into a crash-loop.
- Moved onto the shared Docker `bridge` network, relieving the NAS's
  exhausted default address pool.

### Security

- `fs_stat` observes symlinks instead of following them.
- Deny patterns match case-insensitively.
- Two safety-control gaps found in a fleet-standards audit closed.
