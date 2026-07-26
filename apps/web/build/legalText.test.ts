import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  buildLegalSlots,
  escapeHtml,
  readOperatorInfo,
  renderLegalHtml,
  type OperatorInfo,
} from "./legalText.ts";

const OFFICIAL: OperatorInfo = {
  name: "love-rox",
  contact: "kichijitsu@love-rox.cc",
  host: "kichijitsu.love-rox.cc",
};

/** 実物の規約 HTML。プレースホルダの置換漏れをここで検出する。 */
const LEGAL_PAGES = ["../privacy.html", "../terms.html"].map((rel) => ({
  rel,
  html: readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
}));

describe("escapeHtml", () => {
  it("HTML の意味を持つ文字をすべて実体参照にする", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("& を最初に処理するので二重エスケープにならない", () => {
    expect(escapeHtml("A&B")).toBe("A&amp;B");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("readOperatorInfo", () => {
  it("3つの環境変数を読む", () => {
    expect(
      readOperatorInfo({
        KICHIJITSU_OPERATOR_NAME: "Acme",
        KICHIJITSU_OPERATOR_CONTACT: "hi@acme.example",
        KICHIJITSU_INSTANCE_HOST: "cal.acme.example",
      }),
    ).toEqual({ name: "Acme", contact: "hi@acme.example", host: "cal.acme.example" });
  });

  it("空文字・空白のみは未設定として扱う (`FOO= pnpm build` の事故を吸収する)", () => {
    expect(
      readOperatorInfo({
        KICHIJITSU_OPERATOR_NAME: "",
        KICHIJITSU_OPERATOR_CONTACT: "   ",
      }),
    ).toEqual({ name: undefined, contact: undefined, host: undefined });
  });

  it("前後の空白は落とす", () => {
    expect(readOperatorInfo({ KICHIJITSU_OPERATOR_NAME: "  Acme  " }).name).toBe("Acme");
  });
});

describe("buildLegalSlots: 3変数すべて設定", () => {
  const slots = buildLegalSlots(OFFICIAL);

  it("インスタンス呼称にホスト名が入る", () => {
    expect(slots.INSTANCE_JA).toBe("本インスタンス（kichijitsu.love-rox.cc）");
    expect(slots.INSTANCE_EN).toBe("this instance (kichijitsu.love-rox.cc)");
  });

  it("運営者の定義文に運営者名とホスト名が入る", () => {
    expect(slots.TERMS_OPERATOR_JA).toBe(
      "本インスタンス（kichijitsu.love-rox.cc）は、love-rox（以下「運営者」）が運営しています。",
    );
    expect(slots.TERMS_OPERATOR_EN).toBe(
      'This instance (kichijitsu.love-rox.cc) is operated by love-rox (the "operator").',
    );
  });

  it("運営者名の単独表示に運営者名が入る", () => {
    expect(slots.OPERATOR_LINE_JA).toBe("運営者: love-rox");
    expect(slots.OPERATOR_LINE_EN).toBe("Operator: love-rox");
  });

  it("連絡先が mailto: リンクになる", () => {
    expect(slots.CONTACT_LINE_JA).toBe(
      '連絡先: <a href="mailto:kichijitsu@love-rox.cc">kichijitsu@love-rox.cc</a>',
    );
    expect(slots.CONTACT_LINE_EN).toBe(
      'Contact: <a href="mailto:kichijitsu@love-rox.cc">kichijitsu@love-rox.cc</a>',
    );
  });
});

describe("buildLegalSlots: すべて未設定", () => {
  const slots = buildLegalSlots({});

  // このプロジェクト最大の不変条件。セルフホストした人のドメインで love-rox の名前が
  // 出ることは絶対に避けなければならない。
  it("公式インスタンスの情報が一切出ない", () => {
    const rendered = Object.values(slots).join("\n");
    expect(rendered).not.toContain("love-rox");
    expect(rendered).not.toContain("kichijitsu@love-rox.cc");
    expect(rendered).not.toContain("kichijitsu.love-rox.cc");
  });

  it("インスタンス呼称は一般名詞になる (空の括弧を残さない)", () => {
    expect(slots.INSTANCE_JA).toBe("本インスタンス");
    expect(slots.INSTANCE_EN).toBe("this instance");
  });

  it("『運営者』という語の定義は残す (以降の条項が依存しているため)", () => {
    expect(slots.TERMS_OPERATOR_JA).toContain("「運営者」といいます");
    expect(slots.TERMS_OPERATOR_JA).toContain("運営者情報は設定されていません");
    expect(slots.TERMS_OPERATOR_EN).toContain('referred to as the "operator"');
  });

  it("連絡先は mailto: リンクにしない (空 mailto: は壊れたリンクになる)", () => {
    expect(slots.CONTACT_LINE_JA).not.toContain("mailto:");
    expect(slots.CONTACT_LINE_JA).not.toContain("<a ");
    expect(slots.CONTACT_LINE_EN).not.toContain("mailto:");
    expect(slots.CONTACT_LINE_EN).not.toContain("<a ");
  });

  it("運営者情報が未設定である旨を中立に述べる", () => {
    expect(slots.OPERATOR_LINE_JA).toBe("本インスタンスの運営者情報は設定されていません。");
    expect(slots.CONTACT_LINE_JA).toBe("本インスタンスの連絡先は設定されていません。");
  });
});

describe("buildLegalSlots: 一部だけ設定", () => {
  it("ホスト名だけ設定: 運営者は未設定のまま、ホスト名は文中に出る", () => {
    const slots = buildLegalSlots({ host: "cal.example.com" });
    expect(slots.TERMS_OPERATOR_JA).toBe(
      "本インスタンス（cal.example.com）を運営する者を、本規約では「運営者」といいます（本インスタンスの運営者情報は設定されていません）。",
    );
    expect(slots.INSTANCE_JA).toBe("本インスタンス（cal.example.com）");
    expect(slots.OPERATOR_LINE_JA).toBe("本インスタンスの運営者情報は設定されていません。");
  });

  it("運営者名だけ設定: 括弧が空にならない", () => {
    const slots = buildLegalSlots({ name: "Acme Inc." });
    expect(slots.TERMS_OPERATOR_JA).toBe(
      "本インスタンスは、Acme Inc.（以下「運営者」）が運営しています。",
    );
    expect(slots.TERMS_OPERATOR_EN).toBe(
      'This instance is operated by Acme Inc. (the "operator").',
    );
    expect(slots.INSTANCE_JA).toBe("本インスタンス");
  });

  it("連絡先だけ設定: リンクは出るが運営者名は未設定のまま", () => {
    const slots = buildLegalSlots({ contact: "hi@example.com" });
    expect(slots.CONTACT_LINE_JA).toBe(
      '連絡先: <a href="mailto:hi@example.com">hi@example.com</a>',
    );
    expect(slots.OPERATOR_LINE_JA).toBe("本インスタンスの運営者情報は設定されていません。");
  });

  it("どの組み合わせでも空の括弧や連続する読点が残らない", () => {
    const combos: OperatorInfo[] = [
      {},
      { name: "A" },
      { contact: "c@e.example" },
      { host: "h.example" },
      { name: "A", contact: "c@e.example" },
      { name: "A", host: "h.example" },
      { contact: "c@e.example", host: "h.example" },
      OFFICIAL,
    ];
    for (const combo of combos) {
      const rendered = Object.values(buildLegalSlots(combo)).join("\n");
      expect(rendered).not.toContain("（）");
      expect(rendered).not.toContain("()");
      expect(rendered).not.toContain("、、");
      expect(rendered).not.toContain("undefined");
    }
  });
});

describe("buildLegalSlots: HTML エスケープ", () => {
  const hostile: OperatorInfo = {
    name: `A & B <script>alert("x")</script>`,
    contact: `"onmouseover="alert(1)`,
    host: "ex&ample<.com",
  };

  it("運営者名の記号がエスケープされ、生タグが残らない", () => {
    const slots = buildLegalSlots(hostile);
    const rendered = Object.values(slots).join("\n");
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("A &amp; B &lt;script&gt;");
  });

  it('連絡先の `"` がエスケープされ href 属性が閉じられない', () => {
    const slots = buildLegalSlots(hostile);
    // 属性値の中に生の `"` が現れない = 属性が壊れていない。
    expect(slots.CONTACT_LINE_JA).toBe(
      '連絡先: <a href="mailto:&quot;onmouseover=&quot;alert(1)">&quot;onmouseover=&quot;alert(1)</a>',
    );
    expect(slots.CONTACT_LINE_JA).not.toContain('="alert');
  });

  it("ホスト名の & と < もエスケープされる", () => {
    expect(buildLegalSlots(hostile).INSTANCE_JA).toBe("本インスタンス（ex&amp;ample&lt;.com）");
  });
});

describe("renderLegalHtml", () => {
  it("プレースホルダを差し替える", () => {
    expect(renderLegalHtml("<p><!--KJ:OPERATOR_LINE_JA--></p>", OFFICIAL)).toBe(
      "<p>運営者: love-rox</p>",
    );
  });

  it("同じプレースホルダが複数あってもすべて置換する", () => {
    expect(renderLegalHtml("<!--KJ:INSTANCE_EN--> / <!--KJ:INSTANCE_EN-->", {})).toBe(
      "this instance / this instance",
    );
  });

  it("プレースホルダが無い HTML はそのまま返す", () => {
    expect(renderLegalHtml("<p>hello</p>", OFFICIAL)).toBe("<p>hello</p>");
  });

  it("未知のプレースホルダは例外にする (黙って空にすると規約から運営者情報が消える)", () => {
    expect(() => renderLegalHtml("<!--KJ:NOPE-->", OFFICIAL)).toThrow("NOPE");
  });
});

describe("実物の規約 HTML", () => {
  for (const { rel, html } of LEGAL_PAGES) {
    it(`${rel}: ソースに公式インスタンスの情報がハードコードされていない`, () => {
      expect(html).not.toContain("love-rox");
    });

    it(`${rel}: 未設定でビルドしても置換漏れが起きない`, () => {
      const rendered = renderLegalHtml(html, {});
      expect(rendered).not.toContain("<!--KJ:");
      expect(rendered).not.toContain("love-rox");
    });

    it(`${rel}: 公式の値でビルドすると運営者情報が入る`, () => {
      const rendered = renderLegalHtml(html, OFFICIAL);
      expect(rendered).toContain("love-rox");
      expect(rendered).toContain("mailto:kichijitsu@love-rox.cc");
    });
  }
});
