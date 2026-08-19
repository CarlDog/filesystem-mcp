import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient.findByGlob", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("matches by basename (matchBase shortcut for slashless patterns)", async () => {
    await buildFixture(root, {
      "a.txt": "1",
      "b.md": "2",
      sub: { "c.txt": "3", deeper: { "d.txt": "4" } },
    });
    const client = makeClient([root]);
    const page = await client.findByGlob("*.txt");
    const paths = page.items.map((r) => r.path).sort();
    expect(paths).toEqual([
      path.join(root, "a.txt"),
      path.join(root, "sub/c.txt"),
      path.join(root, "sub/deeper/d.txt"),
    ]);
    expect(page.items.every((r) => r.type === "file")).toBe(true);
    expect(page.truncated).toBe(false);
  });

  it("matches by relative path for patterns with slashes", async () => {
    await buildFixture(root, {
      "Show A": {
        "Season 1": { "ep01.mkv": "x" },
        "Season 2": { "ep01.mkv": "x" },
      },
      "Show B": { Specials: { "ep01.mkv": "x" } },
    });
    const client = makeClient([root]);
    const page = await client.findByGlob("**/Season *", {
      startPath: root,
    });
    const names = page.items.map((r) => path.basename(r.path)).sort();
    expect(names).toEqual(["Season 1", "Season 2"]);
    expect(page.items.every((r) => r.type === "dir")).toBe(true);
  });

  it("filters out deny-pattern matches and does not descend into them", async () => {
    await buildFixture(root, {
      "a.env": "secret",
      ok: { "good.txt": "x" },
      "bad.key": "secret",
    });
    const client = makeClient([root]);
    const page = await client.findByGlob("*", { startPath: root });
    const names = page.items.map((r) => path.basename(r.path));
    expect(names).not.toContain("a.env");
    expect(names).not.toContain("bad.key");
    expect(names).toContain("ok");
    expect(names).toContain("good.txt");
  });

  it("a limit over config.maxListEntries throws instead of clamping", async () => {
    const fixtures: Record<string, string> = {};
    for (let i = 0; i < 20; i++) fixtures[`f${i}.txt`] = "x";
    await buildFixture(root, fixtures);

    const client = makeClient([root], { maxListEntries: 5 });
    await expect(client.findByGlob("*.txt", { limit: 999 })).rejects.toThrow(
      /exceeds the configured maximum/,
    );
  });

  it("defaults the page size to maxListEntries and reports truncated=true when more exist", async () => {
    const fixtures: Record<string, string> = {};
    for (let i = 0; i < 20; i++) fixtures[`f${i}.txt`] = "x";
    await buildFixture(root, fixtures);

    const client = makeClient([root], { maxListEntries: 5 });
    const page = await client.findByGlob("*.txt");
    expect(page.items.length).toBe(5);
    expect(page.truncated).toBe(true);
  });

  it("offset pages through results in stable, sorted-per-directory order", async () => {
    const fixtures: Record<string, string> = {};
    for (let i = 0; i < 10; i++) fixtures[`f${i}.txt`] = "x";
    await buildFixture(root, fixtures);

    const client = makeClient([root], { maxListEntries: 100 });
    const first = await client.findByGlob("*.txt", { limit: 4 });
    const second = await client.findByGlob("*.txt", { offset: 4, limit: 4 });
    const third = await client.findByGlob("*.txt", { offset: 8, limit: 4 });

    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    expect(third.truncated).toBe(false);

    const all = [...first.items, ...second.items, ...third.items].map((r) =>
      path.basename(r.path),
    );
    expect(new Set(all).size).toBe(10); // no dupes, nothing skipped
  });

  it("returns empty for a pattern that matches nothing", async () => {
    await buildFixture(root, { "a.txt": "x" });
    const client = makeClient([root]);
    const page = await client.findByGlob("*.nonexistent");
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  it("walks all configured roots when startPath is omitted", async () => {
    // Set up two independent sandbox roots. Both contribute matches.
    const root2 = await mkSandbox();
    try {
      await buildFixture(root, { "in-root1.txt": "a" });
      await buildFixture(root2, { "in-root2.txt": "b" });

      const client = makeClient([root, root2]);
      const page = await client.findByGlob("*.txt");
      const names = page.items.map((r) => path.basename(r.path)).sort();
      expect(names).toEqual(["in-root1.txt", "in-root2.txt"]);
    } finally {
      await rmSandbox(root2);
    }
  });

  it.skipIf(skipSymlinks)(
    "follows symlinks whose target is inside a configured root",
    async () => {
      await buildFixture(root, {
        real: { "x.txt": "in-real" },
        // symlink from root/link -> root/real (relative target)
        link: { __symlink: path.join(root, "real") },
      });
      const client = makeClient([root]);
      const page = await client.findByGlob("*.txt");
      // Should find x.txt at least once (via real). Cycle protection /
      // visited-set dedup means we won't double-emit it from the symlink
      // descent, even though both paths route to the same target.
      const xMatches = page.items.filter(
        (r) => path.basename(r.path) === "x.txt",
      );
      expect(xMatches.length).toBe(1);
    },
  );

  it.skipIf(skipSymlinks)(
    "skips a symlink whose target is outside any root",
    async () => {
      // Set up an "outside" dir not in the client's roots.
      const { promises: nodeFs } = await import("node:fs");
      const os = await import("node:os");
      const outside = await nodeFs.mkdtemp(
        path.join(os.tmpdir(), "fs-mcp-OUT-"),
      );
      try {
        await nodeFs.writeFile(path.join(outside, "external.txt"), "x");
        await buildFixture(root, {
          "in.txt": "x",
          escape: { __symlink: outside },
        });
        const client = makeClient([root]);
        const page = await client.findByGlob("*.txt");
        const names = page.items.map((r) => path.basename(r.path));
        expect(names).toContain("in.txt");
        expect(names).not.toContain("external.txt");
      } finally {
        await nodeFs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(skipSymlinks)(
    "tolerates a self-referencing symlink without infinite-looping",
    async () => {
      await buildFixture(root, {
        sub: { "a.txt": "x" },
        // self-loop: root/loop -> root (the entire sandbox)
        loop: { __symlink: root },
      });
      const client = makeClient([root]);
      const page = await client.findByGlob("a.txt");
      // a.txt exists once; loop visit hits cycle protection.
      const aMatches = page.items.filter(
        (r) => path.basename(r.path) === "a.txt",
      );
      expect(aMatches.length).toBe(1);
    },
  );
});
