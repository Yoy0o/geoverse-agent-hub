#!/usr/bin/env bash
# __PROJECT__ 的统一验证入口：Agent、各 Agent 的结束前钩子、git 合并钩子、task.sh 都调用它。
# 由 agent-hub 生成。验证命令变了：在工作台“项目”页改档案后重新下载，或直接改下面的 STEPS。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
STEPS=(
__VERIFY_STEPS__
)
if [ ${#STEPS[@]} -eq 0 ]; then
  echo "warn: 还没有配置验证命令（在工作台“项目”页填写后重新生成接入包）"
  exit 0
fi
for s in "${STEPS[@]}"; do
  echo ">> $s"
  if bash -c "$s"; then echo "pass: $s"; else echo "fail: $s"; exit 1; fi
done
echo "全部通过（${#STEPS[@]} 项）"
