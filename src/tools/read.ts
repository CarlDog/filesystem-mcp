import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FilesystemClient } from "../clients/filesystem.js";
import { asText } from "../util.js";

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
    },
    async () => asText(await fs.listRoots()),
  );

  server.registerTool(
    "fs_list_directory",
    {
      title: "Filesystem: List Directory",
      description:
        "List entries in a directory. Returns name, type (file/dir/symlink/other), size (files only), and mtime. Entries matching FS_DENY_FILE_PATTERNS (e.g. *.env, *.key) are filtered out silently. Capped at FS_MAX_LIST_ENTRIES; pass max_entries to request fewer.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to a directory inside one of the configured FS_ROOTS",
          ),
        max_entries: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap on entries returned (also subject to FS_MAX_LIST_ENTRIES)",
          ),
      },
    },
    async ({ path: p, max_entries }) =>
      asText(await fs.listDirectory(p, { maxEntries: max_entries })),
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
    },
    async ({ path: p }) => asText(await fs.stat(p)),
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
    },
    async ({ path: p, max_bytes, force_binary }) =>
      asText(
        await fs.readFile(p, {
          maxBytes: max_bytes,
          forceBinary: force_binary,
        }),
      ),
  );

  server.registerTool(
    "fs_find_by_glob",
    {
      title: "Filesystem: Find by Glob",
      description:
        "Find paths matching a glob pattern (picomatch syntax — supports **, *, ?, [...], {a,b}). Patterns without a slash match by basename (so '*.mkv' works); patterns with slashes match against the walk-root-relative path. BFS walk with cycle protection. Symlinks are followed if their target lands inside a configured FS_ROOT, skipped otherwise. Honors FS_DENY_FILE_PATTERNS (no descent, no emit). Capped at max_results (also clamped by FS_MAX_LIST_ENTRIES). When `path` is omitted, walks every configured root.",
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
        max_results: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap on matches returned (also clamped by FS_MAX_LIST_ENTRIES).",
          ),
      },
    },
    async ({ pattern, path: p, max_results }) =>
      asText(
        await fs.findByGlob(pattern, {
          startPath: p,
          maxResults: max_results,
        }),
      ),
  );
}
