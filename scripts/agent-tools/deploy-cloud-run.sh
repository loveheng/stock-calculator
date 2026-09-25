#!/usr/bin/env bash
# toolbox-script
# format: v1
# name: deploy-cloud-run
# summary: 前端 PWA 一键部署到 Google Cloud Run（gcloud run deploy --source，构建逻辑与本地 Dockerfile 一致）
# trigger: manual
# cat: deploy
# alias: dcr
# platform: unix
# self-test: --self-test
# =====================================================================
# 前置条件（首次使用前手动执行一次）：
#   gcloud auth login                  # 登录 Google 账号
#   gcloud billing projects list       # 确认项目已启用结算（Cloud Run 必需）
#
# 说明：
#   - gcloud run deploy --source . 会把源码交给 Cloud Build，
#     自动检测仓库根目录的 Dockerfile 构建（构建逻辑与本地 docker build 完全一致）
#   - 服务默认公开访问（--allow-unauthenticated），鉴权由上游 /api/auth 服务负责
#   - 改认证/OCR 上游（默认 proxy.config.js 的 online 地址）：
#     gcloud run services update <服务名> --region <区域> \
#       --set-env-vars AUTH_UPSTREAM=<url>,IMPORT_UPSTREAM=<url>
# =====================================================================
set -eu

usage() {
  cat <<'EOF'
deploy-cloud-run —— 前端 PWA 部署到 Google Cloud Run

用法: deploy-cloud-run [--help|--json|--dry-run|--self-test] <GCP项目ID> [区域] [服务名]

参数:
  <GCP项目ID>  必填
  [区域]       默认 us-central1
  [服务名]     默认 stock-calculator

模式区别（重要）:
  裸跑（带项目ID）  执行真实部署——长任务，首次构建约 3-5 分钟
  --json            快速预检结论（**不部署**）：校验 gcloud / Dockerfile / 参数
  --dry-run         打印将执行的命令序列，不落真目标
  --self-test       金丝雀自检
EOF
}

json_out() {
  if [ -n "$4" ]; then
    printf '{"status":"%s","severity":"%s","message":"%s","remedy":"%s"}\n' "$1" "$2" "$3" "$4"
  else
    printf '{"status":"%s","severity":"%s","message":"%s"}\n' "$1" "$2" "$3"
  fi
}

preflight() { # preflight <项目ID> → 0 通过 / 1 未过（MISS 写原因）
  MISS=''
  if [ -z "${1:-}" ]; then MISS='缺少 GCP 项目ID'; return 1; fi
  if ! command -v gcloud >/dev/null 2>&1; then MISS='未找到 gcloud（需安装 Google Cloud SDK 并先 gcloud auth login）'; return 1; fi
  if [ ! -f Dockerfile ]; then MISS='仓库根缺 Dockerfile（--source 构建依赖）'; return 1; fi
  return 0
}

dry_run() { # dry_run <项目ID> <区域> <服务名>
  cat <<EOF
[dry-run] 将执行（未落地）：
  cd <仓库根>
  gcloud config set project $1
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
  gcloud run deploy $3 --source . --region $2 --allow-unauthenticated --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 --timeout 120
  gcloud run services describe $3 --region $2 --format 'value(status.url)'
EOF
}

self_test() {
  bash "$0" --help >/dev/null 2>&1 || { echo 'fail: --help 未按契约退出 0'; return 1; }
  r=0; bash "$0" --json >/dev/null 2>&1 || r=$?
  [ "$r" -eq 1 ] || { echo "fail: 无项目ID 时 --json 应 FAIL(1)，实际 $r"; return 1; }
  bash "$0" --dry-run x >/dev/null 2>&1 || { echo 'fail: --dry-run 未按契约退出 0'; return 1; }
  echo 'self-test: OK（--help / --json 预检 / --dry-run 均按契约）'
  return 0
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --self-test) self_test; exit $? ;;
esac

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"

if [ "${1:-}" = '--json' ]; then
  if preflight "${2:-}"; then
    json_out OK info "预检通过：gcloud 就位、仓库根有 Dockerfile、项目ID=${2:-}（--json 仅预检，不部署；真实部署去掉 --json 裸跑）"
    exit 0
  else
    json_out FAIL error "预检未过：$MISS" "修正后重跑 toolbox run deploy-cloud-run --json <项目ID>"
    exit 1
  fi
fi

if [ "${1:-}" = '--dry-run' ]; then
  shift
  dry_run "${1:-<项目ID>}" "${2:-us-central1}" "${3:-stock-calculator}"
  exit 0
fi

if [ -z "${1:-}" ]; then
  echo "[remedy] 缺少 GCP 项目ID；用法: toolbox run deploy-cloud-run <项目ID> [区域] [服务名]（--help 看全部模式）"
  exit 1
fi

PROJECT_ID="$1"
REGION="${2:-us-central1}"
SERVICE="${3:-stock-calculator}"

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
