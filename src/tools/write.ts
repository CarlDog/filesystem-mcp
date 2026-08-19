import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FilesystemClient } from "../clients/filesystem.js";
import { asJson } from "../shared/text.js";
import { ANN_DESTRUCTIVE, ANN_EDIT } from "../shared/annotations.js";
import { logged } from "./log-wrap.js";

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
        "Move or rename a path. Both `from` and `to` must resolve under FS_ROOTS, and neither basename may match FS_DENY_FILE_PATTERNS. Refuses symlink sources (would silently move the target through the link, leaving a dangling pointer — pass the realpath directly). Refuses destinations that exist as a directory. Refuses destinations that exist as a regular file unless overwrite=true. Atomic via rename on the same device; on EXDEV falls back to copy+delete with cross_device=true in the response (NOT atomic). Honors dry_run.",
      inputSchema: {
        from: z
          .string()
          .describe(
            "Absolute source path (must exist, must not be a symlink).",
          ),
        to: z
          .string()
          .describe(
            "Absolute destination path. Parent must exist inside FS_ROOTS.",
          ),
        overwrite: z
          .boolean()
          .default(false)
          .describe(
            "Allow replacing an existing regular file at the destination. Never replaces a directory regardless. Default false.",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe(
            "Preview without performing the move. Default true — opt in to actual mutation per call by passing false.",
          ),
      },
      annotations: ANN_DESTRUCTIVE,
    },
    logged("fs_move", async ({ from, to, overwrite, dry_run }) =>
      asJson(
        await fs.move(from, to, {
          overwrite,
          dryRun: dry_run,
        }),
      ),
    ),
  );

  server.registerTool(
    "fs_copy",
    {
      title: "Filesystem: Copy",
      description:
        "Copy a file or directory. Both paths must resolve under FS_ROOTS, and neither basename may match FS_DENY_FILE_PATTERNS. The source tree is walked up-front and the operation is REFUSED if it exceeds the configured per-call limits (FS_MAX_COPY_ENTRIES, FS_MAX_COPY_BYTES) — this MCP is not the right tool for large-scale moves; use rsync or iterate per-subdirectory. Refuses non-recursive copy of a directory. Refuses destinations that exist as a directory. Refuses existing file destinations unless overwrite=true. Symlinks are copied AS symlinks by default (the link itself, not its target); pass dereference=true to follow. Honors dry_run.",
      inputSchema: {
        from: z.string().describe("Absolute source path (must exist)."),
        to: z
          .string()
          .describe(
            "Absolute destination path. Parent must exist inside FS_ROOTS.",
          ),
        recursive: z
          .boolean()
          .default(false)
          .describe(
            "Required when copying a directory tree. Default false — non-recursive copy of a directory throws.",
          ),
        dereference: z
          .boolean()
          .default(false)
          .describe(
            "Follow symlinks during copy (real bytes, not the link). Default false — symlinks are duplicated as symlinks.",
          ),
        overwrite: z
          .boolean()
          .default(false)
          .describe(
            "Allow replacing an existing regular file at the destination. Never replaces a directory regardless. Default false.",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe(
            "Preview without copying anything. Default true — opt in to actual mutation per call by passing false.",
          ),
      },
      // Same shape as fs_move: overwrite=true can replace (destroy) an
      // existing file at the destination, so this carries the same
      // destructiveHint despite never touching the source.
      annotations: ANN_DESTRUCTIVE,
    },
    logged(
      "fs_copy",
      async ({ from, to, recursive, dereference, overwrite, dry_run }) =>
        asJson(
          await fs.copy(from, to, {
            recursive,
            dereference,
            overwrite,
            dryRun: dry_run,
          }),
        ),
    ),
  );

  server.registerTool(
    "fs_delete",
    {
      title: "Filesystem: Delete",
      description:
        "Delete a file, directory, or symlink. Path must resolve inside FS_ROOTS. Symlinks are UNLINKED (the link itself, not its target) — even when encountered mid-tree during a recursive delete. Non-empty directories require recursive=true. TWO flags must be set to actually mutate: both dry_run=false AND confirm=true. This is the only write tool with the confirm flag because deletion is irreversible. Honors dry_run.",
      inputSchema: {
        path: z
          .string()
          .describe("Absolute path to delete (must exist, inside FS_ROOTS)."),
        recursive: z
          .boolean()
          .default(false)
          .describe(
            "Required to delete a non-empty directory. Default false. Symlinks are unlinked regardless (never traversed).",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe(
            "Preview without deleting. Default true. To actually delete, pass dry_run=false AND confirm=true.",
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Belt-and-suspenders flag REQUIRED alongside dry_run=false to actually mutate. Default false. Two independent flags must agree before any irreversible delete is performed.",
          ),
      },
      annotations: ANN_DESTRUCTIVE,
    },
    logged("fs_delete", async ({ path: p, recursive, dry_run, confirm }) =>
      asJson(
        await fs.delete(p, {
          recursive,
          dryRun: dry_run,
          confirm,
        }),
      ),
    ),
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
      annotations: ANN_EDIT,
    },
    logged("fs_mkdir", async ({ path: p, recursive, dry_run }) =>
      asJson(
        await fs.mkdir(p, {
          recursive,
          dryRun: dry_run,
        }),
      ),
    ),
  );
}
