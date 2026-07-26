/**
 * 規約 / プライバシーポリシー HTML の「運営者情報」をビルド時に差し込むための純関数群。
 *
 * ## なぜ必要か
 *
 * kichijitsu は OSS でセルフホスト可能 (`/self-hosting`) であり、`apps/web/dist` は
 * まるごと assets Worker にアップロードされる。つまり `/privacy.html` `/terms.html` は
 * **セルフホストした人のドメインでもそのまま配信される**。これらのページに公式インスタンスの
 * 運営者名 (love-rox) や連絡先 (kichijitsu@love-rox.cc) がハードコードされていると、
 *
 *   1. 他人の規約が自分のインスタンスの規約として提示される
 *   2. love-rox が、運営していないインスタンスの運営者として名指しされる
 *
 * という二重の事故になる。そこでプレースホルダ (`<!--KJ:TOKEN-->`) をビルド時に差し替える。
 *
 * ## なぜ Vite 組み込みの `%VITE_FOO%` 置換ではなく自前か
 *
 * 未設定時のフォールバックを制御したいから。`%VITE_FOO%` は「空文字に置き換わる」だけなので
 * 「本インスタンス（）は が運営しています」のような壊れた日本語になる。ここでは
 * **未設定なら文ごと中立の言い回しに差し替える**ことで、どの組み合わせでも文章が成立するようにする。
 *
 * ## 最重要の不変条件
 *
 * **運営者名・連絡先が未設定のとき、出力に `love-rox` / `kichijitsu@love-rox.cc` が
 * 一切現れないこと。** legalText.test.ts で明示的に assert している。
 *
 * ## プレースホルダの形式
 *
 * `%FOO%` ではなく HTML コメント `<!--KJ:FOO-->` を使う。Vite は HTML 中の `%KEY%` を
 * 環境変数として解釈する組み込み機構を持っており、`%%KJ_FOO%%` のような記法と衝突するため。
 * コメント形式なら Vite の HTML パイプラインとぶつからず、素の HTML としても壊れない。
 */

/** 運営者情報。すべて任意 (未設定ならフォールバック文言になる)。 */
export type OperatorInfo = {
  /** 運営者名。例: "love-rox" */
  readonly name?: string | undefined;
  /** 連絡先メールアドレス。例: "kichijitsu@love-rox.cc" */
  readonly contact?: string | undefined;
  /** このインスタンスのホスト名。例: "kichijitsu.love-rox.cc" */
  readonly host?: string | undefined;
};

/** ビルド時に読む環境変数名。`VITE_` prefix は付けない (クライアントバンドルには載せないため)。 */
export const OPERATOR_ENV_KEYS = {
  name: "KICHIJITSU_OPERATOR_NAME",
  contact: "KICHIJITSU_OPERATOR_CONTACT",
  host: "KICHIJITSU_INSTANCE_HOST",
} as const;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML のテキストノード / 属性値の両方に安全に埋められる形にエスケープする。
 * `"` と `'` も落とすので `href="..."` の中にそのまま入れてよい。
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** 空文字・空白のみは「未設定」と同じ扱いにする (`FOO= pnpm build` の事故を吸収する)。 */
function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 環境変数 (process.env 相当) から OperatorInfo を組み立てる。 */
export function readOperatorInfo(env: Record<string, string | undefined>): OperatorInfo {
  return {
    name: normalize(env[OPERATOR_ENV_KEYS.name]),
    contact: normalize(env[OPERATOR_ENV_KEYS.contact]),
    host: normalize(env[OPERATOR_ENV_KEYS.host]),
  };
}

/**
 * プレースホルダ名 → 差し込む HTML 断片。
 *
 * 「文中の語」ではなく「文まるごと」を単位にしているのは、未設定時に語だけ差し替えると
 * 日本語が破綻するため (例: 「本インスタンスは（未設定）が運営しています」)。
 */
