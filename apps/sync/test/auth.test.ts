import { describe, expect, it } from "vite-plus/test";
import { renderConnectionLoginRejectionPage } from "../src/routes/auth";

describe("renderConnectionLoginRejectionPage", () => {
  it("接続アカウントでのログイン拒否ページに email と APP_URL リンクを含む", () => {
    const html = renderConnectionLoginRejectionPage(
      "connected@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).toContain("connected@example.com");
    expect(html).toContain('href="https://kichijitsu.love-rox.cc"');
    expect(html).toContain("既存プロファイルの接続アカウント");
    expect(html).toContain("設定からこのアカウントの接続を解除");
  });

  it("email に HTML 特殊文字が含まれていてもエスケープしてページを壊さない", () => {
    const html = renderConnectionLoginRejectionPage(
      "<script>alert(1)</script>@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).not.toContain("<script>alert(1)</script>@example.com");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
  });
});
