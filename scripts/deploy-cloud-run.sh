#!/usr/bin/env bash
# =====================================================================
# stock-calculator PWA · 一键部署到 Google Cloud Run
#
# 前置条件（首次使用前手动执行一次）：
#   gcloud auth login                  # 登录 Google 账号
#   gcloud billing projects list       # 确认项目已启用结算（Cloud Run 必需）
#
# 用法：
#   ./scripts/deploy-cloud-run.sh <GCP项目ID> [区域] [服务名]
#   ./scripts/deploy-cloud-run.sh my-project                # 默认 us-central1 / stock-calculator
#   ./scripts/deploy-cloud-run.sh my-project asia-east1     # 指定区域
#
# 说明：
#   - gcloud run deploy --source . 会把源码交给 Cloud Build，
#     自动检测仓库根目录的 Dockerfile 构建（构建逻辑与本地 docker build 完全一致）
#   - 服务默认公开访问（--allow-unauthenticated），鉴权由上游 /api/auth 服务负责
#   - 认证/OCR 上游默认取 proxy.config.js 的 online 地址（https://sc.oklhj.eu.org），
#     如需指向其他 Spring Boot 实例，部署后：
#     gcloud run services update <服务名> --region <区域> \
#       --set-env-vars AUTH_UPSTREAM=<url>,IMPORT_UPSTREAM=<url>
# =====================================================================
set -eu

if [ -z "$1" ]; then
  echo "用法: ./scripts/deploy-cloud-run.sh <GCP项目ID> [区域] [服务名]"
  exit 1
fi

PROJECT_ID="$1"
REGION="us-central1"
SERVICE="stock-calculator"
if [ -n "$2" ]; then REGION="$2"; fi
if [ -n "$3" ]; then SERVICE="$3"; fi

cd "$(dirname "$0")/.."

echo "==> 项目: $PROJECT_ID  区域: $REGION  服务: $SERVICE"
gcloud config set project "$PROJECT_ID"

echo "==> 启用所需 API（run / cloudbuild / artifactregistry）"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

echo "==> 构建并部署（首次构建约 3-5 分钟）"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 120

echo "==> 完成。服务地址："
gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format 'value(status.url)'