export function buildLegalSlots(info: OperatorInfo): Record<string, string> {
  const name = info.name === undefined ? undefined : escapeHtml(info.name);
  const host = info.host === undefined ? undefined : escapeHtml(info.host);
  // 連絡先はテキストとしても mailto: の属性値としても使うが、どちらも escapeHtml で足りる
  // (`"` が &quot; になるので属性は壊れない)。パーセントエンコードはしない ―― mailto: の
  // ローカル部/ドメインに現れる `@` や `+` を壊す方が実害が大きいため、値は素の
  // メールアドレスであることを前提とする。
  const contact = info.contact === undefined ? undefined : escapeHtml(info.contact);

  // 「本インスタンス（ホスト名）」の丸括弧部分。ホスト未設定なら括弧ごと消える。
  const hostParenJa = host === undefined ? "" : `（${host}）`;
  const hostParenEn = host === undefined ? "" : ` (${host})`;

  return {
    // --- インスタンスの呼称 (プライバシーポリシーの「概要」など、文中に埋める) ---
    INSTANCE_JA: `本インスタンス${hostParenJa}`,
    INSTANCE_EN: `this instance${hostParenEn}`,

    // --- 利用規約: 「運営者」の定義文 ---
    // 未設定時も『「運営者」とはこのインスタンスを運営する者を指す』という定義自体は残す。
    // 以降の条項 (免責・サービスの変更) が「運営者」という語に依存しているため、
    // ここが消えると規約の意味が変わってしまう。
    //
    // 原文にあった「個人プロジェクトとして運営しています」は意図的に落としている:
    // これは love-rox 個人についての事実であって、任意のセルフホスト運営者には当てはまらない
    // (法人が運営するインスタンスで「個人プロジェクト」と表示されるのは誤り)。無保証の趣旨は
    // 「無保証・免責」の条項が担っているので、法務上の意味は失われない。
    TERMS_OPERATOR_JA:
      name === undefined
        ? `本インスタンス${hostParenJa}を運営する者を、本規約では「運営者」といいます（本インスタンスの運営者情報は設定されていません）。`
        : `本インスタンス${hostParenJa}は、${name}（以下「運営者」）が運営しています。`,
    TERMS_OPERATOR_EN:
      name === undefined
        ? `The party operating this instance${hostParenEn} is referred to as the "operator" in these terms; no operator information has been configured for this instance.`
        : `This instance${hostParenEn} is operated by ${name} (the "operator").`,

    // --- 運営者名の単独表示 (プライバシーポリシーの「連絡先」セクション) ---
    OPERATOR_LINE_JA:
      name === undefined ? "本インスタンスの運営者情報は設定されていません。" : `運営者: ${name}`,
    OPERATOR_LINE_EN:
      name === undefined
        ? "No operator information has been configured for this instance."
        : `Operator: ${name}`,

    // --- 連絡先 ---
    // 未設定時に mailto: リンクを出さないのがポイント。`mailto:` が空のリンクは
    // クリックすると空のメーラーが開くだけの壊れたリンクになる。
    CONTACT_LINE_JA:
      contact === undefined
        ? "本インスタンスの連絡先は設定されていません。"
        : `連絡先: <a href="mailto:${contact}">${contact}</a>`,
    CONTACT_LINE_EN:
      contact === undefined
        ? "No contact address has been configured for this instance."
        : `Contact: <a href="mailto:${contact}">${contact}</a>`,
  };
}

const PLACEHOLDER_RE = /<!--KJ:([A-Z_]+)-->/g;

/**
 * HTML 中の `<!--KJ:TOKEN-->` をすべて差し替える。
 *
 * 未知のトークンが残っていたら例外を投げる (置換漏れを本番に出さないため。
 * 黙って空文字にすると、運営者情報が抜けた規約がそのまま配信されてしまう)。
 */
export function renderLegalHtml(html: string, info: OperatorInfo): string {
  const slots = buildLegalSlots(info);
  return html.replace(PLACEHOLDER_RE, (whole, token: string) => {
    const value = slots[token];
    if (value === undefined) {
      throw new Error(
        `未知の運営者情報プレースホルダ ${whole} が見つかりました。apps/web/build/legalText.ts の buildLegalSlots にトークンを追加してください。`,
      );
    }
    return value;
  });
}
