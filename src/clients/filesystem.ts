import { promises as fs } from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

/**
 * Bytes sniffed from the start of a file when deciding whether it's
 * binary. NUL byte in this prefix → binary. Sized to match common
 * binary-detection conventions (file(1) uses larger; ripgrep uses
 * smaller). Adjust if it produces false positives on your files.
 */
const BINARY_SNIFF_BYTES = 8192;

/** Normalize a path to forward slashes so picomatch behaves the same on Windows. */
function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

export interface FilesystemConfig {
  /**
   * Absolute paths the MCP is allowed to operate on. Stored as their
   * realpath() resolution at startup, so symlink-pointing roots are
   * normalized once. Every input path is resolved (including symlinks)
   * and asserted to live under one of these.
   */
  roots: string[];
  /**
   * Glob patterns matched against the basename of any path. Matched
   * basenames are excluded from list results AND rejected for any
   * direct read/stat. Catches "the LLM tries to read .env" leaks.
   */
  denyPatterns: string[];
  /**
   * When false, the tool layer will not register write tools at all.
   * Defense-in-depth on top of the deploy-time decision: even if an
   * attacker registers a write tool, the client's mutation methods
   * also check this flag.
   */
  allowWrite: boolean;
  /** Cap on bytes returned by readFile. 0 disables (not recommended). */
  maxReadBytes: number;
  /** Cap on entries returned by listDirectory. */
  maxListEntries: number;
  /**
   * Hard refusal threshold for fs_copy and the EXDEV fallback in
   * fs_move: source tree may not contain more than this many entries.
   * Protects against operations that would exceed transport timeouts.
   */
  maxCopyEntries: number;
  /**
   * Hard refusal threshold for fs_copy and the EXDEV fallback in
   * fs_move: source tree may not exceed this total byte size.
   */
  maxCopyBytes: number;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size?: number;
  mtime?: string;
}

export interface FileStat {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
  ctime: string;
  mode: string;
  isSymlink: boolean;
  symlinkTarget?: string;
}

export interface DeleteResult {
  /** Resolved path of the target (symlink path itself when input was a symlink). */
  path: string;
  /** What was at that path. */
  type: "file" | "dir" | "symlink" | "other";
  /** Echo of recursive flag. */
  recursive: boolean;
  /** Echo of dry_run. */
  dry_run: boolean;
  /** True iff dry_run was false AND confirm was true (operation actually executed). */
  performed: boolean;
  /** Count of entries that would be (or were) unlinked, including the target itself. */
  paths_to_delete: number;
  /** Sum of file sizes in the subtree. Symlinks count as 0 (link itself, not target). */
  bytes_to_delete: number;
}

export interface CopyResult {
  /** Realpath-resolved canonical source path. */
  from: string;
  /** Resolved-canonical destination path. */
  to: string;
  /** Echo of recursive flag. */
  recursive: boolean;
  /** Echo of dereference flag (whether symlinks are followed). */
  dereference: boolean;
  /** Echo of dry_run. */
  dry_run: boolean;
  /** True iff dry_run was false. */
  performed: boolean;
  /** True when an existing entry at `to` would be (or was) replaced. */
  would_overwrite: boolean;
  /**
   * Count of entries in the source tree (files + dirs + symlinks).
   * Always under config.maxCopyEntries — operations that would exceed
   * are refused before this is returned.
   */
  files_to_copy: number;
  /**
   * Total byte size of files in the source tree. Always under
   * config.maxCopyBytes for the same reason.
   */
  bytes_to_copy: number;
}

export interface MoveResult {
  /** Realpath-resolved canonical source path. */
  from: string;
  /** Resolved-canonical destination path. */
  to: string;
  /** Echo of dry_run. */
  dry_run: boolean;
  /** True iff dry_run was false. */
  performed: boolean;
  /** True when an existing entry at `to` was (or would be) replaced. */
  would_overwrite: boolean;
  /**
   * True when the rename hit EXDEV and fell back to copy+delete. The
   * fallback is NOT atomic — a crash mid-operation leaves both copies.
   * Caller should treat this flag as a "non-atomic move was used."
   */
  cross_device: boolean;
}

