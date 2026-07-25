import type { ReactElement } from "react";
import type { MeetingProvider } from "../layout/meetingLinks";
import { MeetIcon, SlackIcon, TeamsIcon, VideoIcon, ZoomIcon, type IconProps } from "./icons";

/**
 * 会議 URL の提供元 → アイコンの対応(2026-07-25)。プロバイダを足すときは
 * layout/meetingLinks.ts の MeetingProvider とこの表の2箇所だけを触れば、
 * カード・ヘッダー小アイコン・詳細ポップオーバーのリンクすべてに反映される
 * (各表示箇所に条件分岐を散らさないための単一の対応表)。
 */
const MEETING_PROVIDER_ICONS: Record<MeetingProvider, (props: IconProps) => ReactElement> = {
  slack: SlackIcon,
  meet: MeetIcon,
  zoom: ZoomIcon,
  teams: TeamsIcon,
};

/**
 * 会議 URL の提供元アイコン(2026-07-25、Slack ハドル表示)。location が会議 URL
 * (layout/meetingLinks.ts の detectMeetingProvider が非 null)のときに、生 URL の代わりに
 * 出すアイコン。provider が判定できない通常の会議リンク(hasConference のみ true 等)は
 * 従来どおり汎用の VideoIcon にフォールバックする。
 *
 * 予定カード (EventBlock.tsx) と詳細ポップオーバー (EventDetailCard.tsx) の両方が使うため、
 * どちらにも属さないこのファイルに置いてある(リファクタ フェーズ1a、2026-07-25)。
 */
export function MeetingProviderIcon({
  provider,
  width,
  height,
}: {
  provider: MeetingProvider | null;
  width: number;
  height: number;
}) {
  const Icon = provider === null ? VideoIcon : MEETING_PROVIDER_ICONS[provider];
  return <Icon width={width} height={height} />;
}
