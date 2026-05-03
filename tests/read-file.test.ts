import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

describe("FilesystemClient.readFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkSandbox();
  });

  afterEach(async () => {
    await rmSandbox(root);
  });

  it("reads UTF-8 text under the cap", async () => {
    await buildFixture(root, { "a.txt": "Hello, world!" });
    const client = makeClient([root]);
    const r = await client.readFile(path.join(root, "a.txt"));
    expect(r.size).toBe(13);
    expect(r.bytes_read).toBe(13);
    expect(r.content).toBe("Hello, world!");
    expect(r.binary).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("truncates when bytes_read < size, sets truncated=true", async () => {
    const big = "x".repeat(2048);
    await buildFixture(root, { "big.txt": big });
    const client = makeClient([root]);
    const r = await client.readFile(path.join(root, "big.txt"), {
      maxBytes: 100,
    });
    expect(r.size).toBe(2048);
    expect(r.bytes_read).toBe(100);
    expect(r.content).toBe("x".repeat(100));
    expect(r.truncated).toBe(true);
  });

  it("config.maxReadBytes also caps when no opts.maxBytes provided", async () => {
    const big = "x".repeat(2048);
    await buildFixture(root, { "big.txt": big });
    const client = makeClient([root], { maxReadBytes: 50 });
    const r = await client.readFile(path.join(root, "big.txt"));
    expect(r.bytes_read).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it("config.maxReadBytes=0 disables the cap (read entire file)", async () => {
    const big = "x".repeat(5000);
    await buildFixture(root, { "big.txt": big });
    const client = makeClient([root], { maxReadBytes: 0 });
    const r = await client.readFile(path.join(root, "big.txt"));
    expect(r.bytes_read).toBe(5000);
    expect(r.truncated).toBe(false);
  });

  it("refuses binary content (NUL byte) without force_binary", async () => {
    // A tiny "binary" file with a NUL byte in the first chunk.
    await buildFixture(root, {});
    const fp = path.join(root, "blob.bin");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const { promises: nodeFs } = await import("node:fs");
    await nodeFs.writeFile(fp, buf);

    const client = makeClient([root]);
    await expect(client.readFile(fp)).rejects.toThrow(/looks binary/);
  });

  it("with force_binary=true, returns base64-encoded content and binary=true", async () => {
    const fp = path.join(root, "blob.bin");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x42]);
    const { promises: nodeFs } = await import("node:fs");
    await nodeFs.writeFile(fp, buf);

    const client = makeClient([root]);
    const r = await client.readFile(fp, { forceBinary: true });
    expect(r.binary).toBe(true);
    expect(r.bytes_read).toBe(buf.length);
    expect(Buffer.from(r.content, "base64").equals(buf)).toBe(true);
  });

  it("handles a zero-length file", async () => {
    await buildFixture(root, { empty: "" });
    const client = makeClient([root]);
    const r = await client.readFile(path.join(root, "empty"));
    expect(r.size).toBe(0);
    expect(r.bytes_read).toBe(0);
    expect(r.content).toBe("");
    expect(r.binary).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it("refuses a directory", async () => {
    await buildFixture(root, { sub: {} });
    const client = makeClient([root]);
    await expect(client.readFile(path.join(root, "sub"))).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("refuses paths matching deny patterns", async () => {
    await buildFixture(root, { ".env": "SECRET=abc" });
    const client = makeClient([root]);
    await expect(client.readFile(path.join(root, ".env"))).rejects.toThrow(
      /matches FS_DENY_FILE_PATTERNS/,
    );
  });
});
