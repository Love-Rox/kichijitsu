/**
 * スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22)の純ロジック。
 * WeekGrid.tsx の3パネルストリップ(prev/current/next、`stripStyle` の translateX で
 * 横スライドする既存構造、dayGrid.ts の panelAnchors/panelSlideDirection と対になる)を
 * 指に追従させ、離した時に「何日ぶん動かすか(0 なら元に戻す)」を決めるための計算だけを
 * DOM/React から切り離してここに置く(dayGrid.ts と同じ流儀)。
 *
 * ジェスチャの実 DOM 配線(pointerdown/move/up の購読、setPointerCapture 等)は
 * hooks/useSwipeNavigation.ts が担い、判定・数値計算はすべてここへ委譲する。
 */

/**
 * スマホの操作体系(2026-07-26、ユーザー要望)――
 * 「どこをスワイプしても日移動できる」/「予定はタップして選んでからドラッグで移動」を
 * 成立させるための、ジェスチャの振り分け(スワイプ vs カードのドラッグ)の判定もここに置く。
 * DOM を直接触らずに済むよう、必要な最小面(closest だけ)を SwipeTargetLike として切り出し、
 * テストでは素のオブジェクトで代用できるようにしてある(この設計判断自体が仕様)。
 */

/** 選択中の予定/予定タイムブロックに付ける印。CSS(EventSelection.css)と判定の両方で使う */
export const SELECTED_CARD_CLASS = "is-card-selected";
/** 「タップで選択してからドラッグ」モード(スマホ幅)のカードに付ける印。CSS の touch-action 切替に使う */
export const TAP_SELECT_CARD_CLASS = "is-tap-select";

/** 予定カード / 予定タイムブロック(自前の pointer ドラッグを持つカード) */
export const SWIPE_CARD_SELECTOR = ".event, .planned-block";
/** 選択中カード。単一クラスセレクタに保つ(判定を closest 1回で済ませるため) */
export const SWIPE_SELECTED_CARD_SELECTOR = `.${SELECTED_CARD_CLASS}`;
/**
 * 選択状態に関わらず常にスワイプ対象外にするもの ――
 * 詳細ポップオーバー(実際は body へ portal されるので .week-grid には来ないが保険)と、
 * 自前のタップ/入力を持つフォーム部品。
 */
export const SWIPE_CONTROL_EXCLUDE_SELECTOR =
  ".event-detail-popover, .event-detail-backdrop, input, textarea, button, a";

/** shouldIgnoreSwipeStart / shouldClearSelectionOnPointerDown が必要とする DOM の最小面 */
export interface SwipeTargetLike {
  closest(selectors: string): SwipeTargetLike | null;
}

/**
 * pointerdown の起点(target)を見て、このジェスチャを日移動スワイプの候補から外すか判定する。
 *
 * 2026-07-26 以前は「.event / .planned-block の上から始まった pointerdown は常に除外」という
 * 静的セレクタだった ―― 予定が密な日ではスワイプの開始位置がほぼ塞がれ、「スワイプのスタート
 * 位置が悪いと戻される」というユーザー報告の直接の原因になっていた。そこで:
 *
 * - タッチかつ「未選択のカード」の上: 除外しない(false)。カード側(EventBlock/PlannedBlock)も
 *   shouldBeginCardDrag で自分のドラッグを始めないので、pointerdown はそのまま .week-grid の
 *   スワイプに拾われる ―― どこをスワイプしても日が動く。
 * - タッチかつ「選択中のカード」の上: 除外する(true)。選択済みのカードはドラッグ移動/リサイズが
 *   優先で、横スワイプは発動させない。
 * - マウス/ペン: カード上は従来どおり除外(そもそもフック側が pointerType!=="touch" で
 *   起動しないため到達しないが、判定関数としての完全性のため明示しておく)。
 * - フォーム部品・詳細ポップオーバー: 選択状態に関わらず常に除外。
 */
