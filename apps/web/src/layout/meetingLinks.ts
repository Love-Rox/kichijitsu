/**
 * 会議 URL 判定の純粋関数 (2026-07-25)。
 *
 * 背景: Slack ハドルの予定は Google カレンダー上で `conferenceData`/`hangoutLink` を
 * 持たず、**`location` に huddle URL がそのまま入る**形で届く
 * (実データ: `https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW`)。そのため
 * `Occurrence.hasConference` は false のまま、場所テキスト行に長い URL が生で出て
 * しまっていた。ここで location が「会議 URL かどうか」を判定し、UI 側では生 URL の
 * 代わりにプロバイダのアイコン + 短いラベル(例: Slack ハドル)を出す。
 *
 * DOM/React に依存しない判定のみをここに置く(layout/ の純関数層の流儀)。
 * アイコンの出し分けは呼び出し側 (components/EventBlock.tsx) の責務。
 */

/** location が会議 URL だったときの提供元。増える場合はここと meetingProviderLabel に追加する */
export type MeetingProvider = "slack" | "meet" | "zoom" | "teams";

const PROVIDER_LABELS: Record<MeetingProvider, string> = {
  slack: "Slack ハドル",
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Teams",
};

/** 表示用の短いラベル(UI で生 URL の代わりに出す文字列) */
export function meetingProviderLabel(provider: MeetingProvider): string {
  return PROVIDER_LABELS[provider];
}

/** host がその登録ドメイン自身か、そのサブドメインか(`*.example.com` 相当) */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * location 文字列が会議 URL なら提供元を返す。会議 URL でなければ null。
 *
 * location は住所・会議室名など URL ではない自由テキストのことも多いため、
 * `new URL()` の失敗 (= URL でない) は例外にせず null として扱う。http/https 以外の
 * スキーム (mailto: など) も会議リンクではないので null。ホストは大文字小文字を
 * 無視し (URL パーサが小文字化する)、パス判定側も明示的に小文字化して比較する。
 */
export function detectMeetingProvider(location: string | undefined): MeetingProvider | null {
  const raw = location?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // 住所テキスト等、URL として解釈できないものはすべてここ
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  // Slack は「ワークスペースのどこかの URL」全般ではなくハドルだけを会議扱いにする
  // (チャンネル URL などを「会議」と誤表示しないため)
  if (hostMatches(host, "slack.com") && path.includes("/huddle/")) return "slack";
  if (hostMatches(host, "meet.google.com")) return "meet";
  if (hostMatches(host, "zoom.us")) return "zoom";
  if (hostMatches(host, "teams.microsoft.com")) return "teams";
  return null;
}

/**
 * 「この予定に参加するために開く URL」を決める (会議参加 URL、2026-07-25)。
 *
 * 2つの入口がある:
 * - `conferenceUrl` (Occurrence.conferenceUrl): Google Meet やカレンダーのアドオン経由の
 *   Zoom/Teams。URL は location ではなく conferenceData/hangoutLink 側にあり、サーバー
 *   (apps/sync の deriveConferenceUrl) が既に「開いてよい http(s) の URL」1つに絞り込んで
 *   いるため、ここでは追加の判定をせずそのまま採用する ―― Google が会議の正本として
 *   持っている URL なので、プロバイダを判定できない (detectMeetingProvider が null になる)
 *   社内ツール等でも参加リンクとして使えるべき。
 * - `location`: Slack ハドルのように location に URL がそのまま入るケース。こちらは自由
 *   テキスト(住所・会議室名)も来るため、detectMeetingProvider が会議 URL と認めたときのみ
 *   採用する。
 *
 * どちらでもなければ undefined (= 参加リンクを出さない)。
 * 表示ラベル・アイコンの出し分けは呼び出し側が detectMeetingProvider(戻り値) で行う。
 */
export function resolveMeetingUrl(
  conferenceUrl: string | undefined,
  location: string | undefined,
): string | undefined {
  const conference = conferenceUrl?.trim();
  if (conference) return conference;
  const raw = location?.trim();
  if (raw && detectMeetingProvider(raw)) return raw;
  return undefined;
}

/**
 * location を UI に文字で出すときの表示文字列。会議 URL なら生 URL の代わりに
 * プロバイダのラベルを返し、それ以外(住所・会議室名)はそのまま返す。
 * ツールチップ・検索結果の1行など「アイコンを添えられない場所」で使う。
 */
export function meetingLocationLabel(location: string | undefined): string | undefined {
  const provider = detectMeetingProvider(location);
  return provider ? meetingProviderLabel(provider) : location;
}
