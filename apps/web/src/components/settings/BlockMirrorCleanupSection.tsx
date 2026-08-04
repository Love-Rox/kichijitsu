/**
 * 設定モーダルの「コピー先に残ったブロック予定の掃除」セクション
 * (docs/blocking.md「ミラー予定の後始末」節、末尾「将来やるならこれ」2026-07-28 追記分)。
 *
 * BlockRulesSection.tsx のすぐ隣に置く ―― どちらもカレンダーブロック機能の入口で、
 * 「ルールを設定する」と「(ルールの有無に関わらず)コピー先に残った予定を片付ける」は
 * 対になる操作だから。中身(走査・一覧・選択削除)は BlockRulesOverlay と同じく専用の
 * オーバーレイ (BlockMirrorCleanupOverlay) に持たせ、ここは説明文と入口ボタンだけを持つ
 * (BlockRulesSection と同じ役割分担)。
 */
export function BlockMirrorCleanupSection({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">コピー先に残ったブロック予定の掃除</h3>
      <p className="settings-modal-section-desc">
        ルールを削除・変更したりアカウント連携を解除したりすると、コピー先に作った「予定あり」が
        残ることがあります。ここでまとめて探して削除できます。
      </p>
      <button type="button" className="settings-modal-add-account" onClick={onOpen}>
        残ったブロック予定を掃除する
      </button>
    </section>
  );
}
