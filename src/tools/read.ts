import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FilesystemClient } from "../clients/filesystem.js";
import { asJson } from "../shared/text.js";
import { ANN_READ } from "../shared/annotations.js";
import { logged } from "./log-wrap.js";

/**
 * Registers the read-only MCP tools backed by FilesystemClient:
 * fs_list_roots, fs_list_directory, fs_stat, fs_read_file, and
 * fs_find_by_glob. All fully implemented — safety (root containment,
 * deny-patterns, caps) is enforced in the client, not here.
 */
export function registerReadTools(
  server: McpServer,
  fs: FilesystemClient,
): void {
  server.registerTool(
    "fs_list_roots",
    {
      title: "Filesystem: List Configured Roots",
      description:
        "Return the list of absolute paths the MCP is allowed to operate on. Every other tool will refuse paths outside these roots (after symlink resolution). Use this first when you don't know what the user has exposed.",
      inputSchema: {},
      annotations: ANN_READ,
    },
    logged("fs_list_roots", async () => asJson(await fs.listRoots())),
  );

  server.registerTool(
    "fs_list_directory",
    {
      title: "Filesystem: List Directory",
      description:
        "List entries in a directory, paginated. Returns {total, offset, size, items}: total is the full (post-filter) entry count, items is this page, sorted by name for a stable/reproducible order. Each item has name, type (file/dir/symlink/other), size (files only), and mtime. Entries matching FS_DENY_FILE_PATTERNS (e.g. *.env, *.key) are filtered out before total is computed. limit defaults to and is capped by FS_MAX_LIST_ENTRIES — requesting a larger limit THROWS rather than silently truncating; page further with offset instead.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to a directory inside one of the configured FS_ROOTS",
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Number of (post-filter, sorted) entries to skip. Default 0.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Max entries to return. Defaults to and is capped by FS_MAX_LIST_ENTRIES — a larger value throws instead of clamping.",
          ),
      },
      annotations: ANN_READ,
    },
    logged("fs_list_directory", async ({ path: p, offset, limit }) =>
      asJson(await fs.listDirectory(p, { offset, limit })),
    ),
  );

  server.registerTool(
    "fs_stat",
    {
      title: "Filesystem: Stat",
      description:
        "Get metadata (size, mtime, ctime, mode, type) for a single file, directory, or symlink. For symlinks the target is included but NOT followed (use fs_stat on the target separately if you want it). Refuses paths matching FS_DENY_FILE_PATTERNS.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to a file/dir/symlink inside one of the configured FS_ROOTS",
          ),
      },
      annotations: ANN_READ,
    },
    logged("fs_stat", async ({ path: p }) => asJson(await fs.stat(p))),
  );

  server.registerTool(
    "fs_read_file",
    {
      title: "Filesystem: Read File",
      description:
        "Read a file's content. Returns content as UTF-8 text by default. Refuses files that look binary (NUL byte in first 8 KiB) unless force_binary=true, in which case content is base64-encoded — check the `binary` field on the response. Capped at FS_MAX_READ_BYTES (default 1 MiB); pass max_bytes to request fewer. Returns `truncated: true` when the cap was hit. Refuses paths matching FS_DENY_FILE_PATTERNS (e.g. *.env, *.key) and anything that resolves to a non-regular file.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to a regular file inside one of the configured FS_ROOTS",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap on bytes read (also subject to FS_MAX_READ_BYTES). Smaller of the two wins.",
          ),
        force_binary: z
          .boolean()
          .optional()
          .describe(
            "If true, read binary files (returned as base64). Default false — binary files are refused with an error so the caller can decide whether to pull them.",
          ),
      },
      annotations: ANN_READ,
    },
    logged("fs_read_file", async ({ path: p, max_bytes, force_binary }) =>
      asJson(
        await fs.readFile(p, {
          maxBytes: max_bytes,
          forceBinary: force_binary,
        }),
      ),
    ),
  );

  server.registerTool(
    "fs_find_by_glob",
    {
      title: "Filesystem: Find by Glob",
      description:
        "Find paths matching a glob pattern (picomatch syntax — supports **, *, ?, [...], {a,b}). Patterns without a slash match by basename (so '*.mkv' works); patterns with slashes match against the walk-root-relative path. BFS walk with cycle protection, entries visited in name-sorted order per directory. Symlinks are followed if their target lands inside a configured FS_ROOT, skipped otherwise. Honors FS_DENY_FILE_PATTERNS (no descent, no emit). Returns {offset, size, items, truncated} — NOT an exact total: computing one would require walking the entire tree, which this MCP avoids for the same transport-timeout reasons fs_copy refuses huge trees. truncated=true means at least one more match exists past this page; page further with offset. limit defaults to and is capped by FS_MAX_LIST_ENTRIES — a larger value throws rather than silently truncating. When `path` is omitted, walks every configured root.",
      inputSchema: {
        pattern: z
          .string()
          .min(1)
          .describe(
            "Glob pattern (picomatch — supports **, *, ?, [...], {a,b}). No slashes ⇒ basename match.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Starting directory (absolute, inside FS_ROOTS). Defaults to walking every configured root.",
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Number of matches to skip. Default 0."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Max matches to return. Defaults to and is capped by FS_MAX_LIST_ENTRIES — a larger value throws instead of clamping.",
          ),
      },
      annotations: ANN_READ,
    },
    logged("fs_find_by_glob", async ({ pattern, path: p, offset, limit }) =>
      asJson(
        await fs.findByGlob(pattern, {
          startPath: p,
          offset,
          limit,
        }),
      ),
    ),
  );
}