export function shouldIgnoreSwipeStart(
  target: SwipeTargetLike | null | undefined,
  { pointerType }: { pointerType: string },
): boolean {
  if (!target) return false;
  if (target.closest(SWIPE_CONTROL_EXCLUDE_SELECTOR)) return true;
  // 選択中カード(またはその子)から始まったら、そのカードのドラッグを優先する
  if (target.closest(SWIPE_SELECTED_CARD_SELECTOR)) return true;
  // カードの外(日列の背景等)は従来どおりスワイプ候補
  if (!target.closest(SWIPE_CARD_SELECTOR)) return false;
  // 未選択カードの上: タッチのときだけスワイプを通す
  return pointerType !== "touch";
}

/**
 * カード(EventBlock / PlannedBlockCard)の pointerdown で、その場でドラッグ移動/リサイズを
 * 始めてよいかを判定する。
 *
 * - selectBeforeDrag=false(デスクトップ、= longPressCreate が false の広い幅): 常に true。
 *   マウスでもタッチでも従来どおり pointerdown で即ドラッグを開始する(挙動を一切変えない)。
 * - selectBeforeDrag=true(スマホ幅)かつタッチ: 選択中のカードだけドラッグを始める。
 *   未選択なら false ―― 呼び出し側は pointerdown を素通しし(setPointerCapture も
 *   stopPropagation もしない)、.week-grid の横スワイプに拾わせる。タップ(移動なしの
 *   pointerup)だけを自前で見張って「選択+詳細ポップオーバー」に繋げる。
 * - selectBeforeDrag=true でもマウス/ペンなら true(スマホ幅でマウスを繋いだ場合に
 *   操作不能にしない ―― 横スワイプ自体もタッチ限定なので競合しない)。
 */
export function shouldBeginCardDrag({
  pointerType,
  selectBeforeDrag,
  isSelected,
}: {
  pointerType: string;
  selectBeforeDrag: boolean;
  isSelected: boolean;
}): boolean {
  if (!selectBeforeDrag) return true;
  if (pointerType !== "touch") return true;
  return isSelected;
}

/**
 * 選択解除の判定。.week-grid で pointerdown を観測したとき、その起点が「選択中カードの外」なら
 * 解除する(true)。
 *
 * 解除条件をこの1点に寄せている理由: 詳細ポップオーバーの開閉(EventBlock の detailPos)と
 * 選択状態を同一視すると、useCloseOnOutsideOrEscape が「カード自身の pointerdown」も
 * 外側クリックとみなして閉じるため、選択カードを掴んでドラッグし始めた瞬間に選択が外れてしまう。
 * そこで選択は WeekGrid 側の独立した state とし、「別の場所を触った」「日を移動した」という
 * 分かりやすい2条件だけで解除する(ポップオーバーは従来どおり独立して開閉する)。
 * 詳細ポップオーバーは body へ portal されるため .week-grid の pointerdown には来ない
 * (= ポップオーバー内の操作で選択が外れることはない)。
 */
export function shouldClearSelectionOnPointerDown(
  target: SwipeTargetLike | null | undefined,
): boolean {
  if (!target) return true;
  return target.closest(SWIPE_SELECTED_CARD_SELECTOR) === null;
}

/** 「横方向が支配的」と確定するまでの最小移動量(px)。ごく僅かな指のブレでは反応しない */
export const SWIPE_DIRECTION_MIN_PX = 10;
/** |dx| が |dy| のこの倍数を超えたら横方向優勢、そうでなければ縦方向(スクロール等)優勢とみなす。
 * スマホの親指スワイプは弧を描いて縦成分が乗りやすいため、やや緩め(1.25)にして「横に振ったのに
 * 縦扱いで反応しない」を減らす ―― 縦スクロールは |dy| が圧倒的に大きく、この値でも安全に vertical へ倒れる。
 * ただしこの緩さを適用するのは縦成分がまだ小さいうち(SWIPE_VERTICAL_SLOP_PX 以下)だけ ――
 * 理由は下記 SWIPE_DIRECTION_DOMINANCE_STRICT のコメント参照。 */
