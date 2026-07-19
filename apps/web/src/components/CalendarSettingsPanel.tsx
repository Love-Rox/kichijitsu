import { useState } from 'react'
import type { AccountDTO, CalendarListEntryDTO } from '@kichijitsu/shared'
import type { VisibleCalendarsMap } from '../db/database'
import './CalendarSettingsPanel.css'

interface CalendarSettingsPanelProps {
  accounts: AccountDTO[]
  /** アカウントごとのカレンダー一覧。未取得・取得失敗のアカウントは未設定 or 空配列のまま(壊れないことを優先) */
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>
  visibleCalendars: VisibleCalendarsMap
  onToggleCalendar: (accountId: string, calendarId: string, nextChecked: boolean) => void
  /** 成功すれば解決、失敗すれば reject する。エラー表示はこのコンポーネント側(行ごとの確認 UI)が持つ */
  onDisconnectAccount: (accountId: string) => Promise<void>
  onAddAccount: () => void
}

/**
 * ツールバーのアカウント表示部から開くポップオーバー(App.tsx から開閉制御される)。
 * アカウントごとのセクション(email 見出し + カレンダー一覧)+ 最下部の「アカウントを追加」。
 *
 * カレンダーの選択チェックボックスは新規に作らず、既存の枡オーナメント体系
 * (masu.css: 選択=朱の押印 .masu--kichi、未選択=空枡 .masu--empty) をそのまま流用する。
 */
export function CalendarSettingsPanel({
  accounts,
  calendarsByAccount,
  visibleCalendars,
  onToggleCalendar,
  onDisconnectAccount,
  onAddAccount,
}: CalendarSettingsPanelProps) {
  return (
    <div className="calendar-panel" role="dialog" aria-label="カレンダー設定">
      {accounts.length === 0 && (
        <p className="calendar-panel-empty">連携中のアカウントがありません</p>
      )}
      {accounts.map((account) => {
        const calendars = calendarsByAccount[account.id] ?? []
        const visible = visibleCalendars[account.id] ?? []
        return (
          <div className="calendar-panel-account" key={account.id}>
            <div className="calendar-panel-account-header">{account.email}</div>
            {calendars.length === 0 ? (
              <p className="calendar-panel-empty">
                カレンダーを読み込み中、または取得できませんでした
              </p>
            ) : (
              <ul className="calendar-panel-list">
                {calendars.map((cal) => {
                  const checked = visible.includes(cal.id)
                  return (
                    <li className="calendar-panel-item" key={cal.id}>
                      <button
                        type="button"
                        className="calendar-panel-checkbox"
                        aria-pressed={checked}
                        aria-label={`${cal.summary}を${checked ? '非表示' : '表示'}にする`}
                        onClick={() => onToggleCalendar(account.id, cal.id, !checked)}
                      >
                        {/*
                          brand/README.md「機能色の例外」: カレンダー選択のようにデータ自体が
                          色を持つ文脈では、選択済み枡の塗りをそのデータの色にしてよい
                          (傾き -8° は維持)。色ドットは冗長になるため置かない。
                          背景色は inline style で .masu--kichi の朱を上書きし、
                          backgroundColor が無い場合だけ CSS のフォールバック(朱)に任せる
                        */}
                        <span
                          className={checked ? 'masu masu--kichi' : 'masu masu--empty'}
                          style={checked && cal.backgroundColor ? { background: cal.backgroundColor } : undefined}
                        />
                      </button>
                      <span className="calendar-panel-cal-name">{cal.summary}</span>
                    </li>
                  )
                })}
              </ul>
            )}
            <AccountDisconnectControl accountId={account.id} onDisconnect={onDisconnectAccount} />
          </div>
        )
      })}
      <button type="button" className="calendar-panel-add-account" onClick={onAddAccount}>
        + アカウントを追加
      </button>
    </div>
  )
}

type DisconnectRowState = 'idle' | 'confirming' | 'disconnecting' | 'error'

/**
 * アカウント1件ぶんの「連携解除」導線。App.tsx の旧単一アカウント実装と同じ
 * 「window.confirm を使わないインライン2段階確認」を、行ごとに独立した
 * ローカル state として持つ(アカウントが複数あっても他の行に影響しない)。
 */
function AccountDisconnectControl({
  accountId,
  onDisconnect,
}: {
  accountId: string
  onDisconnect: (accountId: string) => Promise<void>
}) {
  const [state, setState] = useState<DisconnectRowState>('idle')

  if (state === 'confirming' || state === 'disconnecting') {
    return (
      <span className="calendar-panel-disconnect-confirm">
        連携解除しますか？
        <button
          type="button"
          className="calendar-panel-text-btn"
          disabled={state === 'disconnecting'}
          onClick={() => {
            setState('disconnecting')
            onDisconnect(accountId).catch((err) => {
              console.error('kichijitsu: account disconnect failed', err)
              setState('error')
            })
            // 成功時は呼び出し元 (App.tsx) が accounts から本行ごと除去するので
            // ここでの idle 復帰は不要
          }}
        >
          解除する
        </button>
        <button
          type="button"
          className="calendar-panel-text-btn"
          disabled={state === 'disconnecting'}
          onClick={() => setState('idle')}
        >
          やめる
        </button>
      </span>
    )
  }

  return (
    <span className="calendar-panel-disconnect-row">
      <button type="button" className="calendar-panel-text-btn" onClick={() => setState('confirming')}>
        連携解除
      </button>
      {state === 'error' && <span className="calendar-panel-error">解除失敗</span>}
    </span>
  )
}
