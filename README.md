# filesystem-mcp

An [MCP](https://modelcontextprotocol.io) server exposing scoped
filesystem operations — list, stat, read, glob, and (optionally)
move/copy/delete. Designed as a companion to media-management MCPs
([`servarr-mcp`](https://github.com/CarlDog/servarr-mcp),
[`plex-mcp`](https://github.com/CarlDog/plex-mcp)) so an agent can
reconcile "what should be on disk" against "what's actually there",
and — when explicitly enabled — fix the differences.

> **All five read tools and four write tools implemented.** Write
> tools default to `dry_run=true`; `fs_delete` additionally requires
> `confirm=true`. The deployed stack exposes only the read tools
> until `FS_ALLOW_WRITE=true` is flipped explicitly.

## Tools

### Read (always available)

| Tool | Status | Description |
| --- | --- | --- |
| `fs_list_roots` | ✅ implemented | List the absolute paths the MCP is allowed to operate on |
| `fs_list_directory` | ✅ implemented | List entries in a directory (filters deny-patterns) |
| `fs_stat` | ✅ implemented | Get metadata for a file/dir/symlink |
| `fs_read_file` | ✅ implemented | Read file content (binary-aware, byte-capped) |
| `fs_find_by_glob` | ✅ implemented | Find paths matching a glob pattern under a root |

### Write (only when `FS_ALLOW_WRITE=true`)

| Tool | Status | Description |
| --- | --- | --- |
| `fs_move` | ✅ implemented | Move or rename a path (`dry_run` defaults true) |
| `fs_copy` | ✅ implemented | Copy a file or directory (`dry_run` defaults true; refuses trees over 10k entries / 500 GiB) |
| `fs_delete` | ✅ implemented | Delete a path (`dry_run` defaults true; `recursive` opt-in for non-empty dirs; **`confirm: true` REQUIRED alongside `dry_run: false` to actually mutate**) |
| `fs_mkdir` | ✅ implemented | Create a directory (`dry_run` defaults true; recursive opt-in) |

## Configuration

| Var | Required | Notes |
| --- | --- | --- |
| `FS_ROOTS` | no | Comma-separated absolute paths the MCP may operate on. **Defaults to the container-side targets of the `FS_VOLUME*` mounts** when unset — set it explicitly only to _narrow_ below the full mount list. |
| `FS_ALLOW_WRITE` | no | `true` to register write tools. Default `false`. |
| `FS_DENY_FILE_PATTERNS` | no | Glob patterns (basename) excluded from list/read. Default covers `.env`, `*.key`, `id_rsa*`, etc. Empty value disables. |
| `FS_MAX_READ_BYTES` | no | Cap on `fs_read_file` (default 1 MiB; 0 disables) |
| `FS_MAX_LIST_ENTRIES` | no | Cap on `fs_list_directory` (default 1000) |
| `MCP_PORT` | no | Set to enable HTTP transport. Unset = stdio. |
| `FS_VOLUME` | yes (compose only) | `host:container[:flags]` bind spec consumed by `docker-compose.yml`. Ignored by `npm run dev`. |

## Safety model

Two enforcement layers inside `FilesystemClient`:

1. **Path scoping.** Every input path is resolved with
   `fs.realpath` (so symlinks are followed) and asserted to live under
   one of `FS_ROOTS`. Symlink targets that escape are rejected.
2. **Deny-pattern.** Basenames matching `FS_DENY_FILE_PATTERNS` are
   silently filtered from list results and refused for direct read/stat.

Plus a third on top, by deployment shape: **only mount what you want
exposed.** The container only sees what `docker-compose.yml` mounts.
`FS_ROOTS` then scopes inside that — and by default it _is_ the mount
list (derived from the `FS_VOLUME*` targets), so the roots can't
silently drift from what's actually mounted. An explicit `FS_ROOTS`
overrides the default and can only narrow the exposed set (a root that
isn't backed by a real directory in the container is logged and dropped
at startup rather than crashing the server).

## Transport modes

| Mode | When | How |
| --- | --- | --- |
| stdio | Direct invocation by Claude Desktop / MCP client | `docker run -i --rm ... filesystem-mcp` (no `MCP_PORT`) |
| Streamable HTTP | Long-lived deploy (Portainer, Compose, k8s) | Set `MCP_PORT=3000` (already set in `docker-compose.yml`) |

> HTTP mode has **no MCP auth**. Bind only to a private network.

## Run with Docker Compose

```bash
# Required: bind spec for the container's data mount, host:container[:flags]
export FS_VOLUME=/volume1/Media:/media:ro
# Optional: FS_ROOTS defaults to the FS_VOLUME* targets (here, /media).
# Set it only to narrow, e.g. expose a subtree of a broader mount.
# export FS_ROOTS=/media
# export FS_ALLOW_WRITE=true
# export HOST_PORT=3006

docker compose up
```

The MCP endpoint will be at `http://<host>:${HOST_PORT:-3006}/mcp`.

`FS_VOLUME` is required at deploy time — compose fails loudly if
unset rather than silently mounting nothing. There is no default
because deployment paths vary (`/volume1/Media` is Synology-specific;
`/srv/...` for many Linux setups; etc.).

For multi-root deploys, `FS_VOLUME_2` and `FS_VOLUME_3` slots are
already wired into the compose. Set them to additional bind specs
(same `host:container[:flags]` format) and the roots follow
automatically — no second declaration to keep in sync. Unset slots
default to a no-op `/dev/null:/dev/null:ro` sentinel mount (skipped
when deriving roots). To expose only a subtree of a mount, set
`FS_ROOTS` explicitly, e.g. mount `/volume1/docker:/docker` but set
`FS_ROOTS=/media,/docker/portainer-ce` to scope down.

## Use with Claude Desktop / Claude Code

```json
// Claude Desktop (claude_desktop_config.json)
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://nas.local:3006/mcp", "--allow-http"]
    }
  }
}

// Claude Code (user-scope)
// claude mcp add --transport http --scope user filesystem http://nas.local:3006/mcp
```

## Local development

```bash
npm install
cp .env.example .env  # then edit FS_ROOTS to a local sandbox dir
FS_ROOTS=/tmp/fs-mcp-sandbox npm run dev
```

## Security

- Container runs as a non-root user (`mcp`).
- Read paths and patterns enforced by `FilesystemClient`, not the tool
  layer — tools cannot bypass.
- Pre-commit hook runs gitleaks + author-identity + PII pattern scan.

## License

TBD.
