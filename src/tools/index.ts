import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FilesystemClient } from "../clients/filesystem.js";
import { registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";

export function registerFilesystemTools(
  server: McpServer,
  fs: FilesystemClient,
  opts: { allowWrite: boolean },
): void {
  registerReadTools(server, fs);
  if (opts.allowWrite) {
    registerWriteTools(server, fs);
  }
}
