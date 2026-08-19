// REQUIRED ENFORCEMENT TEST — standard MCP-T03.
//
// SERVER_VERSION must equal package.json's version.
//
// Eight of nine servers in the fleet kept these two in step by hand, and the
// most careful of them left a comment asking the next person to remember. A
// comment has no failure mode. This does: bump one without the other and the
// suite goes red in the same commit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { SERVER_VERSION } from "./version.js";

describe("version sync", () => {
  test("SERVER_VERSION matches package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  test("SERVER_VERSION is valid semver", () => {
    // Catches a half-finished bump such as "0.2" or a leftover placeholder.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
