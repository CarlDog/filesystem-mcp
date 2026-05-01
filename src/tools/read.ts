import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FilesystemClient } from "../clients/filesystem.js";
import { asText } from "../util.js";

/**
 * Registers read-only MCP tools backed by FilesystemClient.
 *
 * Two tools are fully implemented in the scaffold to prove the
 * env-var → path-validation → fs pipeline works end-to-end:
 *   - fs_list_roots
 *   - fs_list_directory
 *   - fs_stat
 *
 * The remainder are wired as registered tools that return a
 * "not implemented" error, so the dev chat can pick them up
 * incrementally without re-doing tool registration boilerplate.
 * See HANDOFF.md for signatures + acceptance criteria.
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
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Read the full content of a file (capped at FS_MAX_READ_BYTES). Refuses binary files (heuristic: NUL byte in first 8KB) unless force_binary=true. Refuses paths matching FS_DENY_FILE_PATTERNS.",
      inputSchema: {
        path: z.string(),
        max_bytes: z.number().int().positive().optional(),
        force_binary: z.boolean().optional(),
      },
    },
    async () => {
      throw new Error(
        "fs_read_file not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );

  server.registerTool(
    "fs_find_by_glob",
    {
      title: "Filesystem: Find by Glob",
      description:
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Find paths matching a glob pattern (e.g. '**/*.mkv') under a starting directory. Honors FS_DENY_FILE_PATTERNS. Capped at max_results.",
      inputSchema: {
        pattern: z
          .string()
          .describe(
            "Glob pattern (full glob — supports **, *, ?, [...], {a,b})",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Starting directory (absolute, inside FS_ROOTS). Defaults to all configured roots.",
          ),
        max_results: z.number().int().positive().optional(),
      },
    },
    async () => {
      throw new Error(
        "fs_find_by_glob not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );
}
