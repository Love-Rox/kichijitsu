/**
 * 詳細ポップオーバー (components/EventDetailCard.tsx) の「会議 / 場所」行の出し分けを
 * 決める純粋関数(リファクタ フェーズ1a、2026-07-25)。
 *
 * なぜ切り出したか: 「参加リンクを出すか」「汎用の『オンライン会議あり』行を出すか」
 * 「場所行を出すか」の3択は、条件が互いに排他 (同じ意味の行を2つ並べない) で JSX の中に
 * 埋めると読み取れず、apps/web には React 描画テストが無いため回帰も検出できなかった。
 * DOM/React に触れない判定だけをここへ集め、テストで固める(layout/ の純関数層の流儀)。
 */

import { detectMeetingProvider, meetingProviderLabel, resolveMeetingUrl } from "./meetingLinks";
import type { MeetingProvider } from "./meetingLinks";

/** 判定に必要な最小限の入力(EventDetailSubject の部分集合) */
export interface EventDetailMeetingInput {
  location?: string;
  conferenceUrl?: string;
  hasConference?: boolean;
}

export interface EventDetailMeetingView {
  /** 参加リンクとして開く URL。undefined なら参加リンクを出さない */
  meetingUrl?: string;
  /** アイコンの出し分け用。会議 URL だがプロバイダ不明(社内ツール等)なら null */
  provider: MeetingProvider | null;
  /** 参加リンクのラベル(例: 「Slack ハドルに参加」/ 不明なら「会議に参加」) */
  meetingLinkLabel: string;
  /**
   * 汎用の「オンライン会議あり」行を出すか。参加リンクが出せるときは同じ意味・同じ
   * アイコンの行が2つ並ぶので省く ―― 会議はあるが URL が取れない場合(電話参加のみの
   * entryPoints 等)だけ true になる(2026-07-25)。
   */
  showConferenceNote: boolean;
  /**
   * 「場所: 〜」行に出す文字列(trim 済み)。出さないときは undefined。
   * location が参加リンクそのもの(Slack ハドル)のときは参加リンクと二重になるので出さず、
   * Meet のように location に会議室名が別途入っている場合は参加リンクと両方出す。
   * 比較は trim 済み同士で行う ―― resolveMeetingUrl は trim した URL を返すため、
   * location 末尾に空白があると生比較では別物になり同じ URL が二重表示されてしまう。
   */
  locationRow?: string;
}

export function resolveEventDetailMeetingView(
  subject: EventDetailMeetingInput,
): EventDetailMeetingView {
  // 参加リンクの解決: location(Slack ハドル)と conferenceUrl(Meet / アドオン経由の
  // Zoom・Teams)のどちらに入っていても1本に解決してからプロバイダを判定する
  const meetingUrl = resolveMeetingUrl(subject.conferenceUrl, subject.location);
  const provider = detectMeetingProvider(meetingUrl);
  const locationText = subject.location?.trim();
  return {
    meetingUrl,
    provider,
    // プロバイダが判定できない会議 URL(未知の entryPoint)でも参加リンクは出す ――
    // resolveMeetingUrl の doc どおり「Google が会議の正本として持っている URL」なので開いてよい
    meetingLinkLabel: provider ? `${meetingProviderLabel(provider)}に参加` : "会議に参加",
    showConferenceNote: subject.hasConference === true && !meetingUrl,
    locationRow: locationText && locationText !== meetingUrl ? locationText : undefined,
  };
}
