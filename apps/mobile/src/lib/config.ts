/** 接続先。開発中も本番の Worker を使う(ログインに Google の OAuth が要るため)。 */
export const API_BASE = "https://kichijitsu.love-rox.cc";

/** ログイン完了後にブラウザがアプリへ戻すときのスキーム。サーバー側 (DESKTOP_DEEP_LINK_SCHEME) と一致させる。 */
export const AUTH_CALLBACK_URL = "kichijitsu://auth";
