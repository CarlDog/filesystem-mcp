import { promises as fs } from "node:fs";
import * as path from "node:path";

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

  // ---- TODO (see HANDOFF.md): readFile, findByGlob ----

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