export const SWIPE_DIRECTION_DOMINANCE = 1.25;
/**
 * 「ブラウザがまだ縦パンを始めていない」とみなせる縦移動量の上限(px)。
 * .week-grid-scroll は touch-action: pan-y なので、縦方向の touch slop(Chrome/Safari で概ね
 * 8px 前後)を超えた時点でブラウザ側のネイティブ縦スクロールが走り始め、こちらが後から
 * setPointerCapture しても「縦に流れながら横にも追従する」二重挙動は止められない。
 * そのため縦成分がこの値を超えていたら、横確定の条件を厳しく(STRICT)する。
 */
export const SWIPE_VERTICAL_SLOP_PX = 8;
/**
 * 縦成分が SWIPE_VERTICAL_SLOP_PX を超えた後に横スワイプへ入るために必要な優勢比。
 * 斜めスワイプ(例 dx=20 / dy=12)は 1.25 倍だと horizontal に倒れてしまうが、その時点で
 * 既に縦スクロールが始まっているため見た目が破綻する(縦に流れながら横追従)。
 * 一方で完全に横方向へ振った速いフリック(例 dx=60 / dy=15 が1イベントで届く)は救いたいので、
 * 「明確に横」と言える倍率を要求する ―― 縦成分が slop 以下のうちに横が決まる通常の
 * 横スワイプ(dy がほぼ 0)はこの経路に入らないため、体感は変わらない。
 *
 * 2.5 → 2.0 に緩和(2026-07-26): 2.5 は水平から約 21.8°、親指で弧を描くスワイプだと
 * 「横に振ったのに反応しない」が起きやすかった。2.0(約 26.6°)なら dx=30/dy=12 のような
 * 明確な横振りを拾えるようになる一方、M-7 の再現ケース(dx=20/dy=12 → 20 > 24 は偽)は
 * 引き続き vertical に倒れるため、縦スクロールを奪う退行にはならない。
 */
export const SWIPE_DIRECTION_DOMINANCE_STRICT = 2.0;
/** フリックとみなす速度の閾値(px/ms)。0.3px/ms ≒ 300px/s ―― 丸めた日数が 0 でも
 * これを超える速さで離せば速度の向きへ最低1日は送る(要件の「フリック速度」対応)。軽いフリックでも
 * 効くよう 0.5→0.3 に緩和(2026-07-22) */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.3;
/**
 * 指を離した瞬間の勢い(px/ms)を「この先何ミリ秒ぶん動き続けるか」として移動量に上乗せする量。
 * これにより速く振り抜いたスワイプは、実際の指の移動量が半日ぶんに届いていなくても次の日境界を
 * 越えて丸まる(逆に、強いフリックなら 1.5 日ぶんの移動でも 2 日先へ届く)。
 * 80ms は「フリック閾値 0.3px/ms でも +24px(≒0.2日ぶん)、強いフリック 1.5px/ms なら +120px」
 * となる控えめな値 ―― 大きくしすぎると狙った日を通り越すため、体感優先でこの程度に留める。
 */
export const SWIPE_FLICK_PROJECTION_MS = 80;
/** フリック速度を「直近何ミリ秒ぶんのサンプルで測るか」のウィンドウ幅。pointerup 直前の
 * 1サンプルだけだと、指を止めてから離したときに速度 0 と誤検出されフリックが効かないため、
 * この時間窓の端点差分で平均速度を出す(computeTrailingVelocity 参照) */
export const SWIPE_VELOCITY_WINDOW_MS = 100;

export type SwipeAxis = "pending" | "horizontal" | "vertical";

/**
 * touchstart(pointerdown)からの累積移動量 (dx, dy) を見て、このジェスチャが
 * 「日付ナビ用の横スワイプ」なのか「縦スクロール/その他(イベントドラッグ・新規作成)に
 * 委ねるべき」なのかを判定する。
 *
 * - "pending": まだ両軸とも移動量が閾値未満 ―― 判定を保留し、次の pointermove を待つ
 *   (呼び出し側はまだ何もせず、既存のイベントドラッグ/新規作成/スクロールにも介入しない)。
 * - "horizontal": |dx| が |dy| の必要優勢比を超えた ―― 横スワイプ確定。呼び出し側はここで
 *   初めて transform 追従を始めてよい。必要優勢比は縦成分の大きさで2段階
 *   (|dy| <= SWIPE_VERTICAL_SLOP_PX なら緩い DOMINANCE、超えていたら STRICT)。
 * - "vertical": 横方向が優勢でない(縦優勢、または閾値は超えたが横が明確でない) ―― 従来通り
 *   (縦スクロール・イベントドラッグ・新規作成)に委ねるべきサイン。
 */
