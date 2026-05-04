import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient.copy", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("dry-run reports counts and does not touch the filesystem", async () => {
    await buildFixture(root, { "src.txt": "hello" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const result = await client.copy(from, to);
    expect(result.dry_run).toBe(true);
    expect(result.performed).toBe(false);
    expect(result.would_overwrite).toBe(false);
    expect(result.files_to_copy).toBe(1);
    expect(result.bytes_to_copy).toBe(5);

    await expect(fs.lstat(to)).rejects.toThrow();
  });

  it("copies a single file when dry_run=false", async () => {
    await buildFixture(root, { "src.txt": "hello" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const result = await client.copy(from, to, { dryRun: false });
    expect(result.performed).toBe(true);
    expect(await fs.readFile(to, "utf8")).toBe("hello");
    // Source still present.
    expect(await fs.readFile(from, "utf8")).toBe("hello");
  });

  it("refuses non-recursive copy of a directory", async () => {
    await buildFixture(root, { src: { "a.txt": "x" } });
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.copy(path.join(root, "src"), path.join(root, "dst")),
    ).rejects.toThrow(/refuses to copy a directory without recursive=true/);
  });

  it("recursive copy of a directory tree counts entries+bytes", async () => {
    await buildFixture(root, {
      src: {
        "a.txt": "aa", // 2 bytes
        "b.txt": "bbbb", // 4 bytes
        sub: { "c.txt": "ccc" }, // 3 bytes
      },
    });
    const client = makeClient([root], { allowWrite: true });
    const result = await client.copy(
      path.join(root, "src"),
      path.join(root, "dst"),
      { recursive: true, dryRun: false },
    );
    expect(result.performed).toBe(true);
    // 1 root dir + 3 files + 1 sub dir = 5 entries
    expect(result.files_to_copy).toBe(5);
    expect(result.bytes_to_copy).toBe(9);

    // Verify on disk.
    expect(await fs.readFile(path.join(root, "dst", "a.txt"), "utf8")).toBe(
      "aa",
    );
    expect(
      await fs.readFile(path.join(root, "dst", "sub", "c.txt"), "utf8"),
    ).toBe("ccc");
  });

  it("refuses to overwrite an existing file by default", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.copy(path.join(root, "src.txt"), path.join(root, "dst.txt")),
    ).rejects.toThrow(/destination exists.*overwrite=true/);
  });

  it("overwrite=true reports would_overwrite and replaces the file", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    const result = await client.copy(
      path.join(root, "src.txt"),
      path.join(root, "dst.txt"),
      { overwrite: true, dryRun: false },
    );
    expect(result.would_overwrite).toBe(true);
    expect(await fs.readFile(path.join(root, "dst.txt"), "utf8")).toBe("src");
  });

  it("refuses when destination is an existing directory regardless of overwrite", async () => {
    await buildFixture(root, {
      "src.txt": "x",
      dst: { "inside.txt": "y" },
    });
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.copy(path.join(root, "src.txt"), path.join(root, "dst"), {
        overwrite: true,
      }),
    ).rejects.toThrow(/destination already exists as a directory/);
  });

  describe("size limits", () => {
    it("refuses when source tree exceeds maxCopyEntries", async () => {
      await buildFixture(root, {
        src: {
          "a.txt": "x",
          "b.txt": "x",
          "c.txt": "x",
          "d.txt": "x",
          "e.txt": "x",
        },
      });
      const client = makeClient([root], {
        allowWrite: true,
        maxCopyEntries: 3, // way under
      });
      await expect(
        client.copy(path.join(root, "src"), path.join(root, "dst"), {
          recursive: true,
        }),
      ).rejects.toThrow(/refused: source tree too large.*entry count/);
    });

    it("refuses when source tree exceeds maxCopyBytes", async () => {
      await buildFixture(root, {
        big: "x".repeat(2000), // 2000 bytes
      });
      const client = makeClient([root], {
        allowWrite: true,
        maxCopyBytes: 100, // way under
      });
      await expect(
        client.copy(path.join(root, "big"), path.join(root, "dst")),
      ).rejects.toThrow(/refused: source tree too large.*total bytes/);
    });

    it("error message includes guidance about rsync and per-subdir iteration", async () => {
      await buildFixture(root, {
        src: { "a.txt": "x", "b.txt": "x", "c.txt": "x" },
      });
      const client = makeClient([root], {
        allowWrite: true,
        maxCopyEntries: 1,
      });
      await expect(
        client.copy(path.join(root, "src"), path.join(root, "dst"), {
          recursive: true,
        }),
      ).rejects.toThrow(/rsync.*fs_find_by_glob/);
    });
  });

  it.skipIf(skipSymlinks)(
    "default copies a symlink as a symlink (no dereference)",
    async () => {
      await buildFixture(root, {
        "real.txt": "real-content",
        link: { __symlink: path.join(root, "real.txt") },
      });
      const client = makeClient([root], { allowWrite: true });
      const result = await client.copy(
        path.join(root, "link"),
        path.join(root, "link-copy"),
        { dryRun: false },
      );
      expect(result.dereference).toBe(false);
      // Result should still be a symlink.
      const st = await fs.lstat(path.join(root, "link-copy"));
      expect(st.isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(skipSymlinks)(
    "dereference=true copies the target's content (real bytes)",
    async () => {
      await buildFixture(root, {
        "real.txt": "real-content",
        link: { __symlink: path.join(root, "real.txt") },
      });
      const client = makeClient([root], { allowWrite: true });
      const result = await client.copy(
        path.join(root, "link"),
        path.join(root, "real-copy.txt"),
        { dereference: true, dryRun: false },
      );
      expect(result.dereference).toBe(true);
      const st = await fs.lstat(path.join(root, "real-copy.txt"));
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isFile()).toBe(true);
      expect(await fs.readFile(path.join(root, "real-copy.txt"), "utf8")).toBe(
        "real-content",
      );
    },
  );

  it("rejects sources outside any root", async () => {
    const client = makeClient([root], { allowWrite: true });
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(root, "..", "outside-")),
    );
    try {
      await fs.writeFile(path.join(outside, "src.txt"), "x");
      await expect(
        client.copy(path.join(outside, "src.txt"), path.join(root, "dst.txt")),
      ).rejects.toThrow(/escapes configured FS_ROOTS/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects deny-pattern basenames on either side", async () => {
    await buildFixture(root, { "src.txt": "x", "secret.env": "x" });
    const client = makeClient([root], {
      allowWrite: true,
      denyPatterns: ["*.env"],
    });
    await expect(
      client.copy(path.join(root, "secret.env"), path.join(root, "moved.txt")),
    ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);
    await expect(
      client.copy(path.join(root, "src.txt"), path.join(root, "smuggle.env")),
    ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);
  });

  it("throws when allowWrite=false", async () => {
    await buildFixture(root, { "src.txt": "x" });
    const client = makeClient([root], { allowWrite: false });
    await expect(
      client.copy(path.join(root, "src.txt"), path.join(root, "dst.txt")),
    ).rejects.toThrow(/write operations are disabled/);
  });
});
