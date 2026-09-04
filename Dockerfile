# =====================================================================
# stock-calculator PWA · Docker 镜像（与 Vercel 部署并存，互不影响）
#
# 多阶段构建：
#   stage 1 (build)   : 安装依赖并执行 npm run build（Vite + PWA 产物 → dist/）
#   stage 2 (runtime) : 仅携带 dist/ 静态产物 + 零依赖 Node 运行时 server/
#
# 运行时 server/（server/index.mjs）零 npm 依赖，1:1 复刻 Vercel 行为：
#   - SPA 回退（vercel.json rewrites）
#   - /sw.js 缓存头（vercel.json headers）
#   - 6 条静态上游代理（middleware.js）：/api-gtimg /api-qt /api-kline
#     /api/eastmoney /api/import /api/auth
#   - WebDAV 代理（api/webdav.js）：/api/webdav?url=
#
# 构建镜像：  docker build -t stock-calculator .
# 运行容器：  docker run -p 3000:3000 stock-calculator
#
# 可选构建参数：
#   --build-arg NPM_REGISTRY=<url>   npm 源（默认腾讯镜像；海外 CI 可传 registry.npmjs.org）
#
# 可选环境变量：
#   PORT=3000                        监听端口
#   HOST=0.0.0.0                     监听地址
#   AUTH_UPSTREAM=<url>              覆盖 /api/auth 上游（默认 proxy.config.js 线上地址）
#   IMPORT_UPSTREAM=<url>            覆盖 /api/import 上游（同上）
# =====================================================================

# ---------- stage 1 · 构建 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 先只拷贝依赖清单，利用 Docker 层缓存（源码改动不触发 npm ci 重装）
# npm 源可被构建参数覆盖（--build-arg NPM_REGISTRY=...）：
#   本地默认腾讯镜像（国内快）；GitHub Actions 等海外环境传 registry.npmjs.org
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm config set legacy-peer-deps true \
 && npm ci

# 再拷贝源码与构建配置（vite.config.ts 依赖 proxy.config.js）
COPY index.html vite.config.ts tailwind.config.js postcss.config.js tsconfig.json proxy.config.js ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# ---------- stage 2 · 运行时 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# 静态产物 + 零依赖运行时（proxy.config.js 为 /api/auth、/api/import 默认上游）
COPY --from=build /app/dist ./dist
COPY proxy.config.js ./proxy.config.js
COPY server ./server

EXPOSE 3000

# 健康检查：alpine 自带 busybox wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# 非 root 运行
USER node

CMD ["node", "server/index.mjs"]
