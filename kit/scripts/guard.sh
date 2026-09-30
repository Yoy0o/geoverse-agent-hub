#!/usr/bin/env bash
# 修改前守卫（PreToolUse）：拦截对受保护路径的修改，并把拦截事件上报 agent-hub。
#   bash scripts/agent/guard.sh <claude-code|codex|cursor|copilot|kiro>   载荷从 stdin 读入
# 各 Agent 的拒绝方式不同，这里统一处理。Copilot 的 preToolUse 出错即拒绝，所以本脚本任何异常都按“放行”退出。
agent=${1:-claude-code}
input=$(cat 2>/dev/null || true)
dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROTECT=(
__PROTECT__
)
[ ${#PROTECT[@]} -gt 0 ] || exit 0
[ -n "$input" ] || exit 0

# 只检查写入类工具（读文件不拦）
tool=$(printf '%s' "$input" | sed -nE 's/.*"(tool_name|toolName)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/p' | head -n 1 | tr 'A-Z' 'a-z')
case "$tool" in
  ""|edit|write|multiedit|apply_patch|applypatch|create|str_replace|str_replace_editor|strreplace|fs_write|notebookedit|delete|deletefile|editfile|writefile|edit_file|write_file) ;;
  *) exit 0 ;;
esac

paths=$( {
  printf '%s' "$input" | grep -oE '"(file_path|filePath|path|target_file|notebook_path)"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\1/'
  printf '%s' "$input" | grep -oE '\*\*\* (Update|Add|Delete) File: [^\\"]+' | sed -E 's/^\*\*\* (Update|Add|Delete) File: //'
} 2>/dev/null | sort -u )
[ -n "$paths" ] || exit 0

jstr() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; printf '"%s"' "$s"; }
deny() {
  local msg="受保护路径：$1（规则 $2），需要人工修改；如任务确实需要，请在交付回执的 scope 中说明原因。"
  [ -f "$dir/hub.sh" ] && ( printf '%s' "$input" | bash "$dir/hub.sh" report "$agent" deny >/dev/null 2>&1 & )
  case "$agent" in
    cursor)  printf '{"permission":"deny","user_message":%s,"agent_message":%s}\n' "$(jstr "$msg")" "$(jstr "$msg")"; exit 0 ;;
    copilot) printf '{"permissionDecision":"deny","permissionDecisionReason":%s}\n' "$(jstr "$msg")"; exit 0 ;;
    codex)   printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$(jstr "$msg")"; exit 0 ;;
    *)       echo "$msg" >&2; exit 2 ;;   # Claude Code、Kiro：退出码 2 = 拒绝，stderr 交给 Agent
  esac
}

while IFS= read -r p; do
  [ -n "$p" ] || continue
  rel=${p#"$root"/}; rel=${rel#./}
  for g in "${PROTECT[@]}"; do
    case "$rel" in $g) deny "$rel" "$g" ;; esac
  done
done <<< "$paths"
exit 0
