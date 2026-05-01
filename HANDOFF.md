# filesystem-mcp — handoff to development chat

You're picking this up cold. Read this in full before touching code.
The scaffold is solid; design decisions have been made; what's left is
mostly mechanical — but the safety story matters, so the *how* of each
implementation matters more than usual.

## What this is

An MCP server that gives an LLM scoped read/write access to a
filesystem. Designed for media-library organization (companion to
`servarr-mcp` and `plex-mcp`), but useful anywhere an agent needs to
inspect files behind a controlled boundary.

The agent that orchestrates is the LLM. This MCP doesn't try to be
smart about media types or *arr semantics — it exposes filesystem
primitives (list, stat, read, glob, move, copy, delete, mkdir) and
trusts the agent to compose them.

## State at handoff

- ✅ **Repo scaffolded** — package.json/tsconfig/Dockerfile/compose, CI
  (multi-arch GHCR + cross-OS test matrix), VS Code workspace, ESLint
  9 flat config, Prettier, pre-commit (gitleaks + author + PII), all
  in place and matching the sister MCPs.
- ✅ **`FilesystemClient` safety primitives implemented**
  (`src/clients/filesystem.ts`):
  - `assertWithinRoots(path, mustExist?)` — resolves symlinks, checks
    membership in `FS_ROOTS`. Returns the canonical path for
    downstream use.
  - `assertNotDenied(basename)` and `basenameMatchesDeny(basename)` —
    glob match against `FS_DENY_FILE_PATTERNS`.
  - These are the foundation for every other op. Don't reimplement.
- ✅ **Three read tools fully working**: `fs_list_roots`,
  `fs_list_directory`, `fs_stat`. Use them as references for the
  remaining tools — they show the safety-call → fs-call pattern.
- ✅ **Server-level `instructions`** populated with the safety model
  and composition idiom. Visible to the LLM on initialize.
- ✅ **Dual transport** (stdio + HTTP), `/health` endpoint, env-var
  parsing with validation (FS_ROOTS resolution, integer parsing,
  empty-vs-absent for deny-patterns).
- 🟡 **Two read tools stubbed**: `fs_read_file`, `fs_find_by_glob`
  (registered, throw on call).
- 🟡 **Four write tools stubbed**: `fs_move`, `fs_copy`, `fs_delete`,
  `fs_mkdir`. Only registered when `FS_ALLOW_WRITE=true`.
- 🟡 **No tests** — `tests/` is empty. Add vitest before write tools.
- 🔴 **Not deployed.** No GitHub repo created, no GHCR image, not on
  the NAS.

## Decisions already made (do NOT re-debate)

These were settled during design discussion in the originating chat.
Re-debating burns time without yielding anything new. If you find
real evidence one is wrong, raise it explicitly with the user.

- **Separate from servarr-mcp.** Different security tier. Folding them
  pollutes servarr-mcp's trust profile.
- **Path scoping via `FS_ROOTS`.** Realpath-resolved at startup,
  asserted on every call.
- **Deny-pattern in addition to scoping.** Stops accidental `.env` reads
  inside an allowed root.
- **Read-only first, writes opt-in.** `FS_ALLOW_WRITE=false` by default;
  write tools aren't registered when false. Mutation methods on the
  client also check the flag (defense-in-depth).
- **`dry_run` defaults true** per write tool. Caller opts into the
  mutation per call.
- **Symlinks are followed, not blocked.** The safety check happens
  *after* resolution, so symlinks pointing outside `FS_ROOTS` are
  still rejected. Following inside-roots symlinks is the expected
  behavior for media libraries.
- **Glob lib for `fs_find_by_glob`: `picomatch`.** Lightweight,
  no native deps, zero transitive deps in the runtime. Don't pull
  `fast-glob` or `glob` unless you find a concrete reason.
- **Tool layer split into `read.ts` and `write.ts`.** The split mirrors
  the security tier. Don't fold them back together.

## What to build, in order

### 1. `fs_read_file` — implement (read.ts + filesystem.ts)

**Signature:**
```ts
async readFile(
  inputPath: string,
  opts?: { maxBytes?: number; forceBinary?: boolean }
): Promise<{ path: string; size: number; bytes_read: number; content: string; truncated: boolean; binary: boolean }>;
```

