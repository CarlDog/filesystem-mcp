// REQUIRED ENFORCEMENT TEST — standard MCP-T01.
//
// Every tool must declare MCP annotations, and they must agree with what the
// tool's name says it does. This is the mechanism behind MCP-P02: a convention
// that is only written down gets forgotten on the next tool added, and the
// failure is invisible until a client fails to prompt before something
// destructive.
//
// Adapted from servarr-mcp's annotations.test.ts — the fleet's only
// CI-enforced convention as of the 2026-07-24 survey, and the pattern this
// whole standards effort generalizes.

import { describe, expect, test } from "vitest";
import { CaptureServer } from "./_test_utils.js";
import { registerFilesystemTools } from "./index.js";
import { DESTRUCTIVE_VERBS, READ_VERBS } from "../shared/annotations.js";

// fs_move/fs_copy can overwrite (destroy) an existing file at the
// destination, but neither name matches the shared DESTRUCTIVE_VERBS list
// (delete/remove/destroy/...) — extended locally per that file's own
// "tighten, don't loosen" guidance.
const LOCAL_DESTRUCTIVE_TOOLS = new Set(["fs_move", "fs_copy"]);

function captureAll(): CaptureServer {
  const server = new CaptureServer();
  // Clients are never invoked here — only registered — so stub values are
  // fine. allowWrite: true so the write tools register too.
  registerFilesystemTools(server as never, {} as never, { allowWrite: true });
  return server;
}

describe("tool annotations", () => {
  const { tools } = captureAll();

  test("at least one tool is registered (guards against a silent no-op)", () => {
    // Without this, every assertion below would vacuously pass if
    // registerFilesystemTools ever stopped registering anything.
    expect(tools.length).toBeGreaterThan(0);
  });

  test("every tool declares an annotations object", () => {
    const missing = tools
      .filter((t) => !t.config.annotations)
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  test("every tool declares a title and a description", () => {
    const incomplete = tools
      .filter((t) => !t.config.title || !t.config.description)
      .map((t) => t.name);
    expect(incomplete).toEqual([]);
  });

  test("read-verb tools are marked readOnlyHint: true", () => {
    const wrong = tools
      .filter((t) => READ_VERBS.test(t.name))
      .filter((t) => t.config.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    expect(wrong).toEqual([]);
  });

  test("destructive-verb tools are marked destructiveHint: true", () => {
    const wrong = tools
      .filter(
        (t) =>
          DESTRUCTIVE_VERBS.test(t.name) || LOCAL_DESTRUCTIVE_TOOLS.has(t.name),
      )
      .filter((t) => t.config.annotations?.destructiveHint !== true)
      .map((t) => t.name);
    expect(wrong).toEqual([]);
  });

  test("a destructive tool is never also readOnlyHint", () => {
    // Contradictory hints are worse than absent ones: a client that trusts
    // readOnlyHint will skip its confirmation prompt entirely.
    const contradictory = tools
      .filter(
        (t) =>
          t.config.annotations?.destructiveHint === true &&
          t.config.annotations?.readOnlyHint === true,
      )
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  test("non-read tools declare destructiveHint explicitly", () => {
    // Undefined destructiveHint on a write tool means the client has to guess.
    // Writes must say so either way — false is a valid, deliberate answer.
    const unspecified = tools
      .filter((t) => t.config.annotations?.readOnlyHint !== true)
      .filter((t) => t.config.annotations?.destructiveHint === undefined)
      .map((t) => t.name);
    expect(unspecified).toEqual([]);
  });

  test("fs_mkdir is idempotent and non-destructive", () => {
    // Repo-specific: the standard's shared verb lists don't cover "mkdir",
    // and this repo's own docstring is explicit that mkdir is idempotent
    // on an already-existing directory.
    const mkdir = tools.find((t) => t.name === "fs_mkdir");
    expect(mkdir?.config.annotations?.destructiveHint).toBe(false);
    expect(mkdir?.config.annotations?.idempotentHint).toBe(true);
  });
});