/** フリック速度算出用の1サンプル(pointermove/up 時のクライアント X 座標と時刻) */
export interface SwipeSample {
  x: number;
  time: number;
}

/**
 * 直近 windowMs ミリ秒ぶんのサンプルから、水平方向の平均速度(px/ms)を求める。
 * pointerup 直前の1区間だけを見ると、指を止めてから離した場合に速度が 0 と誤検出され
 * フリックが実質効かなくなる(旧実装の症状)。そこで「最新サンプルから windowMs 以内に
 * 収まる最古サンプル」との端点差分で平均速度を出し、離す直前の勢いを安定して拾う。
 *
 * samples は時刻昇順(古い→新しい)を前提。2点未満、または端点の時間差が無いときは 0。
 */
export function computeTrailingVelocity(
  samples: readonly SwipeSample[],
  windowMs: number = SWIPE_VELOCITY_WINDOW_MS,
): number {
  if (samples.length < 2) return 0;
  const newest = samples[samples.length - 1];
  let oldest = newest;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (newest.time - samples[i].time <= windowMs) {
      oldest = samples[i];
    } else {
      break; // それ以上遡ると窓の外(samples は昇順なので以降も全て窓外)
    }
  }
  const dt = newest.time - oldest.time;
  if (dt <= 0) return 0;
  return (newest.x - oldest.x) / dt;
}

export function classifySwipeAxis(
  dx: number,
  dy: number,
  minPx: number = SWIPE_DIRECTION_MIN_PX,
  dominance: number = SWIPE_DIRECTION_DOMINANCE,
  verticalSlopPx: number = SWIPE_VERTICAL_SLOP_PX,
  strictDominance: number = SWIPE_DIRECTION_DOMINANCE_STRICT,
): SwipeAxis {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < minPx && ady < minPx) return "pending";
  // 縦成分が slop を超えている(=ブラウザのネイティブ縦パンが既に始まっている)なら、
  // 横確定にはより圧倒的な優勢を要求する(斜めスワイプでの二重挙動を避ける、M-7)
  const requiredDominance = ady <= verticalSlopPx ? dominance : strictDominance;
  return adx > ady * requiredDominance ? "horizontal" : "vertical";
}

/**
 * 横スワイプ確定中、指に追従させる strip の transform 文字列を作る。
 * basePercent は現在表示中のパネルが指す translateX の基準値(%)、dxPx は pointerdown からの
 * 指の水平移動量(px)。calc() で % と px を混在させることで、パネル幅を px で計算し直す必要なく
 * そのまま「基準位置 + 指の移動量」を表現できる。
 *
 * **現在この関数を呼ぶ本体コードは無い**(呼び出し元は単体テストだけ)―― WeekGrid は
 * transform 文字列を JS で組み立てるのをやめ、CSS 変数2本
 * (--strip-base = 基準%、--swipe-dx = 指追従 px)を渡して WeekGrid.css 側で
 * translateX(calc(var(--strip-base) + var(--swipe-dx))) と合成する方式に変えた
 * (React 再レンダーなしで指に追従させるため)。同じ calc() の組み立て規則をここが
 * 実行可能な形で持っている状態なので、消すならテストごと落とすこと。
 */
export function swipeStripTransform(basePercent: number, dxPx: number): string {
  if (dxPx === 0) return `translateX(${basePercent}%)`;
  return `translateX(calc(${basePercent}% + ${dxPx}px))`;
}

