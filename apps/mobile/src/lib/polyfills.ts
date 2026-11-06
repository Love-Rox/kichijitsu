import * as Crypto from "expo-crypto";

/**
 * Web 版のロジック (sync/eventCreate.ts の仮 id など) が `crypto.randomUUID()` を使う。
 * Hermes に無い場合は expo-crypto で補う。アプリの入口 (_layout) から最初に import する。
 */
const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.randomUUID) g.crypto.randomUUID = () => Crypto.randomUUID();
