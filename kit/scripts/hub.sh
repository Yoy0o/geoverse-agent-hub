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
#   bash scripts/agent/hub.sh ping                     检查连接（含暂存的上报数量、Hub 是否已停用）
#   bash scripts/agent/hub.sh flush                    立即补发网络中断时暂存的上报
#   bash scripts/agent/hub.sh backup [目录]            下载 JSON 备份（任务、规则、复盘、设置）
# 临时关闭上报：AGENT_HUB_DISABLE=1；执行位置自动识别（Claude Code 云端、Codespaces、CI），也可用 AGENT_HUB_LOCATION=local|cloud 指定
# 网络中断时，事件、回执、进度先暂存在 ~/.cache/agent-hub/spool（AGENT_HUB_SPOOL），下次上报成功后在后台按原始时间补发

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
HUB_ACCESS=()
if [ -n "$HUB_CF_ID" ] && [ -n "$HUB_CF_SECRET" ]; then HUB_ACCESS=(-H "CF-Access-Client-Id: $HUB_CF_ID" -H "CF-Access-Client-Secret: $HUB_CF_SECRET"); fi
HUB_SPOOL="${AGENT_HUB_SPOOL:-$HOME/.cache/agent-hub/spool}"

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
hub_timeout() { local t="${AGENT_HUB_CONNECT_TIMEOUT:-5}"; case "$t" in ''|*[!0-9]*) t=5 ;; esac; printf '%s' "$t"; }
hub_curl() {
  curl -sS --connect-timeout "$(hub_timeout)" "$@" ${HUB_ACCESS[@]+"${HUB_ACCESS[@]}"} -H "Authorization: Bearer $HUB_TOKEN" -H "X-Hub-Task: $(hub_task)" -H "X-Hub-Branch: $(hub_branch)" -H "X-Hub-Repo: $(hub_b64 "$(hub_repo)")" \
    -H "X-Hub-Run: $(hub_run)" -H "X-Hub-Runner: $(hub_runner)" -H "X-Hub-Location: $(hub_location)" -H "X-Hub-Host: $(hub_b64 "$(hub_host)")"
}
hub_api() {
  local m=$1 p=$2 d=${3:-}
  if [ -z "$HUB_URL" ]; then echo "agent-hub 未配置：运行 connect.mjs 或设置 AGENT_HUB_URL / AGENT_HUB_TOKEN" >&2; return 2; fi
  if [ -n "$d" ]; then hub_curl --max-time 20 --fail-with-body -X "$m" -H "Content-Type: application/json" --data-binary "$d" "$HUB_URL$p"
  else hub_curl --max-time 20 --fail-with-body -X "$m" "$HUB_URL$p"; fi
}

