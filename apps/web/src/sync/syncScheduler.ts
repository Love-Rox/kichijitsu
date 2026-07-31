/**
 * 同一キーの非同期処理の多重実行を防ぐ、汎用の直列化スケジューラ (2026-07-21)。
 *
 * App.tsx の syncCalendar は SSE hello/changed(useServerEvents)、起動時 runSync、
 * カレンダー選択トグルなど複数経路から await なしで多重に発火しうる。同一
 * (accountId, calendarId) の増分同期と全同期(410 フォールバック)が交錯すると
 * IndexedDB の削除→再投入が競合するため、キー単位で直列化するガードとして使う。
 *
 * 単純な「走行中なら何もしない」だと、走行中の同期が開始した時点より後に届いた
 * 変更(SSE changed 等)を取りこぼす。そのため「走行中に再要求が来たら、完了後に
 * もう1回だけ再実行する」(coalesce & trailing rerun) 方式にしている。
 *
 * ## trailing rerun でどの run を実行するか (2026-07-31 に3度目の改訂)
 *
 * この箇所は 2026-07-29 に「初回の run を再実行する」から「最後に要求された run を実行する」へ
 * 向きを変えている。理由は「通常同期の走行中に全同期 (forceFull) を要求すると、全同期が通常同期の
 * 再実行にすり替わる」取りこぼしを塞ぐため。ところが last-wins は**逆向きに同じ穴**を開けていた
 * ―― 予約された forceFull を、直後に届いた SSE changed の通常同期が上書きして消してしまう。
 * それでいて schedule() が返す Promise は解決するので、設定モーダルは「再同期しました」と嘘をつく。
 *
 * first-wins / last-wins の二択ではどちらかが必ず落ちる。落ちない形にするために、
 * **落としてよい要求かどうかを呼び出し元に宣言させる** (ScheduleOptions.coalesce) 設計にした。
 * スケジューラに「forceFull は通常同期より強い」というドメイン知識を持ち込まずに済むのが利点で、
 * 「利用者が明示的に押した再同期」「バックフィル」のように**実行されたこと自体が意味を持つ**要求は
 * coalesce: false を渡す(hooks/useCalendarSync.ts の syncCalendar 参照)。
 *
 * ### なぜこれで両方向に落ちないのか
 *
 * 待ち行列 (queue) に積むのは「まだ開始していない run」だけで、次の2点を守る:
 *
 *  1. **coalesce: false の run は決して差し替えない・捨てない**。後から通常同期が来ても、
 *     その要求は「今から後に始まる同期が1回あればよい」ものなので、予約済みの forceFull に
 *     *相乗り* させる(待ち手だけ足して run は捨てる)。→ forceFull は必ず走る。
 *  2. 逆に coalesce: false の要求が来たとき、待ち行列の末尾が合流可能な要求なら、それを
 *     **吸収**する(待ち手を引き継ぎ、run は自分のものに差し替える)。合流可能な要求は
 *     「自分より後に始まる同期があれば満たされる」ので、forceFull がそれを兼ねられる。
 *     → 通常同期が forceFull を押しのけることも、余計な1回を増やすこともない。
 *
 * つまり「新しい要求と古い要求のどちらを残すか」ではなく「**捨ててよいと宣言された run だけを
 * 捨てる**」という規則にしたので、どちらの向きでも明示要求が消えない。合流可能な要求どうしは
 * 従来どおり last-wins で1回に潰す(同一キーの run は互換なので、より新しい closure のほうが
 * 常に安全側 ―― 例えばカレンダー色の更新を拾える)。
 *
 * ## schedule() が返す Promise の意味 (2026-07-31)
 *
 * 以前は「そのキーの処理が落ち着いたこと」を表す Promise(走行中の Promise そのもの)を返して
 * いた。これが「実行されていないのに成功」の根本原因だった ―― 自分の run が走ったかどうかを
 * 呼び出し元が観測できない。今は **その要求を満たす run 1回ぶんの結果**を返す:
 *
 *  - coalesce: false … 自分の run の成否がそのまま返る。
 *  - coalesce: true  … 自分の要求より**後に開始した** run 1回の成否が返る(相乗り先の結果)。
 *    合流を選んだ以上「自分の closure が走ったか」は問わないが、「要求より後に始まった同期が
 *    1回は完走した」ことは保証される。
 *
 * 失敗もラウンド単位。1回目が失敗して trailing rerun が成功した場合、1回目を待っていた
 * 呼び出し元だけが reject し、trailing rerun を待っていた呼び出し元は resolve する
 * (以前は failed フラグがラウンドを跨いで残り、成功したはずの呼び出し元まで throw していた)。
 */

/** schedule() に渡す実処理。副作用を持ってよいが、キー単位で直列実行される前提 */
export type SyncRunner = () => Promise<void>;

