/**
 * Hono の generics 用の型。`Env` (Bindings) 自体は手書きせず、
 * `wrangler types` が生成する `worker-configuration.d.ts` のグローバル型を使う。
 */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** sid cookie が指すプロファイル (セッション)。1 プロファイルに複数の Google アカウントがぶら下がる。 */
    profileId?: string;
  };
}