# ---------------- 离线暂存：上报失败先存在本地，恢复后按原始时间补发 ----------------
# 每条一个文件：第一行是 路径、Content-Type 和上报时的任务 / 分支 / 执行等元数据（\x1f 分隔，空字段不会被合并），其后是正文
hub_spool_count() { ls "$HUB_SPOOL" 2>/dev/null | grep -c '\.req$' || true; }
hub_spool() { # $1=路径 $2=Content-Type；正文从 stdin
  if [ "${AGENT_HUB_NO_SPOOL:-}" = "1" ] || ! mkdir -p "$HUB_SPOOL" 2>/dev/null; then cat >/dev/null 2>&1; return 0; fi
  local n f
  n=$(hub_spool_count)
  # 最多保留 500 条，超出时丢弃最早的
  if [ "${n:-0}" -ge 500 ]; then ls "$HUB_SPOOL" | grep '\.req$' | head -n $((n - 499)) | while IFS= read -r f; do rm -f "$HUB_SPOOL/$f"; done; fi
  f="$HUB_SPOOL/$(date +%s)-$$-$RANDOM.req"
  { printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n' "$1" "$2" "$(hub_task)" "$(hub_branch)" "$(hub_b64 "$(hub_repo)")" "$(hub_run)" "$(hub_runner)" "$(hub_location)" "$(hub_b64 "$(hub_host)")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; cat; } > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
  return 0
}
# 按时间顺序补发；同一时间只有一个补发进程；网络仍不通时停下，下次再试。输出成功补发的条数
hub_flush() {
  local lock="$HUB_SPOOL/.flushing" f p ct task branch repo run runner loc host at code sent=0
  [ -n "$HUB_URL" ] && [ "$(hub_spool_count)" != "0" ] || { printf '0'; return 0; }
  if ! mkdir "$lock" 2>/dev/null; then
    [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null && mkdir "$lock" 2>/dev/null || { printf '0'; return 0; }
  fi
  for f in "$HUB_SPOOL"/*.req; do
    [ -f "$f" ] || continue
    IFS=$'\x1f' read -r p ct task branch repo run runner loc host at < "$f"
    code=$(tail -n +2 "$f" | curl -sS --connect-timeout "$(hub_timeout)" --max-time 15 -o /dev/null -w '%{http_code}' -X POST ${HUB_ACCESS[@]+"${HUB_ACCESS[@]}"} \
      -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: $ct" -H "X-Hub-Task: $task" -H "X-Hub-Branch: $branch" -H "X-Hub-Repo: $repo" \
      -H "X-Hub-Run: $run" -H "X-Hub-Runner: $runner" -H "X-Hub-Location: $loc" -H "X-Hub-Host: $host" -H "X-Hub-At: $at" --data-binary @- "$HUB_URL$p" 2>/dev/null) || code=000
    case "$code" in
      2*) rm -f "$f"; sent=$((sent + 1)) ;;
      408|429|5*|000) break ;;   # 还是连不上：保留
      *) rm -f "$f" ;;            # 其他 4xx（任务已删除、Hub 已停用……）：重发也不会成功
    esac
  done
  rmdir "$lock" 2>/dev/null
  printf '%s' "$sent"
}
hub_flush_bg() { [ "$(hub_spool_count)" != "0" ] && ( hub_flush >/dev/null 2>&1 & ); return 0; }
# 发送一条上报：连不上、超时、服务端出错时暂存；成功时顺便在后台补发积压的上报
hub_send() { # $1=路径 $2=Content-Type $3=超时秒 $4=正文
  local code
  code=$(printf '%s' "$4" | hub_curl --max-time "$3" -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: $2" --data-binary @- "$HUB_URL$1" 2>/dev/null) || code=000
  case "$code" in
    2*) hub_flush_bg; return 0 ;;
    408|429|5*|000) printf '%s' "$4" | hub_spool "$1" "$2"; return 1 ;;
    *) return 0 ;;
  esac
}

hub_report() {
  local agent=${1:-unknown} ev=${2:-event} body resp tp out code tdata
  if [ -z "$HUB_URL" ]; then cat >/dev/null 2>&1; return 0; fi
  body=$(cat 2>/dev/null || true)
  [ -n "$body" ] || body='{}'
  case "$ev" in
    SessionStart|sessionStart|AgentSpawn|agentSpawn)
      # 会话开始：等 hub 返回（最多 6 秒），把任务单交给 Agent（各家格式由 hub 负责）
      out=$(printf '%s' "$body" | hub_curl --max-time 6 -w '\n%{http_code}' -X POST -H "Content-Type: application/json" --data-binary @- "$HUB_URL/hooks/$agent?event=$ev" 2>/dev/null) || true
      code=${out##*$'\n'}; resp=${out%$'\n'*}
      case "$code" in
        2*) case "$resp" in ""|"{}") ;; *) printf '%s\n' "$resp" ;; esac; hub_flush_bg ;;
        408|429|5*|000|"") printf '%s' "$body" | hub_spool "/hooks/$agent?event=$ev" application/json ;;   # 任务单没能注入（specs/ 里仍有），开工记录稍后补发
      esac
      ;;
    Stop|stop|agentStop|AgentStop|SessionEnd|sessionEnd|afterAgentResponse|PostTaskExecution)
      # 这些事件可能带交付回执，前台发送（最多 4 秒）；失败时暂存，回执不会丢
      hub_send "/hooks/$agent?event=$ev" application/json 4 "$body"
      # 载荷里没有回执、但给了会话记录路径（Copilot / Kiro）：会话记录尾部有回执时发过去提取
      if ! printf '%s' "$body" | grep -q 'agent-receipt'; then
        tp=$(printf '%s' "$body" | sed -nE 's/.*"(transcript_path|transcriptPath)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' | head -n 1)
        if [ -n "$tp" ] && [ -f "$tp" ]; then
          tdata=$(tail -c 131072 "$tp" 2>/dev/null)
          if printf '%s' "$tdata" | grep -q 'agent-receipt'; then hub_send "/hooks/$agent/transcript?event=$ev" text/plain 4 "$tdata"; fi
        fi
      fi
      ;;
    *)
      # 其余事件后台发送，不占用 Agent 的时间
      ( hub_send "/hooks/$agent?event=$ev" application/json 3 "$body" >/dev/null 2>&1 & )
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
      hub_send /api/events application/json 3 "$d"
      exit 0 ;;
    api) hub_api "$@"; exit $? ;;
    progress)
      [ -n "$HUB_URL" ] || { echo "agent-hub 未配置" >&2; exit 2; }
      id=$(hub_task); [ -n "$id" ] || { echo "当前目录没有关联任务（分支 agent/<编号>-… 或 .agent/task）" >&2; exit 1; }
      p=${1:-}; shift || true; step="$*"
      case "$p" in ''|-|*[!0-9]*) pj=null ;; *) pj=$p ;; esac
      if hub_send "/api/tasks/$id/progress?agent=${AGENT_HUB_AGENT:-task-sh}" application/json 10 "{\"progress\":$pj,\"step\":$(hub_jstr "$step")}"; then
        echo "已汇报 $id：${pj/null/—}% ${step}"
      else echo "连不上 agent-hub，进度已暂存，恢复后自动补发：$id ${pj/null/—}% ${step}"; fi
      exit 0 ;;
    flush)
      [ -n "$HUB_URL" ] || { echo "agent-hub 未配置" >&2; exit 2; }
      n=$(hub_flush); echo "已补发 ${n:-0} 条，剩余 $(hub_spool_count) 条（$HUB_SPOOL）"; exit 0 ;;
    backup)
      [ -n "$HUB_URL" ] || { echo "agent-hub 未配置" >&2; exit 2; }
      dir=${1:-$HOME/agent-hub-backups}; mkdir -p "$dir" || exit 1
      f="$dir/agent-hub-backup-$(date +%Y%m%d-%H%M%S).json"
      if hub_api GET /api/export > "$f.tmp" && grep -q '"app":"agent-workbench"' "$f.tmp"; then mv "$f.tmp" "$f"; echo "已备份到 $f"; exit 0; fi
      rm -f "$f.tmp"; echo "备份失败：检查连接与令牌" >&2; exit 1 ;;
    task) hub_task; echo; exit 0 ;;
    where) printf '%s · %s\n' "$(hub_location)" "$(hub_host)"; exit 0 ;;
    ping)
      if [ -z "$HUB_URL" ]; then echo "未配置"; exit 2; fi
      capabilities=$(hub_api GET /api/capabilities) || { echo "连接失败：$HUB_URL" >&2; exit 1; }
      if [[ "$capabilities" == *'"version"'* && "$capabilities" == *'"baseUrl"'* && "$capabilities" != *'<html'* ]]; then
        echo "已连接 $HUB_URL"
        n=$(hub_spool_count); [ "${n:-0}" = "0" ] || echo "有 $n 条暂存的上报等待补发（bash scripts/agent/hub.sh flush 立即补发）"
        retired=$(printf '%s' "$capabilities" | sed -nE 's/.*"retiredTo":"([^"]+)".*/\1/p')
        if [ -n "$retired" ]; then echo "注意：这个 Hub 已停用（只读），数据以 $retired 为准。运行 connect.mjs --url $retired 切换到云端。" >&2; exit 3; fi
      else echo "未取得 Hub 认证响应：检查地址、令牌与 Access 服务凭证" >&2; exit 1; fi ;;
    *) sed -n '2,19p' "$0" ;;
  esac
fi
