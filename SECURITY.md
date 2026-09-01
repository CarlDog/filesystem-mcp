# Security Policy

## Supported Versions

Only the latest release receives security fixes — tracked by the `latest` tag
on [`ghcr.io/carldog/filesystem-mcp`](https://github.com/CarlDog/filesystem-mcp/pkgs/container/filesystem-mcp).
There is no LTS branch.

## Reporting a Vulnerability

Please report security issues privately using GitHub's
[Security Advisories](https://github.com/CarlDog/filesystem-mcp/security/advisories/new)
for this repository, rather than opening a public issue.

Expect an initial response within a few days. This is a solo-maintained
project — there's no formal SLA and no bounty, but reports are taken
seriously and fixes for confirmed issues are prioritized over other work.

## What has real impact here

Unlike the other MCP servers in this fleet, this one holds no third-party
credential. **The filesystem access itself is the asset**, so containment is
the whole security model and an escape from it is the highest-impact bug this
project can have.

Two controls do that work:

- **`FS_ROOTS` scoping.** Every path is resolved with `fs.realpath` — so
  symlinks are followed — and then asserted to live under one of the
  configured roots; a symlink whose target escapes is rejected. `FS_ROOTS`
  defaults to the container-side targets of the `FS_VOLUME*` bind mounts, so
  the allowed roots cannot silently drift from what is actually mounted.
- **`FS_ALLOW_WRITE`, default `false`.** Move, copy and delete tools are not
  registered at all until it is explicitly set to `true`.

Worth reporting:

- **Any path that reads, writes, or reveals the existence of something
  outside `FS_ROOTS`** — traversal sequences, symlink or hardlink tricks, a
  TOCTOU race between the realpath check and the operation, Windows
  device/UNC paths, or a case-sensitivity mismatch between the check and the
  filesystem. `fs_stat` and `fs_delete` deliberately observe a *final*
  symlink without traversing it so `isSymlink` / `symlinkTarget` can be
  reported; a way to turn that exception into a read or write of the target
  is a finding.
- **A write reachable with `FS_ALLOW_WRITE=false`**, or a read tool with a
  side effect on disk.
- **A bypass of `FS_DENY_FILE_PATTERNS`**, which is the guard that keeps
  matching files out of reach.
- **Auth bypass on the HTTP transport.** `MCP_AUTH_TOKEN` gates `/mcp` and
  `MCP_ALLOWED_HOSTS` is the Host/Origin allowlist that blocks DNS rebinding
  from a browser on the host network. Binding loopback is *not* a substitute
  in a container — the container's loopback is its own, so the server binds
  `0.0.0.0` to be reachable at all. This matters more here than elsewhere in
  the fleet: reaching this server is reaching a filesystem.

## Deployment notes that are not vulnerabilities

What you mount is what you expose. Mounting a broad host path, mounting
read-write rather than `:ro`, or widening `FS_ROOTS` beyond the mount targets
are operator choices, as is running with `MCP_AUTH_TOKEN` unset on a trusted
network. Combining a broad mount with `FS_ALLOW_WRITE=true` and no auth token
is the configuration to think hardest about, but it is a deployment decision
rather than a defect here.
