import { describe, expect, test } from "vitest";
import {
  parseAllowedHosts,
  parseBindHost,
  parseLogLevel,
  parseOptionalPort,
  parsePositiveInteger,
  requestAuthorityAllowed,
} from "./mcp-environment.js";

describe("mcp-environment", () => {
  test("normalizes DNS, IPv4, bracketed IPv6, and duplicates", () => {
    expect(
      parseAllowedHosts(" Example.TEST. ,127.0.0.1,[::1],example.test"),
    ).toEqual(["example.test", "127.0.0.1", "::1"]);
  });

  test("defaults the HTTP allowlist to fleet and loopback hosts", () => {
    const fleetHosts = [
      "localhost",
      "127.0.0.1",
      "::1",
      "host.docker.internal",
    ];
    expect(parseAllowedHosts(undefined)).toEqual(fleetHosts);
    expect(parseAllowedHosts("  ")).toEqual(fleetHosts);
  });

  test("rejects authority syntax, wildcards, paths, and empty entries", () => {
    for (const value of [
      "example.test:443",
      "https://example.test",
      "*.example.test",
      "example.test/path",
      "example.test,,localhost",
    ]) {
      expect(() => parseAllowedHosts(value)).toThrow(/MCP_ALLOWED_HOSTS/);
    }
  });

  test("parses bounded integers without accepting junk suffixes", () => {
    expect(parseOptionalPort("65535")).toBe(65_535);
    expect(parseOptionalPort(undefined)).toBeUndefined();
    expect(parsePositiveInteger("MCP_SESSION_IDLE_MS", undefined, 123)).toBe(
      123,
    );
    for (const value of ["0", "-1", "+1", "3000junk", "65536"]) {
      expect(() => parseOptionalPort(value)).toThrow(/MCP_PORT/);
    }
  });

  test("validates bind hosts and log levels", () => {
    expect(parseBindHost(undefined)).toBe("127.0.0.1");
    expect(parseBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(parseBindHost("::")).toBe("::");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel(" WARN ")).toBe("warn");
    for (const value of ["https://localhost", "localhost:3000", "[::1]"]) {
      expect(() => parseBindHost(value)).toThrow(/MCP_BIND_HOST/);
    }
    expect(() => parseLogLevel("verbose")).toThrow(/LOG_LEVEL/);
  });

  test("requires Host and present Origin to pass independently", () => {
    const allowed = parseAllowedHosts("example.test,localhost");
    expect(
      requestAuthorityAllowed({ host: "Example.Test:3000" }, allowed),
    ).toBe(true);
    expect(
      requestAuthorityAllowed(
        { host: "example.test:3000", origin: "https://example.test:8443" },
        allowed,
      ),
    ).toBe(true);
    expect(
      requestAuthorityAllowed(
        { host: "evil.test", origin: "https://example.test" },
        allowed,
      ),
    ).toBe(false);
    expect(
      requestAuthorityAllowed(
        { host: "example.test", origin: "https://evil.test" },
        allowed,
      ),
    ).toBe(false);
    expect(
      requestAuthorityAllowed({ origin: "https://example.test" }, allowed),
    ).toBe(false);
  });

  test("accepts valid IPv4 and bracketed IPv6 Host authorities", () => {
    expect(
      requestAuthorityAllowed(
        { host: "127.0.0.1:3000" },
        parseAllowedHosts("127.0.0.1"),
      ),
    ).toBe(true);
    expect(
      requestAuthorityAllowed(
        { host: "[::1]:3000", origin: "http://[::1]:3000" },
        parseAllowedHosts("[::1]"),
      ),
    ).toBe(true);
  });
});
