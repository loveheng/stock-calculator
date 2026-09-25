#!/bin/sh
# toolbox-script
# format: v1
# name: feature-map
# summary: 前端功能→文件触点速查（等价 npm run map:features，实时扫描 src/ 不落盘，可带域过滤省 token）
# trigger: manual
# cat: docs
# alias: fmap
# platform: unix
# self-test: --self-test
set -u

TARGET_REL='scripts/feature-map.mjs'

usage() {
  cat <<'EOF'
feature-map —— 功能→文件触点速查表

用法: feature-map [--help|--json|--self-test] [--] [<域> <域...>]

说明:
  实际执行 `node scripts/feature-map.mjs`（以仓库根为基准），参数原样透传。
  不带域 = 全量视图；带域 = 只输出目标域（按组名/中文名子串匹配），改某功能前先查触点。
  该 .mjs 被 npm scripts（npm run map:features）直接消费，属构建资产，保留原位 scripts/。
  --json: 执行后输出一行契约结论（输出明细见裸跑，--json 只给结论）。
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
[ "${1:-}" = '--' ] && shift

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
  n=$(printf '%s\n' "$out" | grep -c . || true)
  if [ "$rc" -eq 0 ]; then
    printf '{"status":"OK","severity":"info","message":"功能触点视图已生成（%s 行，明细见裸跑 toolbox run feature-map）"}\n' "$n"
    exit 0
  else
    printf '{"status":"FAIL","severity":"error","message":"功能触点扫描失败（node 退出码 %s）","remedy":"裸跑看完整报错：toolbox run feature-map"}\n' "$rc"
    exit 1
  fi
fi

exec node "$TARGET" "$@"
