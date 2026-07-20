import { describe, expect, it } from "vite-plus/test";
import { isHttpsRequest } from "../src/http";

describe("isHttpsRequest", () => {
  it("is false for local http dev requests", () => {
    expect(isHttpsRequest("http://localhost:8787/auth/login")).toBe(false);
  });

  it("is true for production https requests", () => {
    expect(isHttpsRequest("https://kichijitsu.love-rox.cc/auth/login")).toBe(true);
  });
});
