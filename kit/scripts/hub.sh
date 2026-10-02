#!/usr/bin/env bash
# agent-hub 客户端：各 Agent 钩子上报、git 钩子上报、task.sh 调用 API 都走这里。
# 连接配置读环境变量 AGENT_HUB_URL / AGENT_HUB_TOKEN，没有就读 ~/.config/agent-hub/env（由 connect.mjs 生成）。
# 没配置、连不上、超时，一律静默跳过：上报失败绝不能卡住 Agent。
#
#   bash scripts/agent/hub.sh report <agent> <事件>   从 stdin 读钩子载荷并上报；会话开始时把任务单输出给 Agent
#   bash scripts/agent/hub.sh notify <agent> '<json>'  以参数传载荷的场景（如 Codex 的 notify）
#   bash scripts/agent/hub.sh event <kind> <摘要>      上报一条事件（git 钩子用）
#   bash scripts/agent/hub.sh api <METHOD> <路径> [JSON] 调 API 并输出响应（task.sh 用）
#   bash scripts/agent/hub.sh progress <0-100|-> <步骤>  汇报当前任务的进度（工作台和手机上实时可见）
#   bash scripts/agent/hub.sh task                     输出当前分支对应的任务编号
#   bash scripts/agent/hub.sh where                    输出执行位置（local / cloud）与主机名
#   bash scripts/agent/hub.sh ping                     检查连接
# 临时关闭上报：AGENT_HUB_DISABLE=1；执行位置自动识别（Claude Code 云端、Codespaces、CI），也可用 AGENT_HUB_LOCATION=local|cloud 指定

HUB_URL="${AGENT_HUB_URL:-}"; HUB_TOKEN="${AGENT_HUB_TOKEN:-}"
HUB_CF_ID="${CF_ACCESS_CLIENT_ID:-}"; HUB_CF_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"
_hub_conf="${AGENT_HUB_CONFIG:-$HOME/.config/agent-hub/env}"
if [ -z "$HUB_URL" ] && [ -r "$_hub_conf" ]; then
  while IFS='=' read -r _k _v; do
    _v=${_v%$'\r'}; _v=${_v#\"}; _v=${_v%\"}
    case "$_k" in AGENT_HUB_URL) HUB_URL=$_v ;; AGENT_HUB_TOKEN) HUB_TOKEN=$_v ;; CF_ACCESS_CLIENT_ID) HUB_CF_ID=$_v ;; CF_ACCESS_CLIENT_SECRET) HUB_CF_SECRET=$_v ;; esac
  done < "$_hub_conf"
fi
HUB_URL=${HUB_URL%/}
[ "${AGENT_HUB_DISABLE:-}" = "1" ] && HUB_URL=""

# JSON 字符串转义
hub_jstr() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; printf '"%s"' "$s"; }
hub_b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
hub_branch() { git symbolic-ref --short HEAD 2>/dev/null || true; }
hub_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }
hub_task() {
  local id
  id=$(hub_branch | sed -nE 's#^agent/(T[0-9]{6}-[a-z0-9]+).*#\1#p')
  [ -n "$id" ] || id=${AGENT_HUB_TASK:-}
  [ -n "$id" ] || id=$(head -n 1 "$(hub_root)/.agent/task" 2>/dev/null || true)
  printf '%s' "$id"
}
# 执行记录编号：执行端派发时由环境变量传入；task.sh start / attach 写在 .agent/run
hub_run() { if [ -n "${AGENT_HUB_RUN:-}" ]; then printf '%s' "$AGENT_HUB_RUN"; else head -n 1 "$(hub_root)/.agent/run" 2>/dev/null || true; fi; }
hub_runner() {
  if [ -n "${AGENT_HUB_RUNNER:-}" ]; then printf '%s' "$AGENT_HUB_RUNNER"; return; fi
  sed -nE 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${AGENT_HUB_RUNNER_FILE:-$HOME/.config/agent-hub/runner.json}" 2>/dev/null | head -n 1
}
hub_location() {
  case "${AGENT_HUB_LOCATION:-}" in local|cloud) printf '%s' "$AGENT_HUB_LOCATION"; return ;; esac
  if [ -n "${CLAUDE_CODE_REMOTE:-}${CODESPACES:-}${GITHUB_ACTIONS:-}${GITPOD_WORKSPACE_ID:-}${CLOUD_SHELL:-}" ]; then printf cloud; else printf local; fi
}
hub_host() {
  if [ -n "${AGENT_HUB_HOST:-}" ]; then printf '%s' "$AGENT_HUB_HOST"
  elif [ -n "${CLAUDE_CODE_REMOTE:-}" ]; then printf 'Claude Code 云端'
  elif [ -n "${CODESPACES:-}" ]; then printf 'Codespaces %s' "${CODESPACE_NAME:-}"
  elif [ -n "${GITHUB_ACTIONS:-}" ]; then printf 'GitHub Actions %s' "${GITHUB_REPOSITORY:-}"
  else uname -n 2>/dev/null || printf '%s' "${HOSTNAME:-}"; fi
}
hub_repo() { local m; m=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); basename "${m:-$PWD}"; }
hub_curl() {
  local access_headers=()
  local connect_timeout="${AGENT_HUB_CONNECT_TIMEOUT:-5}"
  case "$connect_timeout" in ''|*[!0-9]*) connect_timeout=5 ;; esac
  if [ -n "$HUB_CF_ID" ] && [ -n "$HUB_CF_SECRET" ]; then
    access_headers=(-H "CF-Access-Client-Id: $HUB_CF_ID" -H "CF-Access-Client-Secret: $HUB_CF_SECRET")
  fi
  curl -sS --connect-timeout "$connect_timeout" "$@" "${access_headers[@]}" -H "Authorization: Bearer $HUB_TOKEN" -H "X-Hub-Task: $(hub_task)" -H "X-Hub-Branch: $(hub_branch)" -H "X-Hub-Repo: $(hub_b64 "$(hub_repo)")" \
    -H "X-Hub-Run: $(hub_run)" -H "X-Hub-Runner: $(hub_runner)" -H "X-Hub-Location: $(hub_location)" -H "X-Hub-Host: $(hub_b64 "$(hub_host)")"
}
hub_api() {
  local m=$1 p=$2 d=${3:-}
  if [ -z "$HUB_URL" ]; then echo "agent-hub 未配置：运行 connect.mjs 或设置 AGENT_HUB_URL / AGENT_HUB_TOKEN" >&2; return 2; fi
  if [ -n "$d" ]; then hub_curl --max-time 20 --fail-with-body -X "$m" -H "Content-Type: application/json" --data-binary "$d" "$HUB_URL$p"
  else hub_curl --max-time 20 --fail-with-body -X "$m" "$HUB_URL$p"; fi
}