**Acceptance criteria:**
- Resolves path with `assertWithinRoots(p)`, then `assertNotDenied(basename)`.
- Refuses anything that's not a regular file (symlinks already
  resolved by realpath; if the *target* isn't a file, throw).
- Reads up to `min(opts.maxBytes ?? config.maxReadBytes, st.size)`
  bytes. If `config.maxReadBytes === 0`, no cap.
- Returns `truncated: true` when `bytes_read < st.size`.
- Detects binary via NUL byte in the first 8 KiB. Throws unless
  `forceBinary=true`. Binary content is base64-encoded.
- Text content is UTF-8 decoded.

### 2. `fs_find_by_glob` — implement (read.ts + filesystem.ts)

**Add `picomatch` to deps**: `npm install picomatch && npm install -D @types/picomatch`.

**Signature:**
```ts
async findByGlob(
  pattern: string,
  opts?: { startPath?: string; maxResults?: number }
): Promise<Array<{ path: string; type: "file" | "dir" | "symlink" | "other" }>>;
```

**Acceptance criteria:**
- If `startPath` is provided, resolve with `assertWithinRoots(startPath)`
  and walk from there. Otherwise walk all configured roots in order.
- Walk is BFS with cycle protection (track visited realpaths).
- Match basenames AND full paths (relative to the walk root) against
  `picomatch(pattern)`.
- Filter out anything matching `basenameMatchesDeny`.
- Cap at `maxResults` (default `config.maxListEntries`).
- Symlinks: follow if the target is inside a root; skip otherwise.

### 3. Smoke-test deploy

Before write tools — get the read path running on the NAS so you
can validate the safety story against real media volumes. Steps in
order:

1. `gh repo create CarlDog/filesystem-mcp --public --source=. --remote=origin --push`
2. Wait for `docker-publish.yml` workflow to push `ghcr.io/carldog/filesystem-mcp:latest`.
3. Flip the GHCR package to public (or check that it auto-flipped).
4. Deploy as a Portainer stack. Two ways:
   - Use `portainer-mcp`'s `portainer_create_git_stack` tool. It now
     exists in the deployed portainer-mcp.
   - Or do it via the Portainer UI / API directly.
5. Compose env: `FS_ROOTS=/media`. Mount: `/volume1/Media:/media:ro`.
6. Verify health: `curl http://your-nas:3006/health`.
7. Verify a tool round-trip: initialize via curl + call
   `fs_list_directory` for `/media`. Confirm the dirent list comes
   back and that anything matching deny-patterns is filtered.

### 4. Tests (vitest)

Set up vitest with a temp-dir sandbox helper:
- Each test gets a fresh dir under `os.tmpdir()`.
- Helper builds a fixture tree from a JS object spec.
- Helper instantiates `FilesystemClient` with that dir as the only root.

Cover at minimum:
- `assertWithinRoots`: path inside root, path outside root, symlink
  inside root pointing inside, symlink inside root pointing OUTSIDE
  (must reject), non-existent path with `mustExist=false`.
- `assertNotDenied`: matched and unmatched basenames, with default
  patterns and with custom patterns.
- `listDirectory`: filters deny matches; respects cap.
- `stat`: file, directory, symlink (with target).
- `readFile`: under cap, over cap (truncated), binary (refuses
  without `forceBinary`), binary (base64 with `forceBinary`).
- `findByGlob`: matches in deeply nested dirs; skips deny-pattern;
  respects start path; respects cap.

Once tests are passing, add `npm test` to `test.yml` so CI runs them.

### 5. Write tools

**ALL of them**:
- Take `dry_run: boolean` parameter (default true). Schema-level.
- Validate every path with `assertWithinRoots`. Sources `mustExist=true`,
  destinations `mustExist=false`.
- When `dry_run=true`, return an object describing what *would* happen.
  Don't touch the filesystem. Tests must verify this.
- When `dry_run=false`, perform the operation. Return the same shape
  with a `performed: true` flag set.
- Methods on the client also check `config.allowWrite` and throw if
  false.

Implementation order (low→high blast radius):

#### `fs_mkdir`
- Resolve path with `mustExist=false`. Parent must already exist
  inside roots.
- `recursive: boolean` (default false). When true, all created
  intermediate parents must remain inside roots.
- Dry-run: return the list of paths that would be created.

#### `fs_move`
- Resolve `from` (`mustExist=true`), `to` (`mustExist=false`).
- If `to` exists and is a regular file, fail unless caller passes
  `overwrite: true` (no overwrite by default).
