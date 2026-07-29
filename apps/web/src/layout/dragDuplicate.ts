/**
 * Option(Alt)+ドラッグによる予定の複製 (2026-07-29、ユーザー要望) の判定ロジック。
 *
 * ここが必要になった理由 ―― Option(Alt) は**既にスナップ解除に使われている**
 * (layout/snap.ts の SnapContext.disableSnap、EventBlock/PlannedBlock の `disableSnap: e.altKey`)。
 * 「15分刻みを外して1分単位で動かす」修飾キーと「複製する」修飾キーが同じキーになるため、
 * 両立させる規則をここに1本化する:
 *
 *   - **ドラッグ開始時 (pointerdown) に Option を押していたら → そのドラッグは「複製」**。
 *     開始時に決めたら、途中で Option を離しても複製のまま(一度決めた意味は変わらない)。
 *   - **開始時に押していなければ → 従来どおり「移動」**。途中で Option を押したら
 *     その瞬間からスナップ解除が効く(既存挙動を一切変えない)。
 *
 * なぜ「押し始めか途中か」で意味を変えるのか:
 *   1. 複製かどうかはドラッグの**結果**(新しい予定を作るか、元を動かすか)を変えるので、
 *      指を離す瞬間まで揺れ続けると「どちらになるか分からないまま引きずる」操作になる。
 *      pointerdown で確定させれば、掴んだ瞬間に意味が決まり、以後ブレない。
 *   2. スナップ解除は逆に「動かしている途中で微調整したい」修飾なので、ドラッグ中に
 *      押したり離したりできる必要がある ―― pointerdown 時点に固定してはいけない。
 *   この2つは求められる寿命が違うだけで衝突しない、というのがこの設計の核心。
 *
 * リサイズには複製が無いため、リサイズ側の Option は従来どおりスナップ解除のみ
 * (この関数群はリサイズ経路からは呼ばれない)。
 */

/** そのドラッグが何をするか。pointerdown で決まり、pointerup まで変わらない */
export type DragIntent = "move" | "duplicate";

export interface ResolveDragIntentParams {
  /** PointerEvent.pointerType ("mouse" / "pen" / "touch") */
  pointerType: string;
  /** pointerdown 時点の PointerEvent.altKey */
  altKey: boolean;
  /**
   * この予定を複製してよいか (sync/eventCreate.ts の canDuplicateOccurrence)。
   * 書き込めない相手(他人のカレンダー・ミラー・Busy プレースホルダ等)では false になり、
   * 複製ドラッグをそもそも始めない ―― 始めてから「作れませんでした」と失敗させるより、
   * 最初から従来どおりの移動として振る舞う方が驚きが少ない。
   */
  canDuplicate: boolean;
}

/**
 * pointerdown の時点で、このドラッグを「複製」にするか「移動」にするかを決める。
 *
 * タッチ(スマホ)には修飾キーが無いので altKey は常に false であり複製は起きないが、
 * 「タップで選択 → ドラッグで移動」(layout/swipeNav.ts) という既存の操作体系を将来の
 * 実装ミスで壊さないよう、pointerType==="touch" は明示的に move へ倒しておく
 * (この保証自体をテストで固める)。
 */
export function resolveDragIntent({
  pointerType,
  altKey,
  canDuplicate,
}: ResolveDragIntentParams): DragIntent {
  if (pointerType === "touch") return "move";
  if (!altKey) return "move";
  return canDuplicate ? "duplicate" : "move";
}

export interface SnapDisabledParams {
  /** resolveDragIntent が pointerdown で決めた意味 */
  intent: DragIntent;
  /** **今この瞬間**の PointerEvent.altKey (pointermove ごとに変わってよい) */
  altKey: boolean;
}

/**
 * ドラッグ中の各 pointermove で「スナップを外すか」を決める (layout/snap.ts の disableSnap)。
 *
 * 判断 ―― **複製中は 15分スナップを効かせたままにする** (intent==="duplicate" では常に false)。
 * 理由: 複製ドラッグでは Option を押しっぱなしにするのが自然な操作
 * (押し始めに押していれば複製、という規則の上では途中で離してもよいが、
 * 実際には掴んだまま押し続ける人がほとんど)。ここで altKey をそのままスナップ解除に流すと
 * 「複製すると必ず 1分刻みになる」ことになり、複製された予定の時刻が 10:07 のような
 * 半端な値になってしまう。複製の主目的は「同じ内容の予定をもう1つ、きりのいい時刻に置く」
 * ことなので、スナップは効かせる方が素直。
 * 複製したうえで1分単位に置きたい場合は、複製後にその予定を Option 無しで掴んで
 * 途中で Option を押せば従来どおり微調整できる ―― 操作としても到達可能。
 */
export function isSnapDisabledDuringDrag({ intent, altKey }: SnapDisabledParams): boolean {
  if (intent === "duplicate") return false;
  return altKey;
}