export interface MkdirResult {
  /** Realpath-resolved canonical path of the target directory. */
  path: string;
  /** Echo of the recursive flag. */
  recursive: boolean;
  /** Echo of the dry-run flag (true ⇒ nothing was actually created). */
  dry_run: boolean;
  /** True iff dry_run was false (operation executed, even if a no-op). */
  performed: boolean;
  /**
   * Ordered list of paths that would be (or were) created, parent→leaf.
   * Empty when the target already existed as a directory.
   */
  paths_to_create: string[];
}

export interface FindResult {
  /** Path as walked (root-relative when descending through symlinks; the
   * symlink path itself when emitted as a match, never the realpath). */
  path: string;
  type: "file" | "dir" | "symlink" | "other";
}

export interface ReadFileResult {
  /** Realpath-resolved canonical path of the file that was read. */
  path: string;
  /** Total file size in bytes (from stat). */
  size: number;
  /** Bytes actually read into `content` (may be < `size` if capped). */
  bytes_read: number;
  /** Content. UTF-8 decoded for text, base64 for binary. */
  content: string;
  /** True when `bytes_read < size` — caller didn't get the whole file. */
  truncated: boolean;
  /** True when the file was sniffed as binary (and `force_binary` was set). */
  binary: boolean;
}

/**
 * Wraps Node fs/promises with two safety layers:
 *
 *  1. Path scoping. Every input path is resolved (including symlinks)
 *     and asserted to live under one of `config.roots`. Symlink targets
 *     that escape the roots are rejected. Constructed paths that don't
 *     yet exist (e.g. for mkdir) are checked against their parent.
 *
 *  2. Deny-pattern. Basenames matching `config.denyPatterns` are
 *     excluded from list results and rejected outright for direct
 *     read/stat. Default patterns cover common sensitive files
 *     (.env, *.key, id_rsa*, etc.) — see .env.example.
 *
 * Write methods (mkdir, move, copy, delete) check `config.allowWrite`
 * and throw if false (defense-in-depth on top of the
 * tool-registration gate). Each honors a `dryRun` parameter that
 * returns the "would happen" shape without touching the filesystem.
 */
export class FilesystemClient {
  constructor(private readonly config: FilesystemConfig) {}

  // ---- Safety primitives ----