- Cross-device: detect via `EXDEV` and fall back to copy+delete; emit
  a warning in the response.
- Dry-run: return `{ from, to, would_overwrite, cross_device }`.

#### `fs_copy`
- Same path validation as move.
- Recursive flag for directories. Refuse non-recursive copy of a dir.
- Symlinks: copy as symlink (don't dereference), unless caller passes
  `dereference: true`.
- Dry-run: return file count + total bytes that would be copied.

#### `fs_delete`
- Resolve path with `mustExist=true`.
- `recursive: boolean` (default false). Required for non-empty dirs.
- Symlinks: unlink the symlink itself; don't traverse the target.
- During recursive delete, refuse to traverse out of roots via
  symlinks (use `lstat`, not `stat`, when descending).
- Dry-run: return path count + total bytes that would be deleted.

### 6. Wire into clients

After deploy + smoke + write tools:

```bash
# Claude Code (user scope)
claude mcp add --transport http --scope user filesystem http://your-nas:3006/mcp
```

```json
// Claude Desktop (claude_desktop_config.json)
"filesystem": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://your-nas:3006/mcp", "--allow-http"]
}
```

## Reference patterns from sister repos

- **Two-tier tool split**: see `servarr-mcp/src/tools/<app>/index.ts`
  for the per-app pattern. We use a per-tier split (read vs write)
  instead, but the registration shape is the same.
- **Path validation**: nothing in the sister repos does fs scoping;
  this is the new bit. Treat `FilesystemClient.assertWithinRoots`
  as the canonical example for any future scoped-resource MCP.
- **Dual transport boilerplate**: `src/index.ts` is copy-paste from
  `servarr-mcp/src/index.ts` with the McpServer name / instructions /
  registerFilesystemTools swapped. If the sister repos evolve their
  transport handling, port forward.
- **Server `instructions` field**: matches the convention shipped to
  plex/servarr/downloader/portainer in the same chat that created
  this scaffold. Keep that idiom.

## First commands you'll run

```bash
cd D:/GitHub/filesystem-mcp
npm install
cp .env.example .env

# Edit .env — at minimum set FS_ROOTS to a local sandbox dir.
# Suggestion: mkdir /tmp/fs-mcp-sandbox && touch /tmp/fs-mcp-sandbox/{a.txt,.env-secret}
# Then FS_ROOTS=/tmp/fs-mcp-sandbox

npm run typecheck   # should pass
npm run lint        # should pass
npm run build       # should produce dist/index.js etc.
npm run dev         # should bind stdio. Ctrl+C to exit.

# HTTP smoke (in another terminal):
MCP_PORT=3000 FS_ROOTS=/tmp/fs-mcp-sandbox npm run dev
curl -s http://localhost:3000/health | jq
```

## Open questions for you to resolve

These are intentionally not pre-decided — they need real evidence the
existing patterns don't yet cover.

- **Glob library decision is "decided" as `picomatch` but verify** it
  meets your needs once you implement `fs_find_by_glob`. If you hit
  a real limitation, switch to `fast-glob`.
- **Binary-detection threshold (8 KiB) for `fs_read_file`** is a
  reasonable default. Audio metadata sniffing tools use 4 KiB; the
  Linux `file` command uses 256 KiB. Adjust if it produces false
  positives on your media files.
- **Symlink behavior on recursive delete** — the spec above says
  refuse to traverse out of roots via symlinks. Edge case: a symlink
  *inside* roots pointing to *another location inside roots*. Should
  recursive delete follow it? Default behavior I'd recommend: no
  (use `lstat`, never traverse symlinks during delete). Confirm with
  user before implementing if you read this differently.
- **Should `fs_list_directory` support `recursive: true`?** The
  scaffold left it non-recursive — recursive listing is what
  `fs_find_by_glob` is for. Adding recursion to list_directory creates
  two ways to do the same thing. Skip unless there's a real need.
- **Atomic move semantics across mounts.** The spec above says
  fall back to copy+delete on EXDEV with a warning. That's not atomic
  — mid-operation crash leaves both copies. Acceptable for media-
  organization use; flag in response.

## When you're done

Update STATUS.md (move items from "Next" to "Done"), update README's
status table (drop the "🟡 stub" markers as tools land), and update
CLAUDE.md if any architectural decisions change. Then ship a PR or
push directly to main per your discipline.

Good luck.
