import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FilesystemClient } from "../clients/filesystem.js";
import { asText } from "../util.js";

/**
 * Registers mutation MCP tools backed by FilesystemClient.
 *
 * Only called when FS_ALLOW_WRITE=true at startup. Each tool takes a
 * `dry_run` parameter that defaults to true at the schema level —
 * callers must opt into actual mutation per call. Path arguments are
 * validated with `assertWithinRoots()` (sources mustExist=true,
 * destinations mustExist=false) and `assertNotDenied()` for basenames.
 */
export function registerWriteTools(
  server: McpServer,
  fs: FilesystemClient,
): void {
  server.registerTool(
    "fs_move",
    {
      title: "Filesystem: Move/Rename",
      description:
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Move or rename a path. Both `from` and `to` must resolve under FS_ROOTS. Cross-device moves should fall back to copy+delete. Honors `dry_run`.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview without performing the move (default true)"),
      },
    },
    async () => {
      throw new Error(
        "fs_move not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );

  server.registerTool(
    "fs_copy",
    {
      title: "Filesystem: Copy",
      description:
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Copy a file or directory. Both `from` and `to` must resolve under FS_ROOTS. For directories, copy is recursive. Honors `dry_run`.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        recursive: z
          .boolean()
          .optional()
          .describe("Required for directories. Default false."),
        dry_run: z.boolean().optional(),
      },
    },
    async () => {
      throw new Error(
        "fs_copy not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );

  server.registerTool(
    "fs_delete",
    {
      title: "Filesystem: Delete",
      description:
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Delete a file or directory. Path must resolve under FS_ROOTS. For directories, recursive=true required. Symlinks are removed by unlinking the link itself; targets are NOT followed. Honors `dry_run`.",
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async () => {
      throw new Error(
        "fs_delete not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );

  server.registerTool(
    "fs_mkdir",
    {
      title: "Filesystem: Make Directory",
      description:
        "Create a directory. The target path must resolve inside one of the configured FS_ROOTS, and its basename must not match FS_DENY_FILE_PATTERNS. With recursive=true, missing parent directories are created in one operation. Idempotent on an existing directory (returns paths_to_create=[]); refuses if the target already exists as a regular file. Returns the path list it would (or did) create. Honors dry_run.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to the directory to create (parent must already exist unless recursive=true).",
          ),
        recursive: z
          .boolean()
          .default(false)
          .describe(
            "Create missing parent directories. Default false — non-recursive mkdir requires the parent to already exist.",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe(
            "Preview without creating anything. Default true — opt in to actual mutation per call by passing false.",
          ),
      },
    },
    async ({ path: p, recursive, dry_run }) =>
      asText(
        await fs.mkdir(p, {
          recursive,
          dryRun: dry_run,
        }),
      ),
  );
}