hub_report() {
  local agent=${1:-unknown} ev=${2:-event} body resp tp
  if [ -z "$HUB_URL" ]; then cat >/dev/null 2>&1; return 0; fi
  body=$(cat 2>/dev/null || true)
  [ -n "$body" ] || body='{}'
  case "$ev" in
    SessionStart|sessionStart|AgentSpawn|agentSpawn)
      # 会话开始：等 hub 返回（最多 6 秒），把任务单交给 Agent（各家格式由 hub 负责）
      resp=$(printf '%s' "$body" | hub_curl --max-time 6 -X POST -H "Content-Type: application/json" --data-binary @- "$HUB_URL/hooks/$agent?event=$ev" 2>/dev/null) || resp=""
      case "$resp" in ""|"{}") ;; *) printf '%s\n' "$resp" ;; esac
      ;;
    Stop|stop|agentStop|AgentStop|SessionEnd|sessionEnd|afterAgentResponse|PostTaskExecution)
      # 这些事件可能带交付回执，前台发送（最多 4 秒）
      printf '%s' "$body" | hub_curl --max-time 4 -X POST -H "Content-Type: application/json" --data-binary @- "$HUB_URL/hooks/$agent?event=$ev" >/dev/null 2>&1
      # 载荷里没有回执、但给了会话记录路径（Copilot / Kiro）：把记录尾部发过去提取回执
      if ! printf '%s' "$body" | grep -q 'agent-receipt'; then
        tp=$(printf '%s' "$body" | sed -nE 's/.*"(transcript_path|transcriptPath)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' | head -n 1)
        if [ -n "$tp" ] && [ -f "$tp" ]; then
          tail -c 131072 "$tp" | hub_curl --max-time 4 -X POST -H "Content-Type: text/plain" --data-binary @- "$HUB_URL/hooks/$agent/transcript?event=$ev" >/dev/null 2>&1
        fi
      fi
      ;;
    *)
      # 其余事件后台发送，不占用 Agent 的时间
      ( printf '%s' "$body" | hub_curl --max-time 3 -X POST -H "Content-Type: application/json" --data-binary @- "$HUB_URL/hooks/$agent?event=$ev" >/dev/null 2>&1 & )
      ;;
  esac
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cmd=${1:-help}; shift || true
  case "$cmd" in
    report) hub_report "$@"; exit 0 ;;
    notify) payload=${2:-}; [ -n "$payload" ] || payload='{}'; printf '%s' "$payload" | hub_report "${1:-codex}" notify; exit 0 ;;
    event)
      [ -n "$HUB_URL" ] || exit 0
      d="{\"agent\":\"git\",\"kind\":$(hub_jstr "${1:-other}"),\"summary\":$(hub_jstr "${2:-}"),\"task\":$(hub_jstr "$(hub_task)"),\"branch\":$(hub_jstr "$(hub_branch)"),\"repo\":$(hub_jstr "$(hub_repo)")}"
      hub_curl --max-time 3 -X POST -H "Content-Type: application/json" --data-binary "$d" "$HUB_URL/api/events" >/dev/null 2>&1
      exit 0 ;;
    api) hub_api "$@"; exit $? ;;
    progress)
      [ -n "$HUB_URL" ] || { echo "agent-hub 未配置" >&2; exit 2; }
      id=$(hub_task); [ -n "$id" ] || { echo "当前目录没有关联任务（分支 agent/<编号>-… 或 .agent/task）" >&2; exit 1; }
      p=${1:-}; shift || true; step="$*"
      case "$p" in ''|-|*[!0-9]*) pj=null ;; *) pj=$p ;; esac
      hub_api POST "/api/tasks/$id/progress?agent=${AGENT_HUB_AGENT:-task-sh}" "{\"progress\":$pj,\"step\":$(hub_jstr "$step")}" >/dev/null || exit 1
      echo "已汇报 $id：${pj/null/—}% ${step}"; exit 0 ;;
    task) hub_task; echo; exit 0 ;;
    where) printf '%s · %s\n' "$(hub_location)" "$(hub_host)"; exit 0 ;;
    ping)
      if [ -z "$HUB_URL" ]; then echo "未配置"; exit 2; fi
      capabilities=$(hub_api GET /api/capabilities) || { echo "连接失败：$HUB_URL" >&2; exit 1; }
      if [[ "$capabilities" == *'"version"'* && "$capabilities" == *'"baseUrl"'* && "$capabilities" != *'<html'* ]]; then echo "已连接 $HUB_URL"
      else echo "未取得 Hub 认证响应：检查地址、令牌与 Access 服务凭证" >&2; exit 1; fi ;;
    *) sed -n '2,15p' "$0" ;;
  esac
fi
