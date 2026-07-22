import { describe, expect, it } from "vite-plus/test";
import { shouldHideDeclined, type DeclinedVisibilitySettings } from "./declinedVisibility";

const SHOW_ALL: DeclinedVisibilitySettings = { showDeclined: true, keepOrganizerDeclined: true };
const HIDE_DECLINED: DeclinedVisibilitySettings = {
  showDeclined: false,
  keepOrganizerDeclined: true,
};
const HIDE_DECLINED_EVEN_OWN: DeclinedVisibilitySettings = {
  showDeclined: false,
  keepOrganizerDeclined: false,
};

describe("shouldHideDeclined", () => {
  it("declined 以外の responseStatus は showDeclined の値に関わらず常に表示する", () => {
    expect(shouldHideDeclined({ responseStatus: "accepted" }, HIDE_DECLINED)).toBe(false);
    expect(shouldHideDeclined({ responseStatus: "tentative" }, HIDE_DECLINED)).toBe(false);
    expect(shouldHideDeclined({ responseStatus: "needsAction" }, HIDE_DECLINED)).toBe(false);
    expect(shouldHideDeclined({}, HIDE_DECLINED)).toBe(false); // attendees 無し(responseStatus undefined)
  });

  it("showDeclined: true (既定) なら declined でも常に表示する(現状維持)", () => {
    expect(shouldHideDeclined({ responseStatus: "declined" }, SHOW_ALL)).toBe(false);
    expect(shouldHideDeclined({ responseStatus: "declined", isOrganizer: true }, SHOW_ALL)).toBe(
      false,
    );
  });

  it("showDeclined: false かつ keepOrganizerDeclined: true のとき、非主催の declined は非表示にする", () => {
    expect(shouldHideDeclined({ responseStatus: "declined" }, HIDE_DECLINED)).toBe(true);
    expect(
      shouldHideDeclined({ responseStatus: "declined", isOrganizer: false }, HIDE_DECLINED),
    ).toBe(true);
  });

  it("showDeclined: false かつ keepOrganizerDeclined: true のとき、自分が主催の declined は残す", () => {
    expect(
      shouldHideDeclined({ responseStatus: "declined", isOrganizer: true }, HIDE_DECLINED),
    ).toBe(false);
  });

  it("keepOrganizerDeclined: false のときは主催の declined も非表示にする", () => {
    expect(
      shouldHideDeclined({ responseStatus: "declined", isOrganizer: true }, HIDE_DECLINED_EVEN_OWN),
    ).toBe(true);
    expect(
      shouldHideDeclined(
        { responseStatus: "declined", isOrganizer: false },
        HIDE_DECLINED_EVEN_OWN,
      ),
    ).toBe(true);
  });
});