  /**
   * Canonicalize and assert that `inputPath` resolves to a location
   * inside one of the configured roots. Resolves symlinks via
   * fs.realpath. Returns the resolved absolute path.
   *
   * @param mustExist  When false, allows the leaf not to exist (the
   *                   parent must, and must be inside a root). Used
   *                   for paths that will be created (mkdir, move dst).
   */
  async assertWithinRoots(
    inputPath: string,
    mustExist = true,
  ): Promise<string> {
    const absolute = path.resolve(inputPath);
    try {
      const real = await fs.realpath(absolute);
      if (!this.isInRoots(real)) {
        throw new Error(`path escapes configured FS_ROOTS: ${inputPath}`);
      }
      return real;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (mustExist || e.code !== "ENOENT") throw err;

      // Walk up until we find an existing ancestor (handles the
      // recursive-mkdir case where multiple parents may be missing).
      // Verify that ancestor is in roots, then re-join the missing
      // segments so the returned path is the canonical form the caller
      // can use after the missing dirs are created.
      const missing: string[] = [];
      let current = absolute;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) {
          // walked to the filesystem root without finding an ancestor
          throw new Error(`path escapes configured FS_ROOTS: ${inputPath}`);
        }
        missing.unshift(path.basename(current));
        try {
          const real = await fs.realpath(parent);
          if (!this.isInRoots(real)) {
            throw new Error(`path escapes configured FS_ROOTS: ${inputPath}`);
          }
          return path.join(real, ...missing);
        } catch (err2) {
          const e2 = err2 as NodeJS.ErrnoException;
          if (e2.code !== "ENOENT") throw err2;
          current = parent;
        }
      }
    }
  }

  private isInRoots(realPath: string): boolean {
    return this.config.roots.some(
      (root) => realPath === root || realPath.startsWith(root + path.sep),
    );
  }

  /**
   * Throws if the basename matches any deny-pattern. Use for direct
   * file reads / stats. List operations should call
   * `basenameMatchesDeny` to filter rather than throw.
   */
  assertNotDenied(basename: string): void {
    if (this.basenameMatchesDeny(basename)) {
      throw new Error(`path matches FS_DENY_FILE_PATTERNS: ${basename}`);
    }
  }

  basenameMatchesDeny(basename: string): boolean {
    return this.config.denyPatterns.some((pat) => globMatch(basename, pat));
  }

  // ---- Read ops ----

  async listRoots(): Promise<string[]> {
    return [...this.config.roots];
  }

  async listDirectory(
    inputPath: string,
    opts: { maxEntries?: number } = {},
  ): Promise<DirEntry[]> {
    const real = await this.assertWithinRoots(inputPath);
    const cap = Math.min(
      opts.maxEntries ?? this.config.maxListEntries,
      this.config.maxListEntries,
    );
    const dirents = await fs.readdir(real, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const ent of dirents) {
      if (entries.length >= cap) break;
      if (this.basenameMatchesDeny(ent.name)) continue;
      const full = path.join(real, ent.name);
      let size: number | undefined;
      let mtime: string | undefined;
      try {
        const st = await fs.lstat(full);
        if (st.isFile()) size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        // entry vanished between readdir and lstat; skip stat fields
      }
      entries.push({
        name: ent.name,
        type: ent.isSymbolicLink()
          ? "symlink"
          : ent.isDirectory()
            ? "dir"
            : ent.isFile()
              ? "file"
              : "other",
        size,
        mtime,
      });
    }
    return entries;
  }

  async stat(inputPath: string): Promise<FileStat> {
    const real = await this.assertWithinRoots(inputPath);
    this.assertNotDenied(path.basename(real));
    const st = await fs.lstat(real);
    let symlinkTarget: string | undefined;
    if (st.isSymbolicLink()) {
      symlinkTarget = await fs.readlink(real);
    }
    return {
      path: real,
      type: st.isFile()
        ? "file"
        : st.isDirectory()
          ? "dir"
          : st.isSymbolicLink()
            ? "symlink"
            : "other",
      size: st.size,
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
      mode: (st.mode & 0o777).toString(8).padStart(3, "0"),
      isSymlink: st.isSymbolicLink(),
      symlinkTarget,
    };
  }

  /**
   * Read up to `maxBytes` bytes from a regular file. Refuses non-files,
   * deny-pattern basenames, and (by default) anything that looks
   * binary by NUL-byte sniff of the first {@link BINARY_SNIFF_BYTES}.
   *
   * Cap precedence:
   *   - opts.maxBytes if set (the zod schema rejects 0 / negatives)
   *   - else config.maxReadBytes
   *   - if the chosen cap is 0, read the whole file (no cap)
   *
   * Binary content is base64-encoded; text is UTF-8 decoded.
   */
  async readFile(
    inputPath: string,
    opts: { maxBytes?: number; forceBinary?: boolean } = {},
  ): Promise<ReadFileResult> {
    const real = await this.assertWithinRoots(inputPath);
    this.assertNotDenied(path.basename(real));

    const st = await fs.lstat(real);
    if (!st.isFile()) {
      throw new Error(`not a regular file: ${real}`);
    }

    const requestedCap = opts.maxBytes ?? this.config.maxReadBytes;
    const bytesToRead =
      requestedCap === 0 ? st.size : Math.min(requestedCap, st.size);

    const buf = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    if (bytesToRead > 0) {
      const handle = await fs.open(real, "r");
      try {
        const result = await handle.read(buf, 0, bytesToRead, 0);
        bytesRead = result.bytesRead;
      } finally {
        await handle.close();
      }
    }
    const data = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);

    // NUL-byte sniff over the prefix we already have in memory.
    const sniffSlice = data.subarray(
      0,
      Math.min(data.length, BINARY_SNIFF_BYTES),
    );
    const isBinary = sniffSlice.indexOf(0) !== -1;
    if (isBinary && !opts.forceBinary) {
      throw new Error(
        `file looks binary (NUL byte in first ${BINARY_SNIFF_BYTES} bytes); pass force_binary=true to read anyway: ${real}`,
      );
    }

    return {
      path: real,
      size: st.size,
      bytes_read: bytesRead,
      content: isBinary ? data.toString("base64") : data.toString("utf8"),
      truncated: bytesRead < st.size,
      binary: isBinary,
    };
  }

  /**
   * Walk the filesystem from `startPath` (or all configured roots if
   * unset) and return entries whose basename or walk-root-relative path
   * matches `pattern` (picomatch syntax — supports `*`, `**`, `?`,
   * `{a,b}`, `[abc]`).
   *
   * - BFS, single visited set across the whole call (cycle protection
   *   AND cross-root dedup if a symlink in one root targets another).
   * - Symlinks: realpath the target. If it lands in any configured
   *   root, descend (queue the symlink path itself so emitted child
   *   paths stay route-through-the-link); otherwise skip.
   * - Deny-pattern matches are skipped both for emission AND descent.
   * - Cap is global, clamped to `config.maxListEntries`.
   */
  async findByGlob(
    pattern: string,
    opts: { startPath?: string; maxResults?: number } = {},
  ): Promise<FindResult[]> {
    const cap = Math.min(
      opts.maxResults ?? this.config.maxListEntries,
      this.config.maxListEntries,
    );
    const matcher = picomatch(pattern, { matchBase: true });

    const walkRoots: string[] = [];
    if (opts.startPath !== undefined) {
      walkRoots.push(await this.assertWithinRoots(opts.startPath));
    } else {
      walkRoots.push(...this.config.roots);
    }

    const results: FindResult[] = [];
    const visited = new Set<string>();

    for (const root of walkRoots) {
      if (results.length >= cap) break;
      await this.bfsWalk(root, matcher, results, cap, visited);
    }

    return results;
  }

  private async bfsWalk(
    walkRoot: string,
    matcher: (s: string) => boolean,
    results: FindResult[],
    cap: number,
    visited: Set<string>,
  ): Promise<void> {
    const queue: string[] = [walkRoot];

    while (queue.length > 0 && results.length < cap) {
      const dir = queue.shift()!;

      // Cycle protection: realpath the directory we're about to read.
      // Skip if we've seen its real form before. (Catches symlink chains
      // that route back into already-walked territory.)
      let realDir: string;
      try {
        realDir = await fs.realpath(dir);
      } catch {
        continue;
      }
      if (visited.has(realDir)) continue;
      visited.add(realDir);

      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Permission denied, vanished mid-walk, etc. Skip silently.
        continue;
      }

      for (const ent of dirents) {
        if (results.length >= cap) break;
        if (this.basenameMatchesDeny(ent.name)) continue;

        const full = path.join(dir, ent.name);
        const rel = toPosixPath(path.relative(walkRoot, full));
        const isSymlink = ent.isSymbolicLink();
        const isDir = ent.isDirectory();
        const isFile = ent.isFile();

        if (matcher(ent.name) || matcher(rel)) {
          results.push({
            path: full,
            type: isSymlink
              ? "symlink"
              : isDir
                ? "dir"
                : isFile
                  ? "file"
                  : "other",
          });
        }

        if (isDir && !isSymlink) {
          queue.push(full);
        } else if (isSymlink) {
          // Resolve the symlink. Follow only when the target is inside
          // some configured root. Queue the SYMLINK path (not the realpath)
          // so descendant paths stay route-through-the-link;
          // visited-set dedup uses the realpath at dequeue time.
          let target: string;
          try {
            target = await fs.realpath(full);
          } catch {
            continue;
          }
          if (!this.isInRoots(target)) continue;
          if (visited.has(target)) continue;
          try {
            const targetStat = await fs.stat(target);
            if (targetStat.isDirectory()) {
              queue.push(full);
            }
          } catch {
            // dangling, race, permission — skip
          }
        }
      }
    }
  }

  // ---- Write ops ----
  //
  // All write methods:
  //   1. Check `this.config.allowWrite` and throw if false (gates even
  //      dry-runs — the operator turning the flag off means "no preview
  //      either").
  //   2. Validate every path argument with assertWithinRoots() — sources
  //      mustExist=true, destinations mustExist=false.
  //   3. Honor a `dryRun` parameter that returns the "would happen"
  //      shape without touching the filesystem.

  /**
   * Create a directory. Refuses paths outside roots, paths matching
   * deny-patterns, and paths whose existing leaf is a regular file
   * (idempotent only on existing directories). Honors `recursive` and
   * `dryRun`.
   */
  async mkdir(
    inputPath: string,
    opts: { recursive?: boolean; dryRun?: boolean } = {},
  ): Promise<MkdirResult> {
    if (!this.config.allowWrite) {
      throw new Error("write operations are disabled (FS_ALLOW_WRITE=false)");
    }
    const recursive = opts.recursive ?? false;
    const dryRun = opts.dryRun ?? true;

    const target = await this.assertWithinRoots(inputPath, false);
    this.assertNotDenied(path.basename(target));

    // Discover what would be created.
    const pathsToCreate = await this.computeMkdirPlan(target, recursive);

    if (!dryRun && pathsToCreate.length > 0) {
      await fs.mkdir(target, { recursive });
    }

    return {
      path: target,
      recursive,
      dry_run: dryRun,
      performed: !dryRun,
      paths_to_create: pathsToCreate,
    };
  }

  /**
   * Walk from `target` up the parent chain until an existing ancestor
   * is found. Returns the chain of paths-to-create, parent→leaf order.
   * Returns `[]` when target already exists as a directory; throws if
   * target exists as a non-directory or (when !recursive) the parent
   * is missing.
   */
  private async computeMkdirPlan(
    target: string,
    recursive: boolean,
  ): Promise<string[]> {
    try {
      const st = await fs.lstat(target);
      if (st.isDirectory()) return [];
      throw new Error(`exists and is not a directory: ${target}`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
      // Target doesn't exist — fall through to chain discovery.
    }

    if (!recursive) {
      const parent = path.dirname(target);
      try {
        await fs.lstat(parent);
      } catch {
        throw new Error(
          `parent does not exist (use recursive=true to create it): ${parent}`,
        );
      }
      return [target];
    }

    const toCreate: string[] = [];
    let current = target;
    while (true) {
      toCreate.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      try {
        await fs.lstat(parent);
        break;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw err;
        current = parent;
      }
    }
    return toCreate;
  }

  /**
   * Move (rename) `from` → `to`. Atomic via `fs.rename` on the same
   * device; on EXDEV falls back to copy-then-delete (NOT atomic;
   * `cross_device: true` flag in result signals this).
   *
   * Refuses:
   *   - sources that are themselves symlinks (would silently move the
   *     target through the link, leaving a dangling pointer)
   *   - destinations that already exist as a directory (use a different
   *     path; we don't do "move into a dir" semantics)
   *   - destinations that exist as a regular file when `overwrite=false`
   */
  async move(
    fromInput: string,
    toInput: string,
    opts: { overwrite?: boolean; dryRun?: boolean } = {},
  ): Promise<MoveResult> {
    if (!this.config.allowWrite) {
      throw new Error("write operations are disabled (FS_ALLOW_WRITE=false)");
    }
    const overwrite = opts.overwrite ?? false;
    const dryRun = opts.dryRun ?? true;

    // Refuse symlink sources before realpath would silently follow them.
    const fromAbs = path.resolve(fromInput);
    const fromLstat = await fs.lstat(fromAbs).catch(() => null);
    if (fromLstat && fromLstat.isSymbolicLink()) {
      throw new Error(
        `fs_move refuses symlink sources to avoid leaving dangling links; pass the target path directly: ${fromInput}`,
      );
    }

    const from = await this.assertWithinRoots(fromInput, true);
    this.assertNotDenied(path.basename(from));

    const to = await this.assertWithinRoots(toInput, false);
    this.assertNotDenied(path.basename(to));

    // Inspect the destination state.
    let toLstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      toLstat = await fs.lstat(to);
    } catch {
      // doesn't exist — fine
    }
    if (toLstat) {
      if (toLstat.isDirectory()) {
        throw new Error(`destination already exists as a directory: ${to}`);
      }
      if (!overwrite) {
        throw new Error(
          `destination exists; pass overwrite=true to replace: ${to}`,
        );
      }
    }

    const wouldOverwrite = toLstat !== null;

    // Detect cross-device up-front by comparing the source's device id
    // against the destination's parent. The dry_run result reports this
    // accurately (no surprise EXDEV at execution).
    const fromStatForDev = await fs.lstat(from);
    let toParentDev: number | null = null;
    try {
      const toParentStat = await fs.lstat(path.dirname(to));
      toParentDev = toParentStat.dev;
    } catch {
      // parent doesn't exist — assertWithinRoots(to, false) would have
      // already caught a parent-outside-roots case. If it doesn't exist
      // for some other reason, the rename will fail downstream.
    }
    const crossDevice =
      toParentDev !== null && fromStatForDev.dev !== toParentDev;

    // For cross-device moves the fallback is copy+delete — apply the
    // same hard size guard as fs_copy. Same-device renames are O(1)
    // regardless of tree size, so they're unrestricted.
    if (crossDevice) {
      this.assertCopyTreeSizeOK(
        await this.assessCopyTree(
          from,
          this.config.maxCopyEntries + 1,
          this.config.maxCopyBytes + 1,
          false,
        ),
        "fs_move (cross-device)",
      );
    }

    if (!dryRun) {
      try {
        await fs.rename(from, to);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EXDEV") throw err;
        // Cross-device fallback. NOT atomic — flagged via `cross_device`.
        await fs.cp(from, to, {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
        await fs.rm(from, { recursive: true });
      }
    }

    return {
      from,
      to,
      dry_run: dryRun,
      performed: !dryRun,
      would_overwrite: wouldOverwrite,
      cross_device: crossDevice,
    };
  }

  /**
   * Copy `from` → `to`. Walks the source tree to refuse operations
   * that would exceed `config.maxCopyEntries` or `config.maxCopyBytes`
   * (transport-timeout protection — for whole-library moves use rsync
   * directly or iterate per-subdirectory).
   *
   * Refuses non-recursive copy of a directory (caller must opt in).
   * Refuses destinations that exist as a directory regardless of
   * overwrite. Refuses existing file destinations unless overwrite=true.
   *
   * Symlinks: by default copied AS symlinks (link itself is duplicated,
   * target untouched). With dereference=true, the target is followed
   * and a real copy is produced.
   */
  async copy(
    fromInput: string,
    toInput: string,
    opts: {
      recursive?: boolean;
      dereference?: boolean;
      overwrite?: boolean;
      dryRun?: boolean;
    } = {},
  ): Promise<CopyResult> {
    if (!this.config.allowWrite) {
      throw new Error("write operations are disabled (FS_ALLOW_WRITE=false)");
    }
    const recursive = opts.recursive ?? false;
    const dereference = opts.dereference ?? false;
    const overwrite = opts.overwrite ?? false;
    const dryRun = opts.dryRun ?? true;

    // Resolve the source. When dereference=false and the source is a
    // symlink, we must NOT follow the link (otherwise fs.cp would copy
    // the target's bytes instead of duplicating the link). Validate
    // scope via the parent's realpath in that case.
    const fromAbs = path.resolve(fromInput);
    let from: string;
    const fromLstat = await fs.lstat(fromAbs).catch(() => null);
    if (fromLstat && fromLstat.isSymbolicLink() && !dereference) {
      const parentReal = await fs.realpath(path.dirname(fromAbs));
      if (!this.isInRoots(parentReal)) {
        throw new Error(`path escapes configured FS_ROOTS: ${fromInput}`);
      }
      from = path.join(parentReal, path.basename(fromAbs));
    } else {
      from = await this.assertWithinRoots(fromInput, true);
    }
    this.assertNotDenied(path.basename(from));

    const to = await this.assertWithinRoots(toInput, false);
    this.assertNotDenied(path.basename(to));

    // Inspect source — refuse non-recursive copy of a directory.
    const fromStat = await fs.lstat(from);
    if (fromStat.isDirectory() && !recursive) {
      throw new Error(
        `fs_copy refuses to copy a directory without recursive=true: ${from}`,
      );
    }

    // Inspect destination state.
    let toLstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      toLstat = await fs.lstat(to);
    } catch {
      // doesn't exist — fine
    }
    if (toLstat) {
      if (toLstat.isDirectory()) {
        throw new Error(`destination already exists as a directory: ${to}`);
      }
      if (!overwrite) {
        throw new Error(
          `destination exists; pass overwrite=true to replace: ${to}`,
        );
      }
    }
    const wouldOverwrite = toLstat !== null;

    // Walk + size assessment. Refuse if it exceeds limits.
    const summary = await this.assessCopyTree(
      from,
      this.config.maxCopyEntries + 1,
      this.config.maxCopyBytes + 1,
      dereference,
    );
    this.assertCopyTreeSizeOK(summary, "fs_copy");

    if (!dryRun) {
      await fs.cp(from, to, {
        recursive,
        dereference,
        force: overwrite,
        errorOnExist: !overwrite,
        preserveTimestamps: true,
      });
    }

    return {
      from,
      to,
      recursive,
      dereference,
      dry_run: dryRun,
      performed: !dryRun,
      would_overwrite: wouldOverwrite,
      files_to_copy: summary.entries,
      bytes_to_copy: summary.bytes,
    };
  }

  /**
   * BFS walk of `from` accumulating entry count + total bytes.
   * Stops as soon as either cap is exceeded — caller checks
   * `truncated` to decide whether to refuse.
   *
   * Symlinks: when dereference=false, each symlink counts as 1 entry
   * with 0 bytes (the link itself); the walker does not descend into
   * symlinked directories. When dereference=true, the walker follows
   * symlinks via realpath and counts the target's contents.
   */
  private async assessCopyTree(
    from: string,
    entryCap: number,
    byteCap: number,
    dereference: boolean,
  ): Promise<{ entries: number; bytes: number; truncated: boolean }> {
    let entries = 0;
    let bytes = 0;

    const initialStat = dereference
      ? await fs.stat(from)
      : await fs.lstat(from);

    if (!initialStat.isDirectory()) {
      // Regular file or symlink leaf — single-entry copy.
      entries = 1;
      bytes = initialStat.isFile() ? initialStat.size : 0;
      return {
        entries,
        bytes,
        truncated: entries > entryCap || bytes > byteCap,
      };
    }

    // Directory: count it then walk.
    entries = 1;
    const visited = new Set<string>();
    const queue: string[] = [from];

    while (queue.length > 0) {
      if (entries > entryCap || bytes > byteCap) {
        return { entries, bytes, truncated: true };
      }
      const dir = queue.shift()!;

      // Cycle protection (matters when dereferencing).
      try {
        const real = await fs.realpath(dir);
        if (visited.has(real)) continue;
        visited.add(real);
      } catch {
        continue;
      }

      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ent of dirents) {
        entries++;
        if (entries > entryCap) {
          return { entries, bytes, truncated: true };
        }
        const full = path.join(dir, ent.name);

        if (ent.isSymbolicLink()) {
          if (!dereference) continue; // symlink itself: no bytes
          let target;
          try {
            target = await fs.stat(full); // follows link
          } catch {
            continue;
          }
          if (target.isFile()) {
            bytes += target.size;
          } else if (target.isDirectory()) {
            queue.push(full);
          }
        } else if (ent.isFile()) {
          try {
            const st = await fs.lstat(full);
            bytes += st.size;
          } catch {
            // vanished mid-walk
          }
        } else if (ent.isDirectory()) {
          queue.push(full);
        }

        if (bytes > byteCap) {
          return { entries, bytes, truncated: true };
        }
      }
    }

    return { entries, bytes, truncated: false };
  }

  private assertCopyTreeSizeOK(
    summary: { entries: number; bytes: number; truncated: boolean },
    opName: string,
  ): void {
    const overEntries = summary.entries > this.config.maxCopyEntries;
    const overBytes = summary.bytes > this.config.maxCopyBytes;
    if (!overEntries && !overBytes) return;

    const reasons: string[] = [];
    if (overEntries) {
      reasons.push(
        `entry count ${summary.entries}${summary.truncated ? "+" : ""} exceeds limit ${this.config.maxCopyEntries}`,
      );
    }
    if (overBytes) {
      reasons.push(
        `total bytes ${summary.bytes}${summary.truncated ? "+" : ""} exceeds limit ${this.config.maxCopyBytes}`,
      );
    }
    throw new Error(
      `${opName} refused: source tree too large (${reasons.join("; ")}). ` +
        `This MCP does not support large-scale copies because they exceed transport timeouts. ` +
        `For full-library reorganization, use rsync directly. ` +
        `For multiple smaller items, iterate per-subdirectory: enumerate via fs_find_by_glob, then call fs_copy on each result.`,
    );
  }

  /**
   * Delete a file, directory, or symlink. Symlinks are unlinked (the
   * link itself), never traversed — even when encountered mid-tree
   * during a recursive delete. Non-empty directories require
   * `recursive: true`.
   *
   * Two-flag mutation gate: `dry_run=false` AND `confirm=true` are
   * BOTH required to actually delete. This is the only write tool
   * with `confirm` because deletion is the only irreversible op.
   */
  async delete(
    inputPath: string,
    opts: { recursive?: boolean; dryRun?: boolean; confirm?: boolean } = {},
  ): Promise<DeleteResult> {
    if (!this.config.allowWrite) {
      throw new Error("write operations are disabled (FS_ALLOW_WRITE=false)");
    }
    const recursive = opts.recursive ?? false;
    const dryRun = opts.dryRun ?? true;
    const confirm = opts.confirm ?? false;

    if (!dryRun && !confirm) {
      throw new Error(
        "fs_delete refuses to mutate without confirm=true. Set both " +
          "dry_run=false AND confirm=true to actually delete. Use " +
          "dry_run=true to preview paths_to_delete and bytes_to_delete first.",
      );
    }

    // Resolve the target. If it's a symlink, we MUST keep the symlink
    // path intact (otherwise we'd unlink the target file, not the link).
    const targetAbs = path.resolve(inputPath);
    let target: string;
    const targetLstat = await fs.lstat(targetAbs);
    if (targetLstat.isSymbolicLink()) {
      const parentReal = await fs.realpath(path.dirname(targetAbs));
      if (!this.isInRoots(parentReal)) {
        throw new Error(`path escapes configured FS_ROOTS: ${inputPath}`);
      }
      target = path.join(parentReal, path.basename(targetAbs));
    } else {
      target = await this.assertWithinRoots(inputPath, true);
    }
    this.assertNotDenied(path.basename(target));

    const targetType: DeleteResult["type"] = targetLstat.isSymbolicLink()
      ? "symlink"
      : targetLstat.isDirectory()
        ? "dir"
        : targetLstat.isFile()
          ? "file"
          : "other";

    // Walk the tree to count entries + bytes (no caps — fs.rm is fast
    // even on huge trees; transport timeout isn't a risk here).
    // assessCopyTree with dereference=false is the same walk we want:
    // count each entry once, sum file bytes, never follow symlinks.
    const summary = await this.assessCopyTree(
      target,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      false,
    );

    // Refuse non-empty dir without recursive=true. summary.entries
    // includes the target itself (1) plus its descendants. So a
    // non-empty dir has entries > 1.
    if (targetLstat.isDirectory() && summary.entries > 1 && !recursive) {
      throw new Error(
        `directory is not empty (${summary.entries - 1} entries inside); pass recursive=true to delete contents: ${target}`,
      );
    }

    if (!dryRun) {
      // recursive=true handles all cases (file, empty dir, non-empty dir,
      // symlink). fs.rm with recursive does NOT follow symlinks — it
      // unlinks them. force=true silences ENOENT (race-tolerant).
      await fs.rm(target, { recursive: true, force: true });
    }

    return {
      path: target,
      type: targetType,
      recursive,
      dry_run: dryRun,
      performed: !dryRun,
      paths_to_delete: summary.entries,
      bytes_to_delete: summary.bytes,
    };
  }
}

/**
 * Minimal glob matcher for basenames. Supports `*` (any chars except
 * separator) and `?` (single char). NOT a full glob — no `**`, no
 * brace expansion, no character classes. Sufficient for deny-patterns.
 */
function globMatch(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(name);
}
