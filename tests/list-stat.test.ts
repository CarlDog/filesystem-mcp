import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient list/stat", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  describe("listDirectory", () => {
    it("returns dirents with name/type/size/mtime", async () => {
      await buildFixture(root, {
        "a.txt": "hello",
        sub: { "nested.txt": "x" },
      });
      const client = makeClient([root]);
      const entries = await client.listDirectory(root);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "sub"]);

      const a = entries.find((e) => e.name === "a.txt")!;
      expect(a.type).toBe("file");
      expect(a.size).toBe(5);
      expect(a.mtime).toBeTruthy();

      const sub = entries.find((e) => e.name === "sub")!;
      expect(sub.type).toBe("dir");
    });

    it("filters out deny-pattern matches silently", async () => {
      await buildFixture(root, {
        "a.txt": "ok",
        ".env": "secret",
        id_rsa: "key",
      });
      const client = makeClient([root]);
      const names = (await client.listDirectory(root)).map((e) => e.name);
      expect(names).toContain("a.txt");
      expect(names).not.toContain(".env");
      expect(names).not.toContain("id_rsa");
    });

    it("respects the cap (clamped to maxListEntries)", async () => {
      const fixtures: Record<string, string> = {};
      for (let i = 0; i < 10; i++) fixtures[`f${i}.txt`] = "x";
      await buildFixture(root, fixtures);

      const client = makeClient([root], { maxListEntries: 5 });
      const entries = await client.listDirectory(root);
      expect(entries.length).toBe(5);
    });

    it("user-provided maxEntries cannot exceed config.maxListEntries", async () => {
      const fixtures: Record<string, string> = {};
      for (let i = 0; i < 10; i++) fixtures[`f${i}.txt`] = "x";
      await buildFixture(root, fixtures);

      const client = makeClient([root], { maxListEntries: 3 });
      const entries = await client.listDirectory(root, { maxEntries: 999 });
      expect(entries.length).toBe(3);
    });
  });

  describe("stat", () => {
    it("reports type=file with size and mtime", async () => {
      await buildFixture(root, { "a.txt": "abcd" });
      const client = makeClient([root]);
      const st = await client.stat(path.join(root, "a.txt"));
      expect(st.type).toBe("file");
      expect(st.size).toBe(4);
      expect(st.isSymlink).toBe(false);
      expect(st.mode).toMatch(/^[0-7]{3}$/);
    });

    it("reports type=dir for directories", async () => {
      await buildFixture(root, { sub: {} });
      const client = makeClient([root]);
      const st = await client.stat(path.join(root, "sub"));
      expect(st.type).toBe("dir");
    });

    it.skipIf(skipSymlinks)(
      "reports type=symlink with the link target (not followed)",
      async () => {
        await buildFixture(root, {
          "real.txt": "hi",
          link: { __symlink: path.join(root, "real.txt") },
        });
        const client = makeClient([root]);
        // stat observes the link itself (lstat on the parent's realpath
        // + basename) instead of following it, so the symlink branch is
        // reachable: type=symlink, isSymlink=true, symlinkTarget set.
        const st = await client.stat(path.join(root, "link"));
        expect(st.type).toBe("symlink");
        expect(st.isSymlink).toBe(true);
        expect(st.symlinkTarget).toBe(path.join(root, "real.txt"));
        expect(st.path).toBe(path.join(root, "link"));
      },
    );

    it.skipIf(skipSymlinks)(
      "still rejects a symlink whose PARENT directory is outside roots",
      async () => {
        const { promises: nodeFs } = await import("node:fs");
        const os = await import("node:os");
        const outside = await nodeFs.mkdtemp(
          path.join(os.tmpdir(), "fs-mcp-OUT-"),
        );
        try {
          await nodeFs.symlink(
            path.join(root, "whatever"),
            path.join(outside, "link"),
          );
          const client = makeClient([root]);
          await expect(client.stat(path.join(outside, "link"))).rejects.toThrow(
            /escapes configured FS_ROOTS/,
          );
        } finally {
          await nodeFs.rm(outside, { recursive: true, force: true });
        }
      },
    );

    it("rejects a path matching deny patterns", async () => {
      await buildFixture(root, { ".env": "secret" });
      const client = makeClient([root]);
      await expect(client.stat(path.join(root, ".env"))).rejects.toThrow(
        /matches FS_DENY_FILE_PATTERNS/,
      );
    });
  });
});
