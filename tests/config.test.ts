import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveRootsFromVolumes,
  parseRoots,
  resolveRoots,
} from "../src/config.js";
import { buildFixture, mkSandbox, rmSandbox } from "./sandbox.js";

describe("parseRoots", () => {
  it("returns [] for undefined or empty", () => {
    expect(parseRoots(undefined)).toEqual([]);
    expect(parseRoots("")).toEqual([]);
    expect(parseRoots("  ,  ")).toEqual([]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseRoots("/media, /docker ,,/logs")).toEqual([
      "/media",
      "/docker",
      "/logs",
    ]);
  });
});

describe("deriveRootsFromVolumes", () => {
  it("takes the container-side target of each bind spec", () => {
    expect(
      deriveRootsFromVolumes([
        "/volume1/Media:/media:ro",
        "/volume1/docker:/docker:rw",
      ]),
    ).toEqual(["/media", "/docker"]);
  });

  it("handles specs without an explicit flag", () => {
    expect(deriveRootsFromVolumes(["/volume1/Media:/media"])).toEqual([
      "/media",
    ]);
  });

  it("skips undefined, empty, and the /dev/null sentinel", () => {
    expect(
      deriveRootsFromVolumes([
        "/volume1/Media:/media:ro",
        undefined,
        "",
        "/dev/null:/dev/null:ro",
      ]),
    ).toEqual(["/media"]);
  });

  it("skips malformed specs that have no target", () => {
    expect(deriveRootsFromVolumes(["just-a-source", "/volume1/x:/x"])).toEqual([
      "/x",
    ]);
  });
});

describe("resolveRoots", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("resolves a valid directory root", async () => {
    await buildFixture(root, { sub: {} });
    const { resolved, skipped } = await resolveRoots([path.join(root, "sub")]);
    expect(resolved).toEqual([path.join(root, "sub")]);
    expect(skipped).toEqual([]);
  });

  it("skips a non-existent root with a reason instead of throwing", async () => {
    const missing = path.join(root, "does-not-exist");
    const { resolved, skipped } = await resolveRoots([missing]);
    expect(resolved).toEqual([]);
    expect(skipped).toEqual([{ root: missing, reason: "does not exist" }]);
  });

  it("skips a file (non-directory) root", async () => {
    await buildFixture(root, { "a.txt": "hi" });
    const file = path.join(root, "a.txt");
    const { resolved, skipped } = await resolveRoots([file]);
    expect(resolved).toEqual([]);
    expect(skipped[0]?.root).toBe(file);
    expect(skipped[0]?.reason).toMatch(/not a directory/);
  });

  it("skips a non-absolute root", async () => {
    const { resolved, skipped } = await resolveRoots(["relative/path"]);
    expect(resolved).toEqual([]);
    expect(skipped).toEqual([
      { root: "relative/path", reason: "not an absolute path" },
    ]);
  });

  it("keeps valid roots and drops invalid ones in a mixed set", async () => {
    await buildFixture(root, { good: {} });
    const good = path.join(root, "good");
    const bad = path.join(root, "nope");
    const { resolved, skipped } = await resolveRoots([good, bad]);
    expect(resolved).toEqual([good]);
    expect(skipped).toEqual([{ root: bad, reason: "does not exist" }]);
  });

  it("de-duplicates roots that resolve to the same real path", async () => {
    await buildFixture(root, { sub: {} });
    const p = path.join(root, "sub");
    const { resolved } = await resolveRoots([p, p]);
    expect(resolved).toEqual([p]);
  });
});
