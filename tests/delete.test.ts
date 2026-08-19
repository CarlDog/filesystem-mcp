import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient.delete", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  describe("mutation gate", () => {
    it("dry_run=true returns the plan without touching the filesystem", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      const result = await client.delete(target);
      expect(result.dry_run).toBe(true);
      expect(result.performed).toBe(false);
      expect(result.type).toBe("file");
      expect(result.paths_to_delete).toBe(1);
      expect(result.bytes_to_delete).toBe(5);

      // File still on disk.
      await expect(fs.lstat(target)).resolves.toBeTruthy();
    });

    it("dry_run=false WITHOUT confirm=true throws and does not delete", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      await expect(client.delete(target, { dryRun: false })).rejects.toThrow(
        /refuses to mutate without confirm=true/,
      );

      await expect(fs.lstat(target)).resolves.toBeTruthy();
    });

    it("dry_run=false AND confirm=true performs the delete", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      const result = await client.delete(target, {
        dryRun: false,
        confirm: true,
        confirmName: "a.txt",
      });
      expect(result.performed).toBe(true);
      await expect(fs.lstat(target)).rejects.toThrow();
    });

    it("dry_run=false AND confirm=true WITHOUT confirm_name throws and does not delete", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      await expect(
        client.delete(target, { dryRun: false, confirm: true }),
      ).rejects.toThrow(/confirm_name matching its basename/);

      await expect(fs.lstat(target)).resolves.toBeTruthy();
    });

    it("a mismatched confirm_name throws and does not delete", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      await expect(
        client.delete(target, {
          dryRun: false,
          confirm: true,
          confirmName: "wrong-name.txt",
        }),
      ).rejects.toThrow(/confirm_name matching its basename/);

      await expect(fs.lstat(target)).resolves.toBeTruthy();
    });

    it("confirm=true is harmless on dry_run=true (preview still allowed)", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "a.txt");

      const result = await client.delete(target, { confirm: true });
      expect(result.dry_run).toBe(true);
      expect(result.performed).toBe(false);
      await expect(fs.lstat(target)).resolves.toBeTruthy();
    });
  });

  describe("recursive flag", () => {
    it("deletes an empty directory without recursive=true", async () => {
      await buildFixture(root, { empty: {} });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "empty");

      const result = await client.delete(target, {
        dryRun: false,
        confirm: true,
        confirmName: "empty",
      });
      expect(result.type).toBe("dir");
      expect(result.paths_to_delete).toBe(1);
      await expect(fs.lstat(target)).rejects.toThrow();
    });

    it("refuses non-empty directory without recursive=true", async () => {
      await buildFixture(root, { sub: { "a.txt": "x" } });
      const client = makeClient([root], { allowWrite: true });
      await expect(client.delete(path.join(root, "sub"))).rejects.toThrow(
        /directory is not empty.*recursive=true/,
      );
    });

    it("recursive=true deletes a populated tree and counts everything", async () => {
      await buildFixture(root, {
        sub: {
          "a.txt": "aa", // 2 bytes
          deeper: { "b.txt": "bbbb" }, // 4 bytes
        },
      });
      const client = makeClient([root], { allowWrite: true });
      const target = path.join(root, "sub");

      // Dry run reports the counts.
      const dry = await client.delete(target, { recursive: true });
      // 1 (sub) + 1 (a.txt) + 1 (deeper) + 1 (b.txt) = 4
      expect(dry.paths_to_delete).toBe(4);
      expect(dry.bytes_to_delete).toBe(6);

      // Real run unlinks.
      const real = await client.delete(target, {
        recursive: true,
        dryRun: false,
        confirm: true,
        confirmName: "sub",
      });
      expect(real.performed).toBe(true);
      await expect(fs.lstat(target)).rejects.toThrow();
    });
  });

  describe("symlink handling", () => {
    it.skipIf(skipSymlinks)(
      "unlinks the symlink itself, leaving the target untouched",
      async () => {
        await buildFixture(root, {
          "real.txt": "important",
          link: { __symlink: path.join(root, "real.txt") },
        });
        const client = makeClient([root], { allowWrite: true });
        const result = await client.delete(path.join(root, "link"), {
          dryRun: false,
          confirm: true,
          confirmName: "link",
        });
        expect(result.type).toBe("symlink");
        expect(result.bytes_to_delete).toBe(0);

        // Symlink gone, target unharmed.
        await expect(fs.lstat(path.join(root, "link"))).rejects.toThrow();
        const targetSt = await fs.lstat(path.join(root, "real.txt"));
        expect(targetSt.isFile()).toBe(true);
      },
    );

    it.skipIf(skipSymlinks)(
      "during recursive delete, symlinks mid-tree are unlinked but their targets are untouched",
      async () => {
        // Create an "outside" file that the in-tree symlink will point at.
        const outsideDir = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "fs-mcp-OUT-")),
        );
        try {
          const outsideFile = path.join(outsideDir, "precious.txt");
          await fs.writeFile(outsideFile, "do-not-delete");

          await buildFixture(root, {
            tree: {
              "a.txt": "x",
              link: { __symlink: outsideFile }, // points OUTSIDE roots
            },
          });
          const client = makeClient([root], { allowWrite: true });

          await client.delete(path.join(root, "tree"), {
            recursive: true,
            dryRun: false,
            confirm: true,
            confirmName: "tree",
          });

          // Tree gone; outside file still intact.
          await expect(fs.lstat(path.join(root, "tree"))).rejects.toThrow();
          const st = await fs.lstat(outsideFile);
          expect(st.isFile()).toBe(true);
          expect(await fs.readFile(outsideFile, "utf8")).toBe("do-not-delete");
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    );
  });

  describe("safety", () => {
    it("rejects a path outside any configured root", async () => {
      const client = makeClient([root], { allowWrite: true });
      const outside = await fs.realpath(
        await fs.mkdtemp(path.join(root, "..", "outside-")),
      );
      try {
        await fs.writeFile(path.join(outside, "f.txt"), "x");
        await expect(
          client.delete(path.join(outside, "f.txt")),
        ).rejects.toThrow(/escapes configured FS_ROOTS/);
        // Verify the file still exists.
        await expect(
          fs.lstat(path.join(outside, "f.txt")),
        ).resolves.toBeTruthy();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects a basename matching deny-pattern", async () => {
      await buildFixture(root, { "config.env": "secret" });
      const client = makeClient([root], {
        allowWrite: true,
        denyPatterns: ["*.env"],
      });
      await expect(
        client.delete(path.join(root, "config.env")),
      ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);
      await expect(
        fs.lstat(path.join(root, "config.env")),
      ).resolves.toBeTruthy();
    });

    it("throws when allowWrite=false (defense-in-depth, even for dry-run)", async () => {
      await buildFixture(root, { "a.txt": "x" });
      const client = makeClient([root], { allowWrite: false });
      await expect(client.delete(path.join(root, "a.txt"))).rejects.toThrow(
        /write operations are disabled/,
      );
    });

    it("rejects a non-existent path", async () => {
      const client = makeClient([root], { allowWrite: true });
      await expect(client.delete(path.join(root, "missing"))).rejects.toThrow();
    });
  });
});
