#!/usr/bin/env bash
# 结束前验证（Stop / agentStop / AgentStop 钩子）：有代码改动且统一验证不通过时，让 Agent 继续修；最多拦 3 次，之后交给人。
#   bash scripts/agent/stop-verify.sh <claude-code|codex|cursor|copilot|kiro>
# 没有改动、或改动已经验证通过时直接放行。结果同时回传 agent-hub（任务详情里的“最近检查”）。临时关闭：AGENT_SKIP_VERIFY=1
agent=${1:-claude-code}
cat >/dev/null 2>&1 || true
[ "${AGENT_SKIP_VERIFY:-}" = "1" ] && exit 0
dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
mkdir -p .agent; [ -f .agent/.gitignore ] || printf '*\n' > .agent/.gitignore
if git show-ref --verify --quiet refs/heads/main; then base=main; elif git show-ref --verify --quiet refs/heads/master; then base=master; else base=HEAD; fi
changes=$(git status --porcelain | grep -vE '^\?\? (specs|\.agent)/' || true)
ahead=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)
[ -z "$changes" ] && [ "$ahead" = "0" ] && exit 0
fp=$( { git rev-parse HEAD; printf '%s\n' "$changes"; git diff; } | cksum | cut -d' ' -f1 )
[ "$(cat .agent/last_pass 2>/dev/null)" = "$fp" ] && exit 0
f=.agent/verify_attempts
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"

ok=0; bash scripts/agent/verify.sh > .agent/verify.log 2>&1 && ok=1

# 回传检查结果（后台，不影响 Agent）
if [ -f "$dir/hub.sh" ]; then
  (
    . "$dir/hub.sh"
    id=$(hub_task); [ -n "$id" ] || exit 0
    items=""
    while IFS= read -r l; do
      case "$l" in pass:\ *) r=pass; c=${l#pass: } ;; fail:\ *) r=fail; c=${l#fail: } ;; *) continue ;; esac
      items="$items${items:+,}{\"cmd\":$(hub_jstr "$c"),\"result\":\"$r\"}"
    done < .agent/verify.log
    hub_api POST "/api/tasks/$id/check?agent=$agent" "{\"ok\":$([ $ok = 1 ] && echo true || echo false),\"verify\":[${items}],\"by\":\"stop-verify\",\"agent\":\"$agent\",\"branch\":$(hub_jstr "$(hub_branch)"),\"repo\":$(hub_jstr "$(hub_repo)")}" >/dev/null 2>&1
  ) >/dev/null 2>&1 &
fi

if [ $ok = 1 ]; then rm -f "$f"; echo "$fp" > .agent/last_pass; exit 0; fi
if [ "$n" -ge 3 ]; then
  rm -f "$f"
  echo "统一验证连续 3 次失败：停止修复，在交付回执中写 status: blocked 并说明原因" >&2
  exit 0
fi
msg="统一验证未通过（第 $n 次），请修复后再结束任务。最近输出：
$(tail -n 40 .agent/verify.log)"
jstr() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; printf '"%s"' "$s"; }
case "$agent" in
  cursor)  printf '{"followup_message":%s}\n' "$(jstr "$msg")"; exit 0 ;;
  copilot) printf '{"decision":"block","reason":%s}\n' "$(jstr "$msg")"; exit 0 ;;
  *)       printf '%s\n' "$msg" >&2; exit 2 ;;   # Claude Code、Codex、Kiro：退出码 2 = 继续修，stderr 交给 Agent
esac