export interface ResolveSwipeDaysParams {
  /** pointerdown からの水平方向の累積移動量(px)。正=右(指を右へ)、負=左 */
  dxPx: number;
  /** 1日カラムぶんの表示幅(px、= パネル幅 / dayCount)。0 以下なら常に 0(未測定の保険) */
  dayWidthPx: number;
  /** 進める日数の上限(絶対値)。WeekGrid のレンダー済み3パネルに収まる dayCount を渡す */
  maxDays: number;
  /** 離す直前の一定時間窓での水平速度(px/ms)。正=右へ動いている */
  velocityPxPerMs: number;
  /** フリックとみなす速度閾値(px/ms、既定 0.3) */
  flickVelocityPxPerMs?: number;
  /** 勢いを移動量へ上乗せする時間(ms、既定 80) */
  flickProjectionMs?: number;
}

/**
 * pointerup(指を離した瞬間)の移動量・速度から、表示窓を「何日ぶん」動かすかを決める。
 *
 * 戻り値は timelineStart に足す日数 ―― 正=先(未来)へ / 負=前(過去)へ / 0=確定せず元の位置へ戻す。
 * 指を右へ動かす(dxPx > 0)とストリップが右へ寄って前の日が覗くので、符号は反転する
 * (WeekGrid.tsx の baseStripPercent / slideDays は「正=先へ」なのでそのまま渡せる)。
 *
 * 旧実装(resolveSwipeOutcome)は "prev"/"next"/"stay" の3値しか返さず、どれだけ指を動かしても
 * 確定後は必ず1日しか進まなかった。3日ビューでは1日 = ビューポート幅の 1/3 なので、1.5日ぶん
 * 動かして離すと strip が指より 0.5日ぶん手前へ戻り「スナップしそうな所で戻される」体感になっていた
 * (2026-07-26 修正)。ここでは「指を離した位置に最も近い日」へ丸めることで、strip が必ず
 * 指の位置の近傍へスナップするようにする。
 *
 * - 距離: `Math.round(移動量 / 1日カラム幅)` ―― 0.5日を境に手前/奥どちらか近い方の日へ。
 *   旧 SWIPE_SNAP_DISTANCE_RATIO(パネル幅の18%)は役割を失うので廃止した。
 * - 勢い: 離した瞬間の速度を flickProjectionMs ぶん先へ延長した位置で丸める(慣性)。
 *   速く振り抜けば半日ぶん届いていなくても次の日へ、強ければ2日以上先へも届く。
 * - フリック保証: 丸めて 0 日になっても速度が閾値を超えていれば、速度の向きへ最低1日は送る
 *   (「短い距離で素早くフリック」を取りこぼさないため)。
 * - クランプ: WeekGrid がレンダーしているのは中央 ± dayCount 日ぶんの3パネルだけで、
 *   それを超える移動はスライドアニメーションできず瞬時切替になる(WeekGrid の
 *   `Math.abs(delta) <= dayCount` 判定)。そのため |日数| <= maxDays に制限する。
 */
export function resolveSwipeDays({
  dxPx,
  dayWidthPx,
  maxDays,
  velocityPxPerMs,
  flickVelocityPxPerMs = SWIPE_FLICK_VELOCITY_PX_PER_MS,
  flickProjectionMs = SWIPE_FLICK_PROJECTION_MS,
}: ResolveSwipeDaysParams): number {
  if (!(dayWidthPx > 0) || !(maxDays >= 1)) return 0;

  // 離した瞬間の勢いぶんだけ先へ延長した「着地点」で丸める(慣性スクロールの簡易版)
  const projectedPx = dxPx + velocityPxPerMs * flickProjectionMs;
  let dragDays = Math.round(projectedPx / dayWidthPx);

  // フリック保証: 丸めが 0 でも十分速ければ速度の向きへ1日送る
  if (dragDays === 0 && Math.abs(velocityPxPerMs) > flickVelocityPxPerMs) {
    dragDays = velocityPxPerMs > 0 ? 1 : -1;
  }
  if (dragDays === 0) return 0;

  const clamped = Math.min(Math.abs(dragDays), Math.floor(maxDays)) * Math.sign(dragDays);
  // dragDays は「strip/指が動いた向き」。右(正)へ動かす = 前の日へ戻るので符号を反転する。
  return -clamped;
}
