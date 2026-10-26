import { promises as fs, type Dir } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixture, makeClient, mkSandbox, rmSandbox } from "./sandbox.js";

const skipSymlinks = process.platform === "win32";

/**
 * Observe names allocated by a listing or yielded by a stream. Counting only
 * iteration misses an eager readdir allocation even when enqueueing is bounded.
 * Wrappers delegate to real temporary directories and preserve iterator cleanup.
 */
function observeEnumeration(handles: Dir[]) {
  const observation = { yielded: 0 };
  const readdir = fs.readdir;
  vi.spyOn(fs, "readdir").mockImplementation((async (
    ...args: Parameters<typeof fs.readdir>
  ) => {
    const entries = await readdir(...args);
    observation.yielded += entries.length;
    return entries;
  }) as typeof fs.readdir);

  const opendir = fs.opendir;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const directory = await opendir(...args);
    handles.push(directory);
    const iterate = directory[Symbol.asyncIterator].bind(directory);
    Object.defineProperty(directory, Symbol.asyncIterator, {
      value: async function* () {
        for await (const entry of iterate()) {
          observation.yielded++;
          yield entry;
        }
      },
    });
    return directory;
  });
  return observation;
}

function dummyFiles(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`dummy-${index}.txt`, "x"]),
  );
}

describe("FilesystemClient.copy traversal budget", () => {
  let root: string;
  let handles: Dir[];

  beforeEach(async () => {
    root = await mkSandbox();
    handles = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Cleanup also runs after a failed assertion against an older implementation.
    for (const directory of handles) {
      await directory.close().catch(() => {});
    }
    await rmSandbox(root);
  });

  for (const dryRun of [true, false]) {
    describe(`dereference=true, dryRun=${dryRun}`, () => {
      it("stops enumerating a wide directory at the entry budget", async () => {
        const cap = 8;
        await buildFixture(root, { src: dummyFiles(40) });
        const observation = observeEnumeration(handles);
        const copy = vi.spyOn(fs, "cp");
        const client = makeClient([root], {
          allowWrite: true,
          maxCopyEntries: cap,
        });
        const to = path.join(root, "dst");

        await expect(
          client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          }),
        ).rejects.toThrow(/source tree too large.*entry count/);

        // The root consumes one slot. Seven child names fit, and observing the
        // eighth is sufficient proof of overflow; the other 32 stay unconsumed.
        expect(observation.yielded).toBe(cap);
        expect(copy).not.toHaveBeenCalled();
        await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
        for (const directory of handles) {
          await expect(directory.read()).rejects.toMatchObject({
            code: "ERR_DIR_CLOSED",
          });
        }
      });

      it("includes already queued siblings in the next directory's budget", async () => {
        const cap = 12;
        await buildFixture(root, {
          src: {
            first: dummyFiles(10),
            second: dummyFiles(10),
            third: dummyFiles(10),
            fourth: dummyFiles(10),
          },
        });
        const observation = observeEnumeration(handles);
        const copy = vi.spyOn(fs, "cp");
        const client = makeClient([root], {
          allowWrite: true,
          maxCopyEntries: cap,
        });
        const to = path.join(root, "dst");

        await expect(
          client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          }),
        ).rejects.toThrow(/source tree too large.*entry count/);

        // All four sibling names are pending before the first child directory
        // is expanded. A per-directory cap alone would consume too many names.
        expect(observation.yielded).toBe(cap);
        expect(copy).not.toHaveBeenCalled();
        await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
        for (const directory of handles) {
          await expect(directory.read()).rejects.toMatchObject({
            code: "ERR_DIR_CLOSED",
          });
        }
      });

      it("allows a legitimate tree exactly at the entry limit", async () => {
        await buildFixture(root, {
          src: {
            first: { "one.txt": "aa", "two.txt": "b" },
            second: { "three.txt": "ccc", "four.txt": "dddd" },
          },
        });
        const copy = vi.spyOn(fs, "cp");
        const client = makeClient([root], {
          allowWrite: true,
          maxCopyEntries: 7,
        });
        const to = path.join(root, "dst");

        const result = await client.copy(path.join(root, "src"), to, {
          recursive: true,
          dereference: true,
          dryRun,
        });

        expect(result.files_to_copy).toBe(7);
        expect(result.bytes_to_copy).toBe(10);
        expect(result.performed).toBe(!dryRun);
        expect(copy).toHaveBeenCalledTimes(dryRun ? 0 : 1);
        if (dryRun) {
          await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(
            await fs.readFile(path.join(to, "first", "one.txt"), "utf8"),
          ).toBe("aa");
          expect(
            await fs.readFile(path.join(to, "second", "four.txt"), "utf8"),
          ).toBe("dddd");
        }
      });

      it.skipIf(skipSymlinks)(
        "bounds pending work when several aliases expand the same safe directory",
        async () => {
          const cap = 12;
          await buildFixture(root, {
            target: dummyFiles(10),
            src: {
              first: { __symlink: path.join(root, "target") },
              second: { __symlink: path.join(root, "target") },
              third: { __symlink: path.join(root, "target") },
              fourth: { __symlink: path.join(root, "target") },
            },
          });
          const observation = observeEnumeration(handles);
          const copy = vi.spyOn(fs, "cp");
          const client = makeClient([root], {
            allowWrite: true,
            maxCopyEntries: cap,
          });
          const to = path.join(root, "dst");

          await expect(
            client.copy(path.join(root, "src"), to, {
              recursive: true,
              dereference: true,
              dryRun,
            }),
          ).rejects.toThrow(/source tree too large.*entry count/);

          expect(observation.yielded).toBe(cap);
          expect(copy).not.toHaveBeenCalled();
          await expect(fs.lstat(to)).rejects.toMatchObject({ code: "ENOENT" });
          for (const directory of handles) {
            await expect(directory.read()).rejects.toMatchObject({
              code: "ERR_DIR_CLOSED",
            });
          }
        },
      );

      it.skipIf(skipSymlinks)(
        "counts legitimate repeated aliases exactly at the entry limit",
        async () => {
          await buildFixture(root, {
            target: dummyFiles(10),
            src: {
              first: { __symlink: path.join(root, "target") },
              second: { __symlink: path.join(root, "target") },
            },
          });
          const client = makeClient([root], {
            allowWrite: true,
            maxCopyEntries: 23,
          });
          const to = path.join(root, "dst");

          const result = await client.copy(path.join(root, "src"), to, {
            recursive: true,
            dereference: true,
            dryRun,
          });

          expect(result.files_to_copy).toBe(23);
          expect(result.bytes_to_copy).toBe(20);
          expect(result.performed).toBe(!dryRun);
          if (dryRun) {
            await expect(fs.lstat(to)).rejects.toMatchObject({
              code: "ENOENT",
            });
          } else {
            for (const alias of ["first", "second"]) {
              expect((await fs.lstat(path.join(to, alias))).isDirectory()).toBe(
                true,
              );
              expect(
                await fs.readFile(path.join(to, alias, "dummy-0.txt"), "utf8"),
              ).toBe("x");
            }
          }
        },
      );
    });
  }
});
