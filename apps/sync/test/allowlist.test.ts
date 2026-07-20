import { describe, expect, it } from "vite-plus/test";
import { isEmailAllowed } from "../src/allowlist";

describe("isEmailAllowed", () => {
  it("allows any email when the allowlist is undefined", () => {
    expect(isEmailAllowed(undefined, "anyone@example.com")).toBe(true);
  });

  it("allows any email when the allowlist is empty", () => {
    expect(isEmailAllowed("", "anyone@example.com")).toBe(true);
    expect(isEmailAllowed("   ", "anyone@example.com")).toBe(true);
    expect(isEmailAllowed(",,", "anyone@example.com")).toBe(true);
  });

  it("allows an email that matches the list, case-insensitively", () => {
    const list = "alice@example.com, Bob@Example.com";
    expect(isEmailAllowed(list, "alice@example.com")).toBe(true);
    expect(isEmailAllowed(list, "ALICE@EXAMPLE.COM")).toBe(true);
    expect(isEmailAllowed(list, "bob@example.com")).toBe(true);
  });

  it("rejects an email that is not in a non-empty list", () => {
    const list = "alice@example.com,bob@example.com";
    expect(isEmailAllowed(list, "mallory@example.com")).toBe(false);
  });
});
