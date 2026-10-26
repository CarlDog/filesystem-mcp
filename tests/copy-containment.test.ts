import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

// Every target, including the deliberately out-of-root ones, is a fresh
// temporary dummy fixture. Nothing here accesses host files or live mounts.
describe.skipIf(skipSymlinks)("FilesystemClient.copy containment", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkSandbox();
    outside = await mkSandbox();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rmSandbox(root);
    await rmSandbox(outside);
  });

  for (const dryRun of [true, false]) {
    describe(`dereference=true, dryRun=${dryRun}`, () => {
      it.each([
        { kind: "outside file", alias: "link", target: "outside-file" },
        { kind: "outside directory", alias: "link", target: "outside-dir" },
        { kind: "denied target", alias: "link", target: "denied" },
        { kind: "denied alias", alias: "alias.key", target: "allowed" },
      ])(
        "rejects a nested $kind before creating the destination",
        async ({ alias, target }) => {
          await buildFixture(outside, {
            "dummy.txt": "outside dummy",
            directory: { "dummy.txt": "outside directory dummy" },
          });
          await buildFixture(root, {
            "allowed.txt": "allowed dummy",
            "server.key": "denied dummy",
            src: {},
          });
          const targets: Record<string, string> = {
            "outside-file": path.join(outside, "dummy.txt"),
            "outside-dir": path.join(outside, "directory"),
            denied: path.join(root, "server.key"),
            allowed: path.join(root, "allowed.txt"),
          };
          const offending = path.join(root, "src", alias);
          await fs.symlink(targets[target]!, offending);
          const to = path.join(root, "dst");
          const client = makeClient([root], { allowWrite: true });

          const operation = client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          });
          await expect(operation).rejects.toThrow(
            /escapes configured FS_ROOTS|FS_DENY_FILE_PATTERNS/,
          );
          await expect(operation).rejects.toThrow(offending);
          await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );

      it("fails closed on a dangling nested source link", async () => {
        await buildFixture(root, {
          src: { link: { __symlink: path.join(root, "missing.txt") } },
        });
        const to = path.join(root, "dst");
        const client = makeClient([root], { allowWrite: true });

        await expect(
          client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          }),
        ).rejects.toThrow();
        await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
      });

      it("rejects a directory cycle before creating the destination", async () => {
        await buildFixture(root, {
          src: { sub: { back: { __symlink: path.join(root, "src") } } },
        });
        const to = path.join(root, "dst");
        const client = makeClient([root], { allowWrite: true });

        await expect(
          client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          }),
        ).rejects.toThrow(/cycle/i);
        await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
      });

      it.each(["leaf", "ancestor"])(
        "rejects a dangling destination %s symlink without creating its outside target",
        async (kind) => {
          await buildFixture(root, { "src.txt": "source dummy" });
          const missing = path.join(outside, "missing-dummy");
          const link = path.join(root, "destination");
          await fs.symlink(missing, link);
          const to = kind === "leaf" ? link : path.join(link, "child.txt");
          const client = makeClient([root], { allowWrite: true });

          await expect(
            client.copy(path.join(root, "src.txt"), to, {
              dereference: true,
              overwrite: true,
              confirmName: path.basename(to),
              dryRun,
            }),
          ).rejects.toThrow();
          await expect(fs.lstat(missing)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        },
      );
    });
  }

  it("copies safe nested aliases across roots and counts duplicate directory contents", async () => {
    await buildFixture(outside, {
      "allowed.txt": "safe",
      directory: { "child.txt": "child" },
    });
    await buildFixture(root, {
      src: {
        "local.txt": "home",
        file: { __symlink: path.join(outside, "allowed.txt") },
        first: { __symlink: path.join(outside, "directory") },
        second: { __symlink: path.join(outside, "directory") },
      },
    });
    const client = makeClient([root, outside], { allowWrite: true });
    const from = path.join(root, "src");
    const to = path.join(root, "dst");
    const preview = await client.copy(from, to, {
      recursive: true,
      dereference: true,
    });
    expect(preview.files_to_copy).toBe(7);
    expect(preview.bytes_to_copy).toBe(18);
    await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });

    const copied = await client.copy(from, to, {
      recursive: true,
      dereference: true,
      dryRun: false,
    });
    expect(copied.files_to_copy).toBe(preview.files_to_copy);
    expect(copied.bytes_to_copy).toBe(preview.bytes_to_copy);
    expect(await fs.readFile(path.join(to, "file"), "utf8")).toBe("safe");
    for (const alias of ["first", "second"]) {
      expect((await fs.lstat(path.join(to, alias))).isSymbolicLink()).toBe(
        false,
      );
      expect(await fs.readFile(path.join(to, alias, "child.txt"), "utf8")).toBe(
        "child",
      );
    }
  });

  it("counts repeated safe directory aliases against the byte limit", async () => {
    await buildFixture(root, {
      target: { "dummy.txt": "1234" },
      src: {
        first: { __symlink: path.join(root, "target") },
        second: { __symlink: path.join(root, "target") },
      },
    });
    const client = makeClient([root], {
      allowWrite: true,
      maxCopyBytes: 6,
    });
    const to = path.join(root, "dst");
    await expect(
      client.copy(path.join(root, "src"), to, {
        recursive: true,
        dereference: true,
        dryRun: false,
      }),
    ).rejects.toThrow(/source tree too large.*total bytes/);
    await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves nested links with dereference=false, including unsafe targets", async () => {
    await buildFixture(outside, {
      "dummy.txt": "outside dummy",
      directory: { "dummy.txt": "outside directory dummy" },
    });
    await buildFixture(root, {
      "server.key": "denied dummy",
      src: {
        file: { __symlink: path.join(outside, "dummy.txt") },
        directory: { __symlink: path.join(outside, "directory") },
        denied: { __symlink: path.join(root, "server.key") },
      },
    });
    const client = makeClient([root], { allowWrite: true });
    const to = path.join(root, "dst");
    const result = await client.copy(path.join(root, "src"), to, {
      recursive: true,
      dryRun: false,
    });
    expect(result.files_to_copy).toBe(4);
    expect(result.bytes_to_copy).toBe(0);
    for (const alias of ["file", "directory", "denied"]) {
      expect((await fs.lstat(path.join(to, alias))).isSymbolicLink()).toBe(
        true,
      );
    }
  });

  it.each([
    {
      kind: "regular file",
      directory: false,
      initialLink: false,
      denied: false,
    },
    {
      kind: "regular directory",
      directory: true,
      initialLink: false,
      denied: false,
    },
    {
      kind: "file link to a denied target",
      directory: false,
      initialLink: true,
      denied: true,
    },
    {
      kind: "directory link",
      directory: true,
      initialLink: true,
      denied: false,
    },
  ])(
    "rechecks a $kind replaced after preflight",
    async ({ directory, initialLink, denied }) => {
      await buildFixture(outside, {
        "dummy.txt": "outside dummy",
        directory: { "dummy.txt": "outside directory dummy" },
      });
      await buildFixture(root, {
        "server.key": "denied dummy",
        "allowed.txt": "allowed dummy",
        allowedDir: { "dummy.txt": "allowed directory dummy" },
        src: {},
      });
      const entry = path.join(root, "src", "entry");
      if (initialLink) {
        await fs.symlink(
          path.join(root, directory ? "allowedDir" : "allowed.txt"),
          entry,
        );
      } else if (directory) {
        await buildFixture(path.join(root, "src"), {
          entry: { "dummy.txt": "allowed directory dummy" },
        });
      } else {
        await fs.writeFile(entry, "allowed dummy");
      }
      const target = denied
        ? path.join(root, "server.key")
        : path.join(outside, directory ? "directory" : "dummy.txt");
      const originalCp = fs.cp;
      vi.spyOn(fs, "cp").mockImplementationOnce(
        async (source, destination, opts) => {
          await fs.rm(entry, { recursive: true });
          await fs.symlink(target, entry);
          await originalCp(source, destination, opts);
        },
      );
      const client = makeClient([root], { allowWrite: true });
      const to = path.join(root, "dst");

      await expect(
        client.copy(path.join(root, "src"), to, {
          recursive: true,
          dereference: true,
          dryRun: false,
        }),
      ).rejects.toThrow(/escapes configured FS_ROOTS|FS_DENY_FILE_PATTERNS/);
      await expect(fs.lstat(path.join(to, "entry"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([false, true])(
    "rechecks a destination link inserted after preflight (dangling=%s)",
    async (dangling) => {
      await buildFixture(root, { "src.txt": "source dummy" });
      const target = path.join(outside, "dummy.txt");
      if (!dangling) await fs.writeFile(target, "outside sentinel");
      const to = path.join(root, "dst.txt");
      const originalCp = fs.cp;
      vi.spyOn(fs, "cp").mockImplementationOnce(
        async (source, destination, opts) => {
          await fs.symlink(target, to);
          await originalCp(source, destination, opts);
        },
      );
      const client = makeClient([root], { allowWrite: true });

      await expect(
        client.copy(path.join(root, "src.txt"), to, {
          dereference: true,
          dryRun: false,
        }),
      ).rejects.toThrow();
      if (dangling) {
        await expect(fs.lstat(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await fs.readFile(target, "utf8")).toBe("outside sentinel");
      }
    },
  );

  it.each(["entries", "bytes"])(
    "rechecks the %s limit when the source grows after preflight",
    async (limit) => {
      await buildFixture(root, { src: { "dummy.txt": "x" } });
      const from = path.join(root, "src");
      const to = path.join(root, "dst");
      const originalCp = fs.cp;
      vi.spyOn(fs, "cp").mockImplementationOnce(
        async (source, destination, opts) => {
          if (limit === "entries") {
            await buildFixture(from, { "second.txt": "x", "third.txt": "x" });
          } else {
            await fs.writeFile(path.join(from, "dummy.txt"), "12345");
          }
          await originalCp(source, destination, opts);
        },
      );
      const client = makeClient([root], {
        allowWrite: true,
        maxCopyEntries: limit === "entries" ? 3 : 10,
        maxCopyBytes: limit === "bytes" ? 4 : 100,
      });

      await expect(
        client.copy(from, to, {
          recursive: true,
          dereference: true,
          dryRun: false,
        }),
      ).rejects.toThrow(
        limit === "entries"
          ? /source tree too large.*entry count/
          : /source tree too large.*total bytes/,
      );
      if (limit === "bytes") {
        await expect(
          fs.lstat(path.join(to, "dummy.txt")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it("rejects a directory cycle inserted after preflight", async () => {
    await buildFixture(root, { src: { "dummy.txt": "source dummy" } });
    const from = path.join(root, "src");
    const to = path.join(root, "dst");
    const originalCp = fs.cp;
    vi.spyOn(fs, "cp").mockImplementationOnce(
      async (source, destination, opts) => {
        await fs.symlink(from, path.join(from, "back"));
        await originalCp(source, destination, opts);
      },
    );
    const client = makeClient([root], { allowWrite: true });

    await expect(
      client.copy(from, to, {
        recursive: true,
        dereference: true,
        dryRun: false,
      }),
    ).rejects.toThrow(/cycle/i);
    await expect(fs.lstat(path.join(to, "back"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
