# 部署到 Google Cloud Run

PWA（静态产物 + 零依赖 Node 代理层）以容器方式跑在 Cloud Run 上，构建逻辑与
本地 `docker build` 完全一致（同一个 Dockerfile），与 Vercel 部署并存互不影响。

## 架构

```
用户 → Cloud Run (node server/index.mjs)
         ├─ 静态资源 + SPA 回退（dist/）
         ├─ /api/auth /api/import … → 上游 Spring Boot（默认 https://sc.oklhj.eu.org）
         └─ /api/webdav → WebDAV 代理
```

- Cloud Run 会注入 `PORT`（默认 8080），`server/index.mjs` 直接读该变量，无需额外配置。
- 认证/OCR 上游默认取 `proxy.config.js` 的 `online` 地址，可用环境变量
  `AUTH_UPSTREAM` / `IMPORT_UPSTREAM` 覆盖（见下方运维命令）。
- `.gcloudignore` 控制上传到 Cloud Build 的内容（排除 node_modules/dist/data 等）。
- **注意：Cloud Run 与 App Engine 一样保留以 z 结尾的路径**（如 `/healthz`），
  请求会被 Google 前端拦截返回 404，永远到不了容器（且日志里无任何痕迹）。
  因此容器额外提供 `/health` 别名，Cloud Run 场景请用 `/health` 探活；
  `/healthz` 仍保留给本地 docker / Vercel 场景使用。

当前实际部署：项目 `project-56325d20-bc30-4bb7-a73`（账号配额已满，
复用了原空项目并绑定结算账号 `0171F4-B41785-87A04C`），区域 `us-central1`，
服务名 `stock-calculator`。

## 前置条件（一次性）

1. 安装 gcloud：本机已装在 `~/google-cloud-sdk`（584.0.0），代理已配置
   （`gcloud config list` 可见 proxy 192.168.1.40:2080）。
2. 登录：`gcloud auth login`
3. 确认项目已启用结算（Cloud Run 必需）：
   `gcloud billing projects list`

## 一键部署

```sh
toolbox run dcr <GCP项目ID>              # 默认区域 us-central1
toolbox run dcr <GCP项目ID> asia-east1   # 指定区域
```

脚本会：设置项目 → 启用 run/cloudbuild/artifactregistry API →
`gcloud run deploy --source .`（Cloud Build 自动用 Dockerfile 构建）→
输出服务 URL。首次构建约 3-5 分钟。

配置：1 vCPU / 512Mi / min 0 / max 3 实例 / 允许匿名访问
（鉴权由上游 /api/auth 服务负责，容器本身无状态）。

## 绑定自定义域名

以 `scs.oklhj.eu.org`（Cloudflare 托管 DNS）为例，一次性流程：

1. 域名所有权验证（挂到 Google 账号名下，之后绑同域子域名免重复验证）：
   `gcloud domains verify scs.oklhj.eu.org` → 浏览器打开 Search Console
   → 「添加网站」→ 选 DNS 记录验证 → 在 Cloudflare 加 TXT（名称 `scs`）→ 点验证。
2. 创建映射并取 DNS 记录：
   `gcloud beta run domain-mappings create --service stock-calculator \
      --domain scs.oklhj.eu.org --region us-central1 --quiet`
   （注意 GA 版 `gcloud run domain-mappings` 不认 `--region`，要用 beta。）
3. Cloudflare 加记录：类型 `CNAME`、名称 `scs`、目标 `ghs.googlehosted.com`、
   **代理状态保持「仅 DNS（灰云）」**——橙云 CDN 代理会干扰 Google 托管证书的签发与续期。
4. 等待生效：边缘路由 ~15-30 分钟（期间 HTTP 会从 GFE 404 变为 302），
   托管证书签发 ~15 分钟到 24 小时不等，签好自动上 TLS，无需操作。
   查进度：`gcloud beta run domain-mappings describe --domain scs.oklhj.eu.org \
      --region us-central1`，`CertificateProvisioned: True` 即完成。

## 常用运维

```sh
# 重新部署（源码变更后再跑一次脚本即可；仅 dist 需要重构建）
toolbox run dcr <GCP项目ID>

# 覆盖上游地址（例如把认证/OCR 指到另一个 Spring Boot 实例）
gcloud run services update stock-calculator --region us-central1 \
  --set-env-vars AUTH_UPSTREAM=<url>,IMPORT_UPSTREAM=<url>

# 查看日志
gcloud run services logs read stock-calculator --region us-central1 --limit 50

# 回滚到上一个版本
gcloud run revisions list --service stock-calculator --region us-central1
gcloud run services update-traffic stock-calculator --region us-central1 --to-revisions <旧版本>=100
```

## 费用提示

按量计费：请求到来时才起实例（min-instances 0），低流量基本落在免费额度内
（每月 200 万请求、360k GB-秒内存免费额度，以 Google 官方为准）。
