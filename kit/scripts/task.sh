#!/usr/bin/env bash
# 本地多 Agent 任务流：一个任务 = 一个分支 + 一个独立 worktree，多个 Agent 可以并行互不干扰。状态自动同步到 agent-hub。
#   bash scripts/agent/task.sh new "<标题>" [--risk L2] [--allow 'src/**'] [--budget 60]   在 hub 新建任务，输出任务编号
#   bash scripts/agent/task.sh start <任务编号> [简述] [--agent codex]   新建分支 agent/<编号>-<简述> 和 worktree，写入任务单，hub 标记“执行中”
#   bash scripts/agent/task.sh run <任务编号> <claude|codex|gemini|cursor|kiro|code>   在该任务的 worktree 里启动 Agent
#   bash scripts/agent/task.sh list                      列出进行中的任务 worktree
#   bash scripts/agent/task.sh brief <任务编号>           从 hub 重新拉取任务单到 specs/<编号>.md
#   bash scripts/agent/task.sh check <任务编号> [范围…]   统一验证 + 越界检查，结果回传 hub
#   bash scripts/agent/task.sh merge <任务编号>           合并回主分支（--no-ff，带 Task 尾注），hub 标记“已合并”
#   bash scripts/agent/task.sh clean <任务编号>           删除该任务的 worktree 和分支
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
. "$HERE/hub.sh"
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
NAME=$(basename "$MAIN")
WT_ROOT=${AGENT_WORKTREES:-"$(dirname "$MAIN")/$NAME.worktrees"}
if [ -n "${AGENT_BASE_BRANCH:-}" ]; then BASE=$AGENT_BASE_BRANCH
elif git -C "$MAIN" show-ref --verify --quiet refs/heads/main; then BASE=main
elif git -C "$MAIN" show-ref --verify --quiet refs/heads/master; then BASE=master
else BASE=$(git -C "$MAIN" symbolic-ref --short HEAD); fi

cmd=${1:-help}; id=${2:-}
need_id(){ [ -n "$id" ] || { echo "缺少任务编号，例如 T260922-a1b" >&2; exit 1; }; }
branch_of(){ git -C "$MAIN" for-each-ref --format='%(refname:short)' "refs/heads/agent/" | grep -E "^agent/$id(-|$)" | head -n 1 || true; }
dir_of(){ local b; b=$(branch_of); [ -n "$b" ] || return 0; git -C "$MAIN" worktree list --porcelain | awk -v b="branch refs/heads/$b" '/^worktree /{p=substr($0,10)} $0==b{print p}'; }
hub_on(){ [ -n "$HUB_URL" ]; }
jarr(){ local out="" x; for x in "$@"; do out="$out${out:+,}$(hub_jstr "$x")"; done; printf '[%s]' "$out"; }
write_brief(){ # $1=目录
  mkdir -p "$1/specs" "$1/.agent"; printf '*\n' > "$1/.agent/.gitignore"; printf '%s\n' "$id" > "$1/.agent/task"
  if hub_on && hub_api GET "/api/tasks/$id/brief" > "$1/specs/$id.md.tmp" 2>/dev/null; then mv "$1/specs/$id.md.tmp" "$1/specs/$id.md"; return 0; fi
  rm -f "$1/specs/$id.md.tmp"; return 1
}