export interface ScheduleOptions {
  /**
   * この要求を他の要求に合流させてよいか(既定 true)。
   *
   *  - true: 走行中に来た合流可能な要求どうしは1回の trailing rerun に潰される。渡した run
   *    自体は実行されないことがある(同じキーの、より後に始まる run で代替される)。
   *    SSE changed / 起動時 runSync / カレンダー選択トグルなど「最新状態に追いつきたい」要求向け。
   *  - false: この run は必ず1回実行される。設定モーダルの「再同期」や同期バックフィルのように、
   *    **実行されたこと自体**に意味がある(結果を利用者に報告する・完了版数を記録する)要求向け。
   */
  coalesce?: boolean;
}

export interface SyncScheduler {
  /**
   * key の処理を run で実行する。同じ key の処理が既に走行中なら新規には開始せず、
   * 完了後に実行する待ち行列へ積む(合流可能な要求は1回に潰す。詳細はファイル冒頭のコメント)。
   *
   * 返り値の Promise は「**この要求を満たす run 1回**」の結果を表す。resolve したら
   * 「この要求より後に開始した同期が1回完走した」ことが保証される(coalesce: false なら
   * 渡した run そのものが完走したことが保証される)。
   */
  schedule(key: string, run: SyncRunner, options?: ScheduleOptions): Promise<void>;
}

/** 1回ぶんの実行を待っている呼び出し元 (schedule() が返した Promise の resolve/reject) */
interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** 待ち行列の1要素 = 「これから1回実行する run」と、その結果を待っている呼び出し元たち */
interface QueuedRun {
  run: SyncRunner;
  /** false なら差し替え・破棄が禁止された run(呼び出し元が coalesce: false を宣言した) */
  coalescable: boolean;
  waiters: Waiter[];
}

export function createSyncScheduler(): SyncScheduler {
  // 走行中のキー。runLoop が回っている間だけ入っている(ロック本体)
  const running = new Set<string>();
  // キーごとの「まだ開始していない run」の待ち行列。不変条件として、合流可能な要素は
  // 高々1つで必ず末尾にある(合流可能な要素は、後から来た要求に吸収されるか差し替えられるため)
  const queues = new Map<string, QueuedRun[]>();

  function queueOf(key: string): QueuedRun[] {
    const existing = queues.get(key);
    if (existing) return existing;
    const created: QueuedRun[] = [];
    queues.set(key, created);
    return created;
  }

  async function runLoop(key: string, first: QueuedRun): Promise<void> {
    let item: QueuedRun | undefined = first;
    while (item) {
      try {
        await item.run();
        for (const waiter of item.waiters) waiter.resolve();
      } catch (err) {
        // 失敗はこのラウンドを待っている呼び出し元にだけ伝える。次のラウンド(trailing rerun)は
        // 別の要求なので、前ラウンドの失敗を持ち越さない(持ち越すと、成功した再実行を待っていた
        // 呼び出し元にまで「失敗」を見せてしまう)
        for (const waiter of item.waiters) waiter.reject(err);
      }
      // 待ち行列の先頭から順に消化する。ラウンド中に積まれた要求は次の周回で拾うので落ちない
      item = queueOf(key).shift();
    }

    // エラーの有無に関わらずロックは必ず解放する(解放を忘れると以降そのキーの
    // schedule() が永久に「走行中」扱いになり、二度と実行されなくなる)
    running.delete(key);
    queues.delete(key);
  }

  function schedule(key: string, run: SyncRunner, options?: ScheduleOptions): Promise<void> {
    const coalescable = options?.coalesce !== false;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter: Waiter = { resolve, reject };

    if (!running.has(key)) {
      running.add(key);
      // runLoop 自体は throw しない(結果は waiter に配る)ので、ここで await しなくても
      // unhandled rejection にはならない
      void runLoop(key, { run, coalescable, waiters: [waiter] });
      return promise;
    }

    const queue = queueOf(key);
    const tail = queue.at(-1);
    if (!tail) {
      queue.push({ run, coalescable, waiters: [waiter] });
      return promise;
    }

    if (coalescable) {
      // 末尾の要求はまだ開始していない = 自分より後に始まる。合流可能な要求はそれで満たされるので
      // 待ち手だけ相乗りさせる。末尾が落とせない要求 (coalesce: false) のときに run を差し替えない
      // のがこの修正の要点 ―― ここで差し替えると予約済みの forceFull が黙って消える
      tail.waiters.push(waiter);
      if (tail.coalescable) tail.run = run;
      return promise;
    }

    // 落とせない要求。末尾が合流可能ならそれを吸収する(待ち手を引き継ぎ、実行するのは自分の run)。
    // 吸収された側は「自分より後に始まる同期1回」で満たされる要求なので、これで嘘にならないし
    // 待ち行列も1回ぶんしか増えない。末尾も落とせない要求なら、両方とも実行する必要があるので積む
    if (tail.coalescable) {
      queue.pop();
      queue.push({ run, coalescable: false, waiters: [...tail.waiters, waiter] });
    } else {
      queue.push({ run, coalescable: false, waiters: [waiter] });
    }
    return promise;
  }

  return { schedule };
}
