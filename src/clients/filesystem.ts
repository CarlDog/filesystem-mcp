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
 * Write methods (move/copy/delete/mkdir) are intentionally not
 * implemented in the scaffold — see HANDOFF.md.
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
      if (!mustExist && e.code === "ENOENT") {
        const parent = await fs.realpath(path.dirname(absolute));
        if (!this.isInRoots(parent)) {
          throw new Error(`path escapes configured FS_ROOTS: ${inputPath}`);
        }
        return path.join(parent, path.basename(absolute));
      }
      throw err;
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

  // ---- TODO (see HANDOFF.md): write ops — move, copy, delete, mkdir ----
  // All write methods MUST:
  //   1. Check `this.config.allowWrite` and throw if false.
  //   2. Validate every path argument with assertWithinRoots() —
  //      sources mustExist=true, destinations mustExist=false.
  //   3. Honor a `dryRun` parameter that returns a "would happen"
  //      preview without performing the operation.
  //   4. For destructive ops (delete), refuse to traverse out of a
  //      root via symlink.
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
