import { describe, expect, test } from "vitest";
import { describeTransportError } from "./errors.js";

describe("describeTransportError", () => {
  test("appends the cause's message when present", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:1");
    const err = new Error("fetch failed", { cause });
    expect(describeTransportError(err)).toBe(
      "fetch failed: connect ECONNREFUSED 127.0.0.1:1",
    );
  });

  test("falls back to the bare message when there is no cause", () => {
    const err = new Error("timed out");
    expect(describeTransportError(err)).toBe("timed out");
  });

  test("falls back to the bare message when cause is not an Error", () => {
    const err = new Error("fetch failed", { cause: "some string cause" });
    expect(describeTransportError(err)).toBe("fetch failed: some string cause");
  });

  test("handles a non-Error thrown value", () => {
    expect(describeTransportError("plain string throw")).toBe(
      "plain string throw",
    );
  });
});
