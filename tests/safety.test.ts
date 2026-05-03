import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient safety primitives", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  describe("assertWithinRoots", () => {
    it("accepts a path inside a root and returns its realpath", async () => {
      await buildFixture(root, { "a.txt": "hello" });
      const client = makeClient([root]);
      const resolved = await client.assertWithinRoots(path.join(root, "a.txt"));
      expect(resolved).toBe(path.join(root, "a.txt"));
    });

    it("rejects a path outside any configured root", async () => {
      const client = makeClient([root]);
      const outside = await fs.realpath(os.tmpdir());
      await expect(client.assertWithinRoots(outside)).rejects.toThrow(
        /escapes configured FS_ROOTS/,
      );
    });

    it.skipIf(skipSymlinks)(
      "follows a symlink inside the root pointing inside the root",
      async () => {
        await buildFixture(root, {
          "real.txt": "hello",
          "link-to-real": { __symlink: path.join(root, "real.txt") },
        });
        const client = makeClient([root]);
        const resolved = await client.assertWithinRoots(
          path.join(root, "link-to-real"),
        );
        expect(resolved).toBe(path.join(root, "real.txt"));
      },
    );

    it.skipIf(skipSymlinks)(
      "rejects a symlink inside the root whose target escapes the root",
      async () => {
        // Create a separate dir outside our sandbox to be the target.
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fs-mcp-OUT-"));
        try {
          await buildFixture(root, {
            "escape-link": { __symlink: outside },
          });
          const client = makeClient([root]);
          await expect(
            client.assertWithinRoots(path.join(root, "escape-link")),
          ).rejects.toThrow(/escapes configured FS_ROOTS/);
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      },
    );

    it("with mustExist=false, accepts a non-existent leaf whose parent is in a root", async () => {
      const client = makeClient([root]);
      const target = path.join(root, "not-yet-created.txt");
      const resolved = await client.assertWithinRoots(target, false);
      expect(resolved).toBe(target);
    });

    it("with mustExist=false, still rejects a non-existent leaf whose parent is outside roots", async () => {
      const client = makeClient([root]);
      const outside = await fs.realpath(os.tmpdir());
      await expect(
        client.assertWithinRoots(path.join(outside, "anywhere.txt"), false),
      ).rejects.toThrow(/escapes configured FS_ROOTS/);
    });
  });

  describe("assertNotDenied / basenameMatchesDeny", () => {
    it("throws on basenames matching default deny patterns", () => {
      const client = makeClient([root]);
      expect(() => client.assertNotDenied(".env")).toThrow(
        /matches FS_DENY_FILE_PATTERNS/,
      );
      expect(() => client.assertNotDenied("server.key")).toThrow();
      expect(() => client.assertNotDenied("id_rsa")).toThrow();
    });

    it("does not throw on basenames not matching deny", () => {
      const client = makeClient([root]);
      expect(() => client.assertNotDenied("readme.md")).not.toThrow();
      expect(() => client.assertNotDenied("Movie.mkv")).not.toThrow();
    });

    it("honors custom deny patterns", () => {
      const client = makeClient([root], { denyPatterns: ["*.secret"] });
      expect(() => client.assertNotDenied("foo.secret")).toThrow();
      expect(() => client.assertNotDenied(".env")).not.toThrow(); // not in custom set
    });

    it("with empty deny patterns, allows everything", () => {
      const client = makeClient([root], { denyPatterns: [] });
      expect(() => client.assertNotDenied(".env")).not.toThrow();
      expect(client.basenameMatchesDeny(".env")).toBe(false);
    });
  });
});
