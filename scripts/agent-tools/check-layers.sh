#!/bin/sh
# toolbox-script
# format: v1
# name: check-layers
# summary: 前端分层依赖护栏 R1/R2/R3 静态扫描（等价 npm run check:layers，零依赖）
# trigger: manual
# cat: test
# alias: cll
# platform: unix
# self-test: --self-test
set -u

TARGET_REL='scripts/check-layers.mjs'

usage() {
  cat <<'EOF'
check-layers —— 分层依赖护栏（R1/R2/R3）

用法: check-layers [--help|--json|--self-test] [透传参数...]

说明:
  实际执行 `node scripts/check-layers.mjs`（以仓库根为基准），参数原样透传。
  该 .mjs 被 npm scripts（npm run check:layers / check:arch）直接消费，属构建资产，
  保留在原位 scripts/；本工具只提供统一的 toolbox 入口与契约结论。
  --json: 执行后输出一行契约结论（OK/FAIL），退出码与 status 一致。
EOF
}

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
TARGET="$ROOT/$TARGET_REL"

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --self-test)
    command -v node >/dev/null 2>&1 || { echo 'fail: 未找到 node'; exit 1; }
    [ -f "$TARGET" ] || { echo "fail: 目标脚本缺失: $TARGET_REL"; exit 1; }
    echo "self-test: OK（node 就位且 $TARGET_REL 存在）"
    exit 0 ;;
esac

json=0
[ "${1:-}" = '--json' ] && { json=1; shift; }

if [ ! -f "$TARGET" ]; then
  if [ "$json" -eq 1 ]; then
    printf '{"status":"FAIL","severity":"error","message":"目标脚本缺失: %s","remedy":"确认仓库根下 %s 是否存在"}\n' "$TARGET_REL" "$TARGET_REL"
  else
    echo "[remedy] 目标脚本缺失: $TARGET（应在仓库根 $TARGET_REL）"
  fi
  exit 2
fi

if [ "$json" -eq 1 ]; then
  out=$(node "$TARGET" "$@" 2>&1); rc=$?
  msg=$(printf '%s' "$out" | tr '\n' ' ' | tr -d '"' | cut -c1-160)
  if [ "$rc" -eq 0 ]; then
    printf '{"status":"OK","severity":"info","message":"分层护栏通过（R1/R2/R3 无违反）"}\n'
    exit 0
  else
    printf '{"status":"FAIL","severity":"error","message":"分层护栏未过: %s","remedy":"按输出修正依赖方向后重跑 toolbox run check-layers"}\n' "$msg"
    exit 1
  fi
fi

exec node "$TARGET" "$@"
