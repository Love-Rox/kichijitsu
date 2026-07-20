import { describe, expect, it } from "vite-plus/test";
import { toGoogleEventDTO } from "../src/core/google-events";

describe("toGoogleEventDTO", () => {
  it("copies location and description through when present", () => {
    const dto = toGoogleEventDTO({
      id: "evt-1",
      status: "confirmed",
      location: "会議室A",
      description: "<b>詳細</b>",
    });

    expect(dto.location).toBe("会議室A");
    expect(dto.description).toBe("<b>詳細</b>");
  });

  it("omits location and description when Google does not send them", () => {
    const dto = toGoogleEventDTO({ id: "evt-2", status: "confirmed" });

    expect(dto.location).toBeUndefined();
    expect(dto.description).toBeUndefined();
    // JSON.stringify drops object keys whose value is undefined, so this is what actually
    // reaches the client via c.json() — assert the wire format, not just the in-memory object
    // (which always has the key present with value `undefined` due to object-literal syntax).
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("location");
    expect(serialized).not.toContain("description");
  });

  it("copies iCalUID through when present, and drops it from the wire format when absent", () => {
    const withUid = toGoogleEventDTO({
      id: "evt-3",
      status: "confirmed",
      iCalUID: "uid-123@google.com",
    });
    expect(withUid.iCalUID).toBe("uid-123@google.com");

    const withoutUid = toGoogleEventDTO({ id: "evt-4", status: "confirmed" });
    expect(withoutUid.iCalUID).toBeUndefined();
    expect(JSON.stringify(withoutUid)).not.toContain("iCalUID");
  });
});
