# syntax=docker/dockerfile:1
#
# 日常開発は mise + ネイティブ pnpm が主。このイメージは「再現可能に動かす」
# ための代替手段（CI やローカル環境が汚れている場合の確認用）。

FROM node:26-slim AS base
# Node 25+ は corepack を同梱しないため別途インストールする
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

# ---- deps: workspace のロックファイルどおりに依存関係だけを解決 ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- dev: ソースは compose の bind mount で入る前提。ここではコピーしない ----
FROM deps AS dev
EXPOSE 5173
CMD ["pnpm", "--filter", "web", "dev", "--host", "0.0.0.0"]

# ---- build: 全ソースを含めて本番ビルド ----
FROM deps AS build
COPY . .
RUN pnpm --filter web build

# ---- preview: build の成果物を vite preview で配信 ----
# devDependencies (vite) が要るため build ステージをそのまま使う
FROM build AS preview
EXPOSE 4173
CMD ["pnpm", "--filter", "web", "preview", "--host", "0.0.0.0"]
