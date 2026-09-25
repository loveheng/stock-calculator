#!/bin/sh
# toolbox-script
# format: v1
# name: postbuild
# summary: 前端构建后处理——移除 dist/index.html 的 crossorigin 属性（适配 PWA 离线跨域策略）
# trigger: manual
# cat: build
# alias: pb
# platform: unix
# self-test: --self-test
set -u

TARGET_REL='scripts/postbuild.js'

usage() {
  cat <<'EOF'
postbuild —— 构建后处理（移除 dist/index.html 的 crossorigin）

用法: postbuild [--help|--json|--self-test]

说明:
  实际执行 `node scripts/postbuild.js`（以仓库根为基准）。
  通常由 `npm run build` 自动串联，仅当需单独重跑产物处理时使用本入口。
  前置：需先有构建产物 dist/index.html（否则脚本按自身逻辑处理/报错）。
  该 .js 被 npm scripts 直接消费，属构建资产，保留原位 scripts/。
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
  if [ -f "$ROOT/dist/index.html" ]; then
    printf '{"status":"OK","severity":"info","message":"预检通过：dist/index.html 存在，可执行产物处理"}\n'
    exit 0
  fi
  printf '{"status":"FAIL","severity":"error","message":"预检未过：缺 dist/index.html","remedy":"先跑 npm run build 生成产物"}\n'
  exit 1
fi

exec node "$TARGET" "$@"
