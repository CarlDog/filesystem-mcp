// REQUIRED ENFORCEMENT TEST — standard MCP-T02.
//
// Every tool name must carry the server's prefix. This is the mechanism behind
// MCP-P01, and it exists because two servers in the fleet register unprefixed
// names and BOTH define `send_message`: a client with both loaded sees two
// identically-named tools and the model cannot tell them apart.

import { describe, expect, test } from "vitest";
import { CaptureServer } from "./_test_utils.js";
import { registerFilesystemTools, TOOL_PREFIXES } from "./index.js";

function captureAll(): CaptureServer {
  const server = new CaptureServer();
  // Clients are never invoked here — only registered — so a stub is fine.
  // allowWrite: true so the write tools (fs_move/fs_copy/fs_delete/fs_mkdir)
  // register too; otherwise this test would only ever see the 5 read tools.
  registerFilesystemTools(server as never, {} as never, { allowWrite: true });
  return server;
}

describe("tool naming", () => {
  const { tools } = captureAll();

  test("at least one tool is registered", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  test("every tool name starts with a declared prefix", () => {
    const bad = tools
      .filter((t) => !TOOL_PREFIXES.some((p) => t.name.startsWith(`${p}_`)))
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  test("tool names are lower_snake_case", () => {
    const bad = tools
      .filter((t) => !/^[a-z][a-z0-9_]*$/.test(t.name))
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  test("tool names are unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of tools) {
      if (seen.has(t.name)) dupes.push(t.name);
      seen.add(t.name);
    }
    expect(dupes).toEqual([]);
  });

  test("a prefix alone is not a tool name", () => {
    // `fs_` with no verb tells the model nothing about what it does.
    const bare = tools
      .filter((t) =>
        TOOL_PREFIXES.some((p) => t.name === p || t.name === `${p}_`),
      )
      .map((t) => t.name);
    expect(bare).toEqual([]);
  });

  test("registers exactly the 9 documented tools", () => {
    // A count guard: catches an accidental double-registration or a tool
    // silently dropped from registerReadTools/registerWriteTools.
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "fs_list_roots",
        "fs_list_directory",
        "fs_stat",
        "fs_read_file",
        "fs_find_by_glob",
        "fs_move",
        "fs_copy",
        "fs_delete",
        "fs_mkdir",
      ].sort(),
    );
  });
});
