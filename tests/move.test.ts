import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

describe("FilesystemClient.move", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("dry-run reports shape and does not touch the filesystem", async () => {
    await buildFixture(root, { "src.txt": "hello" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const result = await client.move(from, to);
    expect(result.dry_run).toBe(true);
    expect(result.performed).toBe(false);
    expect(result.would_overwrite).toBe(false);
    expect(result.cross_device).toBe(false);

    // Source still exists, dest does not.
    await expect(fs.lstat(from)).resolves.toBeTruthy();
    await expect(fs.lstat(to)).rejects.toThrow();
  });

  it("renames a file when dry_run=false", async () => {
    await buildFixture(root, { "src.txt": "hello" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const result = await client.move(from, to, { dryRun: false });
    expect(result.performed).toBe(true);

    await expect(fs.lstat(from)).rejects.toThrow();
    const dstContent = await fs.readFile(to, "utf8");
    expect(dstContent).toBe("hello");
  });

  it("moves a directory tree", async () => {
    await buildFixture(root, {
      src: { "a.txt": "x", sub: { "b.txt": "y" } },
    });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src");
    const to = path.join(root, "dst");

    await client.move(from, to, { dryRun: false });
    await expect(fs.lstat(from)).rejects.toThrow();
    expect(await fs.readFile(path.join(to, "a.txt"), "utf8")).toBe("x");
    expect(await fs.readFile(path.join(to, "sub", "b.txt"), "utf8")).toBe("y");
  });

  it("refuses to overwrite an existing file by default", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.move(path.join(root, "src.txt"), path.join(root, "dst.txt")),
    ).rejects.toThrow(/destination exists.*overwrite=true/);
  });

  it("overwrites with overwrite=true and reports would_overwrite", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const dry = await client.move(from, to, { overwrite: true });
    expect(dry.would_overwrite).toBe(true);

    const real = await client.move(from, to, {
      overwrite: true,
      dryRun: false,
      confirmName: "dst.txt",
    });
    expect(real.performed).toBe(true);
    expect(real.would_overwrite).toBe(true);
    expect(await fs.readFile(to, "utf8")).toBe("src");
  });

  it("an overwrite WITHOUT confirm_name throws and does not touch either file", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    await expect(
      client.move(from, to, { overwrite: true, dryRun: false }),
    ).rejects.toThrow(/confirm_name matching its basename/);

    expect(await fs.readFile(from, "utf8")).toBe("src");
    expect(await fs.readFile(to, "utf8")).toBe("DST");
  });

  it("an overwrite with a mismatched confirm_name throws and does not touch either file", async () => {
    await buildFixture(root, { "src.txt": "src", "dst.txt": "DST" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    await expect(
      client.move(from, to, {
        overwrite: true,
        dryRun: false,
        confirmName: "wrong-name.txt",
      }),
    ).rejects.toThrow(/confirm_name matching its basename/);

    expect(await fs.readFile(from, "utf8")).toBe("src");
    expect(await fs.readFile(to, "utf8")).toBe("DST");
  });

  it("a non-overwriting move does not require confirm_name", async () => {
    await buildFixture(root, { "src.txt": "src" });
    const client = makeClient([root], { allowWrite: true });
    const from = path.join(root, "src.txt");
    const to = path.join(root, "dst.txt");

    const real = await client.move(from, to, { dryRun: false });
    expect(real.performed).toBe(true);
    expect(await fs.readFile(to, "utf8")).toBe("src");
  });

  it("refuses when destination is an existing directory regardless of overwrite", async () => {
    await buildFixture(root, {
      "src.txt": "x",
      dst: { "inside.txt": "y" },
    });
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.move(path.join(root, "src.txt"), path.join(root, "dst"), {
        overwrite: true,
      }),
    ).rejects.toThrow(/destination already exists as a directory/);
  });

  it("refuses when source does not exist", async () => {
    const client = makeClient([root], { allowWrite: true });
    await expect(
      client.move(path.join(root, "missing"), path.join(root, "dst")),
    ).rejects.toThrow();
  });

  it.skipIf(skipSymlinks)(
    "refuses symlink sources to avoid leaving dangling links",
    async () => {
      await buildFixture(root, {
        "real.txt": "x",
        link: { __symlink: path.join(root, "real.txt") },
      });
      const client = makeClient([root], { allowWrite: true });
      await expect(
        client.move(path.join(root, "link"), path.join(root, "moved")),
      ).rejects.toThrow(/refuses symlink sources/);

      // Confirm nothing was moved.
      await expect(fs.lstat(path.join(root, "real.txt"))).resolves.toBeTruthy();
      await expect(fs.lstat(path.join(root, "link"))).resolves.toBeTruthy();
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
        client.move(path.join(outside, "src.txt"), path.join(root, "dst.txt")),
      ).rejects.toThrow(/escapes configured FS_ROOTS/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects destinations outside any root", async () => {
    await buildFixture(root, { "src.txt": "x" });
    const client = makeClient([root], { allowWrite: true });
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(root, "..", "outside-")),
    );
    try {
      await expect(
        client.move(path.join(root, "src.txt"), path.join(outside, "dst.txt")),
      ).rejects.toThrow(/escapes configured FS_ROOTS/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects deny-pattern basenames on either side", async () => {
    await buildFixture(root, { "src.txt": "x", "secrets.env": "secret" });
    const client = makeClient([root], {
      allowWrite: true,
      denyPatterns: ["*.env"],
    });

    // Source matches deny → reject
    await expect(
      client.move(path.join(root, "secrets.env"), path.join(root, "moved.txt")),
    ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);

    // Destination matches deny → reject
    await expect(
      client.move(path.join(root, "src.txt"), path.join(root, "smuggle.env")),
    ).rejects.toThrow(/matches FS_DENY_FILE_PATTERNS/);
  });

  it("throws when allowWrite=false (defense-in-depth, even for dry-run)", async () => {
    await buildFixture(root, { "src.txt": "x" });
    const client = makeClient([root], { allowWrite: false });
    await expect(
      client.move(path.join(root, "src.txt"), path.join(root, "dst.txt")),
    ).rejects.toThrow(/write operations are disabled/);
  });
});
