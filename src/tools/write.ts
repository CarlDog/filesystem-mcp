import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FilesystemClient } from "../clients/filesystem.js";

/**
 * Registers mutation MCP tools backed by FilesystemClient.
 *
 * Only called when FS_ALLOW_WRITE=true at startup. Even then, every
 * tool here is a stub returning a "not implemented" error — see
 * HANDOFF.md for acceptance criteria. Implement them with:
 *
 *   - assertWithinRoots() validation on every path argument
 *     (sources mustExist=true, destinations mustExist=false)
 *   - dry_run support that returns a "would happen" object without
 *     touching the filesystem
 *   - clear, bounded behavior for symlink crossing during recursive
 *     delete (refuse, by default, anything resolving outside roots)
 */
export function registerWriteTools(
  server: McpServer,
  // Underscore prefix: client is unused in the scaffold stubs but the
  // dev chat will need it for real implementations.
  _fs: FilesystemClient,
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
        "[NOT YET IMPLEMENTED — see HANDOFF.md] Create a directory. Path's parent must exist under FS_ROOTS. With recursive=true, creates intermediate parents (each must remain under FS_ROOTS). Honors `dry_run`.",
      inputSchema: {
        path: z.string(),
        recursive: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async () => {
      throw new Error(
        "fs_mkdir not implemented yet — see HANDOFF.md for acceptance criteria",
      );
    },
  );
}
