import { describe, expect, it } from "vite-plus/test";
import { generateMcpToken, hashMcpToken, isValidMcpTokenFormat } from "../src/mcp-token";

describe("hashMcpToken", () => {
  // 期待値は `node -e "console.log(require('crypto').createHash('sha256').update(INPUT).digest('hex'))"`
  // で個別に検算済み (INPUT を 'abc' / 'mcp_test-token-value-1234567890' / '' に差し替えて実行)。
  it("matches the known SHA-256 hex digest for 'abc'", async () => {
    expect(await hashMcpToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the known SHA-256 hex digest for a sample mcp_ token", async () => {
    expect(await hashMcpToken("mcp_test-token-value-1234567890")).toBe(
      "98f6a70a2b88510f42602dd8729e7d5a672cfd9b5893738318d6b16f28dba4b1",
    );
  });

  it("matches the known SHA-256 hex digest for the empty string", async () => {
    expect(await hashMcpToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic for the same input", async () => {
    const a = await hashMcpToken("mcp_same-input-twice");
    const b = await hashMcpToken("mcp_same-input-twice");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await hashMcpToken("mcp_input-one");
    const b = await hashMcpToken("mcp_input-two");
    expect(a).not.toBe(b);
  });

  it("returns a 64-character lowercase hex string", async () => {
    const hash = await hashMcpToken("mcp_whatever");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isValidMcpTokenFormat", () => {
  it("accepts a well-formed mcp_ token", () => {
    expect(isValidMcpTokenFormat(`mcp_${"a".repeat(43)}`)).toBe(true);
  });

  it("rejects a value missing the mcp_ prefix", () => {
    expect(isValidMcpTokenFormat(`xyz_${"a".repeat(43)}`)).toBe(false);
  });

  it("rejects a value that is too short even with the prefix", () => {
    expect(isValidMcpTokenFormat("mcp_tooshort")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidMcpTokenFormat("")).toBe(false);
  });
});

describe("generateMcpToken", () => {
  it("produces a raw token accepted by isValidMcpTokenFormat", () => {
    const { raw } = generateMcpToken();
    expect(isValidMcpTokenFormat(raw)).toBe(true);
  });

  it("produces different values across calls", () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a.raw).not.toBe(b.raw);
  });
});
