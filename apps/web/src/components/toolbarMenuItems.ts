/**
 * スマホ幅ツールバーの「その他」メニュー(ToolbarMenu)に何をどの順で並べるか、という
 * 振り分けだけを持つ純ロジック(2026-07-26、ユーザー要望「スマホでヘッダーが収まりきらない」)。
 *
 * なぜ React から切り離すか: 「連携アカウントが無いときは カレンダー/設定/同期 を出さない」
 * 「GitHub 未連携なら 実績 を出さない」「月表示ならズームを出さない」といった表示条件は、
 * 元のツールバー各ボタンに散らばっていたゲート条件(`me.accounts.length > 0` / `me.github` /
 * `view !== "month"`)をそのまま引き継ぐ必要があり、落とすと機能が消える。ここに集約して
 * テストで固定しておけば、以降メニューの並び替えをしても「何が出るか」は壊れない。
 * この web アプリにはコンポーネントテストの土台(testing-library 等)が無いため、
 * テストできる形にするには「React に依存しない .ts」であることが条件になる。
 */

/**
 * 行頭アイコンの種別。実際の SVG コンポーネント/グリフへの対応付けは ToolbarMenu.tsx が持つ
 * ―― このモジュールを React 非依存に保つため、ここでは識別子だけを扱う。
 */
export type ToolbarMenuIconId = "calendar" | "timer" | "gear" | "sync" | "help" | "google";

export type ToolbarMenuItemId =
  | "zoom"
  | "calendar"
  | "actuals"
  | "settings"
  | "sync"
  | "connect-google"
  | "help"
  | "privacy"
  | "terms";

/** 時間軸ズーム。HourHeightControl をそのまま埋め込む専用行(押しても閉じない) */
export interface ToolbarMenuZoomItem {
  kind: "zoom";
  id: "zoom";
  label: string;
}

/** 押すと元のツールバーボタンと同じ onClick が走り、メニューは閉じる行 */
export interface ToolbarMenuActionItem {
  kind: "action";
  id: ToolbarMenuItemId;
  icon: ToolbarMenuIconId;
  /** 行に見せる文言 */
  label: string;
  /** 元ボタンの aria-label をそのまま引き継ぐ(読み上げ名を変えない) */
  ariaLabel: string;
  /** 元ボタンの title をそのまま引き継ぐ */
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** 元ボタンの aria-expanded(ペイン開閉トグル)をそのまま引き継ぐ */
  expanded?: boolean;
}

/** 外部リンク(プライバシー/規約)。ページ遷移なのでメニューの開閉状態は関与しない */
export interface ToolbarMenuLinkItem {
  kind: "link";
  id: ToolbarMenuItemId;
  label: string;
  href: string;
}

export type ToolbarMenuItem = ToolbarMenuZoomItem | ToolbarMenuActionItem | ToolbarMenuLinkItem;

export interface ToolbarMenuInput {
  /** Google 連携アカウントが1件以上あるか(カレンダー/設定/同期 の表示条件) */
  hasAccounts: boolean;
  /** GitHub 連携済みか(実績ペインの表示条件。元の `me.github` ゲートと同じ) */
  hasGitHub: boolean;
  /** 時間軸を持つビューか(月表示にはズームが無い。元の `view !== "month"` ゲートと同じ) */
  hasTimeAxis: boolean;
  /** 同期中(同期ボタンを disabled にする。元の `syncStatus === "syncing"` と同じ) */
  syncing: boolean;
  /** 設定ボタンの aria-label / title(連携アカウントの email や件数を含む、元の文言) */
  settingsLabel: string;
  /** 左ペイン(カレンダー)が開いているか */
  leftPaneOpen: boolean;
  /** 右ペイン(実績)が開いているか */
  paneOpen: boolean;
  onToggleLeftPane: () => void;
  onToggleGitHubPane: () => void;
  onOpenSettings: () => void;
  onSync: () => void;
  onToggleHelp: () => void;
  onConnectGoogle: () => void;
}

/**
 * 並び順の意図: 上から「表示の見え方(ズーム)」→「画面を開く(カレンダー/実績/設定)」→
 * 「実行する(同期)」→「補助(ヘルプ)」→「法的リンク」。よく触るものほど上(親指が届く
 * 側)に置く、という優先ではなく、元のツールバーの左→右の並びをそのまま縦に倒した順序に
 * してある ―― 広幅から狭幅に切り替えたときに「どこへ行ったか」を探しやすくするため。
 *
 * プライバシー/規約は連携状態に関わらず常に入れる。広幅では CalendarPane フッター/設定
 * モーダルからも辿れるが、それらは `me.accounts.length > 0` の内側にあるため、未ログインの
 * スマホ利用者にはこのメニューが唯一の導線になる(Google 審査要件: 法的リンクは常時到達可能)。
 */
export function buildToolbarMenuItems(input: ToolbarMenuInput): ToolbarMenuItem[] {
  const items: ToolbarMenuItem[] = [];

  if (input.hasTimeAxis) {
    items.push({ kind: "zoom", id: "zoom", label: "時間軸の高さ" });
  }

  if (input.hasAccounts) {
    items.push({
      kind: "action",
      id: "calendar",
      icon: "calendar",
      label: "カレンダー",
      ariaLabel: "カレンダー",
      title: "カレンダー",
      onClick: input.onToggleLeftPane,
      expanded: input.leftPaneOpen,
    });
  }

  if (input.hasGitHub) {
    items.push({
      kind: "action",
      id: "actuals",
      icon: "timer",
      label: "実績",
      ariaLabel: "実績(記録・タイマー・履歴)",
      title: "実績(右ペインを開く: 実行中・作業キュー・記録・履歴)",
      onClick: input.onToggleGitHubPane,
      expanded: input.paneOpen,
    });
  }

  if (input.hasAccounts) {
    items.push({
      kind: "action",
      id: "settings",
      icon: "gear",
      label: "設定",
      ariaLabel: input.settingsLabel,
      title: input.settingsLabel,
      onClick: input.onOpenSettings,
    });
    items.push({
      kind: "action",
      id: "sync",
      icon: "sync",
      label: "同期",
      ariaLabel: "同期",
      title: "同期",
      onClick: input.onSync,
      disabled: input.syncing,
    });
  } else {
    items.push({
      kind: "action",
      id: "connect-google",
      icon: "google",
      label: "Google 連携",
      ariaLabel: "Google 連携",
      onClick: input.onConnectGoogle,
    });
  }

  items.push({
    kind: "action",
    id: "help",
    icon: "help",
    label: "キーボードショートカット",
    ariaLabel: "キーボードショートカット一覧",
    title: "キーボードショートカット (?)",
    onClick: input.onToggleHelp,
  });

  items.push({ kind: "link", id: "privacy", label: "プライバシー", href: "/privacy.html" });
  items.push({ kind: "link", id: "terms", label: "規約", href: "/terms.html" });

  return items;
}