case "$cmd" in
  new)
    shift; title=${1:-}; [ -n "$title" ] || { echo "用法：task.sh new \"<标题>\" [--risk L2] [--allow 'src/**'] [--budget 60] [--status 待执行]" >&2; exit 1; }; shift
    risk=L2; allow=""; budget=60; status="待执行"
    while [ $# -gt 0 ]; do case "$1" in --risk) risk=${2:-L2}; shift 2 || shift ;; --allow) allow=${2:-}; shift 2 || shift ;; --budget) budget=${2:-60}; shift 2 || shift ;; --status) status=${2:-待执行}; shift 2 || shift ;; *) shift ;; esac; done
    case "$budget" in ''|*[!0-9]*) budget=60 ;; esac
    hub_on || { echo "agent-hub 未配置，无法新建任务" >&2; exit 1; }
    resp=$(hub_api POST /api/tasks "{\"title\":$(hub_jstr "$title"),\"risk\":$(hub_jstr "$risk"),\"allow\":$(hub_jstr "$allow"),\"budgetMin\":$budget,\"status\":$(hub_jstr "$status"),\"repo\":$(hub_jstr "$NAME")}")
    nid=$(printf '%s' "$resp" | sed -nE 's/^\{"id":"([^"]+)".*/\1/p')
    echo "已创建 $nid：$title"
    echo "开工：bash scripts/agent/task.sh start $nid <简述>"
    ;;
  start)
    need_id
    shift 2 || true
    slug=task; agent=""
    while [ $# -gt 0 ]; do case "$1" in --agent) agent=${2:-}; shift 2 || shift ;; --*) shift ;; *) slug=$1; shift ;; esac; done
    slug=$(printf '%s' "$slug" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//')
    b="agent/$id-${slug:-task}"
    [ -z "$(branch_of)" ] || { echo "任务 $id 的分支已存在：$(branch_of)" >&2; exit 1; }
    mkdir -p "$WT_ROOT"
    git -C "$MAIN" worktree add -q -b "$b" "$WT_ROOT/$id" "$BASE"
    echo "已创建 worktree：$WT_ROOT/$id（分支 $b，基于 $BASE）"
    if hub_on; then
      hub_api POST "/api/tasks/$id/start" "{\"branch\":$(hub_jstr "$b"),\"worktree\":$(hub_jstr "$WT_ROOT/$id"),\"repo\":$(hub_jstr "$NAME"),\"agent\":$(hub_jstr "$agent")}" >/dev/null 2>&1 \
        && echo "agent-hub：任务 $id 已标记为“执行中”" || echo "提示：agent-hub 更新失败（任务编号不存在或 hub 未启动），可稍后在工作台手动推进" >&2
    fi
    if write_brief "$WT_ROOT/$id"; then echo "任务单已写入：$WT_ROOT/$id/specs/$id.md"
    else echo "下一步：把工作台“复制任务单”的内容保存为 $WT_ROOT/$id/specs/$id.md"; fi
    echo
    echo "在这个目录里打开任意 Agent（会话开始时钩子会自动注入任务单）："
    echo "  cd \"$WT_ROOT/$id\" && claude        # 或 codex / cursor . / kiro . / code .（Copilot）"
    echo "  也可以：bash scripts/agent/task.sh run $id claude"
    ;;
  run)
    need_id; ag=${3:-claude}; d=$(dir_of); [ -n "$d" ] || { echo "找不到任务 $id 的 worktree，先运行 task.sh start" >&2; exit 1; }
    [ -f "$d/specs/$id.md" ] || write_brief "$d" || true
    prompt="执行任务 $id：先阅读 specs/$id.md（任务单），按验收标准和允许修改的范围实现；结束前运行 bash scripts/agent/verify.sh，最后按 AGENTS.md 输出交付回执。"
    cd "$d"
    case "$ag" in
      claude) exec claude "$prompt" ;;
      codex)  exec codex "$prompt" ;;
      gemini) exec gemini -i "$prompt" ;;
      cursor) exec cursor "$d" ;;
      kiro)   exec kiro "$d" ;;
      code|copilot) exec code "$d" ;;
      *) echo "未知 Agent：$ag。请手动：cd \"$d\" 后启动，并发送：$prompt" >&2; exit 1 ;;
    esac
    ;;
  brief)
    need_id; d=$(dir_of); [ -n "$d" ] || d=$MAIN
    write_brief "$d" && echo "已更新 $d/specs/$id.md" || { echo "拉取失败（hub 未配置或任务不存在）" >&2; exit 1; }
    ;;
  list)
    git -C "$MAIN" worktree list | grep -F "[agent/" || echo "没有进行中的任务 worktree"
    ;;
  check)
    need_id; d=$(dir_of); [ -n "$d" ] || { echo "找不到任务 $id 的 worktree" >&2; exit 1; }
    shift 2
    globs=()
    if [ $# -gt 0 ]; then globs=("$@")
    elif [ -f "$d/specs/$id.md" ]; then
      line=$(grep -m1 -E '允许修改(:|：)' "$d/specs/$id.md" | sed -E 's/.*允许修改(:|：)[[:space:]]*//' || true)
      case "$line" in ""|未限定*) ;;
        *) while IFS= read -r g; do [ -n "$g" ] && globs+=("$g"); done < <(printf '%s\n' "$line" | awk '{gsub(/（[^）]*）/,""); gsub(/、|，|,/,"\n"); print}' | awk '{gsub(/^[ \t]+|[ \t]+$/,""); if (length($0)) print}') ;;
      esac
    fi
    cd "$d"
    echo "== 统一验证 =="; vr=0
    mkdir -p .agent; bash scripts/agent/verify.sh 2>&1 | tee .agent/check.log || vr=1
    changed=$( { git diff --name-only "$BASE"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u | grep -vE '^(specs|\.agent)/' || true)
    echo; echo "== 改动文件（相对 $BASE）=="
    if [ -n "$changed" ]; then printf '%s\n' "$changed" | sed 's/^/  /'; else echo "  （无）"; fi
    out=""
    echo; if [ ${#globs[@]} -gt 0 ]; then
      echo "== 范围检查（允许：${globs[*]}）=="
      while IFS= read -r f; do
        [ -n "$f" ] || continue; ok=0
        for g in "${globs[@]}"; do g=${g//\*\*/*}; case "$f" in $g) ok=1; break ;; esac; done
        [ $ok -eq 1 ] || out="$out$f"$'\n'
      done <<< "$changed"
      if [ -n "$out" ]; then printf '%s' "$out" | sed 's/^/  越界：/'; else echo "  全部在允许范围内"; fi
    else echo "== 范围检查：没有允许范围，已跳过 =="; fi
    if [ -n "$(git status --porcelain | grep -vE ' (specs|\.agent)/' || true)" ]; then echo; echo "提示：还有未提交的改动"; fi
    result=1; [ $vr -eq 0 ] && [ -z "$out" ] && result=0
    if hub_on; then
      items=""
      while IFS= read -r l; do case "$l" in pass:\ *) items="$items${items:+,}{\"cmd\":$(hub_jstr "${l#pass: }"),\"result\":\"pass\"}" ;; fail:\ *) items="$items${items:+,}{\"cmd\":$(hub_jstr "${l#fail: }"),\"result\":\"fail\"}" ;; esac; done < .agent/check.log
      stat=$(git diff --shortstat "$BASE"...HEAD 2>/dev/null || true)
      add=$(printf '%s' "$stat" | sed -nE 's/.* ([0-9]+) insertion.*/\1/p'); del=$(printf '%s' "$stat" | sed -nE 's/.* ([0-9]+) deletion.*/\1/p')
      ch=(); oos=()
      while IFS= read -r l; do [ -n "$l" ] && ch+=("$l"); done <<< "$changed"
      while IFS= read -r l; do [ -n "$l" ] && oos+=("$l"); done <<< "$out"
      hub_api POST "/api/tasks/$id/check" "{\"ok\":$([ $result = 0 ] && echo true || echo false),\"verify\":[${items}],\"changed\":$(jarr ${ch[@]+"${ch[@]}"}),\"outOfScope\":$(jarr ${oos[@]+"${oos[@]}"}),\"added\":${add:-0},\"removed\":${del:-0},\"by\":\"task.sh\",\"branch\":$(hub_jstr "$(hub_branch)"),\"repo\":$(hub_jstr "$NAME")}" >/dev/null 2>&1 && echo && echo "（检查结果已回传 agent-hub）" || true
    fi
    echo
    if [ $result -eq 0 ]; then echo "结果：通过"; exit 0; fi
    echo "结果：未通过"; exit 1
    ;;
  merge)
    need_id; b=$(branch_of); d=$(dir_of); [ -n "$b" ] || { echo "找不到任务 $id 的分支" >&2; exit 1; }
    if [ -n "$d" ] && [ -n "$(git -C "$d" status --porcelain | grep -vE ' (specs|\.agent)/' || true)" ]; then echo "worktree 里还有未提交的改动，请先提交或处理" >&2; exit 1; fi
    cur=$(git -C "$MAIN" symbolic-ref --short HEAD)
    [ "$cur" = "$BASE" ] || { echo "主工作区当前在 $cur，请先切回 $BASE" >&2; exit 1; }
    if ! git -C "$MAIN" merge --no-ff "$b" -m "Merge $b" -m "Task: $id"; then
      git -C "$MAIN" merge --abort 2>/dev/null || true
      echo "合并未完成（验证失败或有冲突），主分支已恢复原状" >&2; exit 1
    fi
    sha=$(git -C "$MAIN" rev-parse HEAD)
    if hub_on && hub_api POST "/api/tasks/$id/merged" "{\"commit\":\"$sha\",\"base\":$(hub_jstr "$BASE"),\"branch\":$(hub_jstr "$b"),\"repo\":$(hub_jstr "$NAME")}" >/dev/null 2>&1; then
      echo "已合并到 $BASE，agent-hub 已标记“已合并”。清理：bash scripts/agent/task.sh clean $id"
    else
      echo "已合并到 $BASE。请在工作台把任务标记为“已合并”，然后运行：bash scripts/agent/task.sh clean $id"
    fi
    ;;
  clean)
    need_id; b=$(branch_of); d=$(dir_of)
    if [ -n "$d" ]; then git -C "$MAIN" worktree remove --force "$d"; fi
    if [ -n "$b" ]; then git -C "$MAIN" branch -d "$b" || echo "分支 $b 还没合并；确定放弃请运行：git branch -D $b"; fi
    echo "已清理任务 $id"
    ;;
  *) sed -n '2,11p' "$0" ;;
esac
