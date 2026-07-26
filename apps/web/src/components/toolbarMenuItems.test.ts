import { describe, expect, it } from "vite-plus/test";
import { buildToolbarMenuItems, type ToolbarMenuInput } from "./toolbarMenuItems";

/** すべての表示条件を満たした状態(= メニューが最大構成になる)を既定にする */
function input(overrides: Partial<ToolbarMenuInput> = {}): ToolbarMenuInput {
  return {
    hasAccounts: true,
    hasGitHub: true,
    hasTimeAxis: true,
    syncing: false,
    settingsLabel: "設定 (me@example.com)",
    leftPaneOpen: false,
    paneOpen: false,
    onToggleLeftPane: () => {},
    onToggleGitHubPane: () => {},
    onOpenSettings: () => {},
    onSync: () => {},
    onToggleHelp: () => {},
    onConnectGoogle: () => {},
    ...overrides,
  };
}

const ids = (i: ToolbarMenuInput) => buildToolbarMenuItems(i).map((item) => item.id);

describe("buildToolbarMenuItems", () => {
  it("全部揃っているときは ズーム→カレンダー→実績→設定→同期→ヘルプ→法的リンク の順", () => {
    expect(ids(input())).toEqual([
      "zoom",
      "calendar",
      "actuals",
      "settings",
      "sync",
      "help",
      "privacy",
      "terms",
    ]);
  });

  it("月表示(時間軸なし)ではズーム行を出さない", () => {
    expect(ids(input({ hasTimeAxis: false }))).not.toContain("zoom");
  });

  it("GitHub 未連携なら実績行を出さない(元の me.github ゲートと同じ)", () => {
    expect(ids(input({ hasGitHub: false }))).not.toContain("actuals");
  });

  it("連携アカウントが無ければ カレンダー/設定/同期 を出さず、代わりに Google 連携を出す", () => {
    const got = ids(input({ hasAccounts: false, hasGitHub: false }));
    expect(got).toEqual(["zoom", "connect-google", "help", "privacy", "terms"]);
  });

  it("法的リンクは連携状態に関わらず常に含まれる(未ログインのスマホでは唯一の導線)", () => {
    for (const hasAccounts of [true, false]) {
      const got = ids(input({ hasAccounts }));
      expect(got).toContain("privacy");
      expect(got).toContain("terms");
    }
  });

  it("同期中は同期行を disabled にする(元のツールバーボタンと同じ条件)", () => {
    const items = buildToolbarMenuItems(input({ syncing: true }));
    const sync = items.find((item) => item.id === "sync");
    expect(sync?.kind).toBe("action");
    expect(sync?.kind === "action" && sync.disabled).toBe(true);
  });

  it("ペインの開閉状態は aria-expanded 用にそのまま引き継ぐ", () => {
    const items = buildToolbarMenuItems(input({ leftPaneOpen: true, paneOpen: false }));
    const calendar = items.find((item) => item.id === "calendar");
    const actuals = items.find((item) => item.id === "actuals");
    expect(calendar?.kind === "action" && calendar.expanded).toBe(true);
    expect(actuals?.kind === "action" && actuals.expanded).toBe(false);
  });

  it("設定行のアクセシブルネーム/title は呼び出し側の文言(email 入り)をそのまま使う", () => {
    const items = buildToolbarMenuItems(input({ settingsLabel: "設定 (2アカウント連携中)" }));
    const settings = items.find((item) => item.id === "settings");
    expect(settings?.kind === "action" && settings.ariaLabel).toBe("設定 (2アカウント連携中)");
    expect(settings?.kind === "action" && settings.title).toBe("設定 (2アカウント連携中)");
  });

  it("各行の onClick は対応するハンドラをそのまま呼ぶ(機能を落としていないことの担保)", () => {
    const called: string[] = [];
    const items = buildToolbarMenuItems(
      input({
        onToggleLeftPane: () => called.push("calendar"),
        onToggleGitHubPane: () => called.push("actuals"),
        onOpenSettings: () => called.push("settings"),
        onSync: () => called.push("sync"),
        onToggleHelp: () => called.push("help"),
      }),
    );
    for (const item of items) {
      if (item.kind === "action") item.onClick();
    }
    expect(called).toEqual(["calendar", "actuals", "settings", "sync", "help"]);
  });

  it("プライバシー/規約はリンク(href)として返る", () => {
    const items = buildToolbarMenuItems(input());
    const privacy = items.find((item) => item.id === "privacy");
    const terms = items.find((item) => item.id === "terms");
    expect(privacy?.kind === "link" && privacy.href).toBe("/privacy.html");
    expect(terms?.kind === "link" && terms.href).toBe("/terms.html");
  });
});
