#!/usr/bin/env bash
# 端到端测试：启动 hub → 建项目 → 生成接入包装进临时仓库 → task.sh 全流程 →
# 模拟 Claude Code / Codex / Cursor / Copilot / Kiro 的钩子载荷 → OTel → MCP → connect.mjs
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8791}
T=$(mktemp -d)
export HUB_DATA_DIR="$T/data" HUB_TOKEN=e2e-token PORT
export AGENT_HUB_URL="http://127.0.0.1:$PORT" AGENT_HUB_TOKEN=e2e-token AGENT_HUB_CONFIG="$T/none"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
ko(){ echo "  ✗ $1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else ko "$1"; fi; }
api(){ curl -sS -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" "$@"; }
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }

node --disable-warning=ExperimentalWarning src/server.js > "$T/hub.log" 2>&1 &
HUBPID=$!
trap 'kill $HUBPID 2>/dev/null; rm -rf "$T"' EXIT
for i in $(seq 1 30); do curl -sf "$AGENT_HUB_URL/api/health" >/dev/null && break; sleep 0.2; done

echo "== 1. 启动与导入 =="
check "health" '[ "$(curl -s $AGENT_HUB_URL/api/health | jget o.ok)" = "true" ]'
check "未带令牌 401" '[ "$(curl -s -o /dev/null -w %{http_code} $AGENT_HUB_URL/api/tasks)" = "401" ]'
BK=$(ls "$ROOT"/migrate/*.json 2>/dev/null | head -n 1)
[ -n "$BK" ] && check "导入原工作台备份" '[ "$(api -X POST --data-binary @$BK $AGENT_HUB_URL/api/import | jget o.tasks)" -ge 1 ]'
CFG=$(api "$AGENT_HUB_URL/api/docs/config/main" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s).data;o.projects=(o.projects||[]).filter(p=>p.name!=='demo');o.projects.push({name:'demo',path:'/tmp/x/demo-app',stage:'开发中',stack:'bash',verify:['test -f README.md','bash check.sh'],invariants:['README 必须存在'],forbidden:[],protect:['db/migrations/*','*.lock']});console.log(JSON.stringify(o))})")
api -X PUT --data-binary "$CFG" "$AGENT_HUB_URL/api/docs/config/main" >/dev/null
check "新增项目 demo" '[ "$(api $AGENT_HUB_URL/api/docs/config/main | jget "o.data.projects.some(p=>p.name===\"demo\")")" = "true" ]'

echo "== 2. 接入包装进临时仓库 =="
REPO="$T/demo-app"; mkdir -p "$REPO/src" "$REPO/db/migrations"; cd "$REPO"
git init -q -b main; git config user.email e2e@example.com; git config user.name e2e
echo "# demo" > README.md; echo 'exit ${FAIL:-0}' > check.sh; echo "x" > src/a.js; git add -A; git commit -qm init
api "$AGENT_HUB_URL/api/projects/demo/kit.zip" -o "$T/kit.zip"
check "下载接入包 zip" '[ -s "$T/kit.zip" ]'
(cd "$T" && unzip -q kit.zip)
bash "$T/agent-kit-demo/install.sh" "$REPO" > "$T/install.log" 2>&1
check "install.sh 成功" 'grep -q "统一验证通过" "$T/install.log"'
check "hub 连接检查通过" 'grep -q "已连接" "$T/install.log"'
for f in AGENTS.md CLAUDE.md .claude/settings.json .codex/hooks.json .cursor/hooks.json .github/hooks/agent-hub.json .kiro/hooks/agent-hub.json .kiro/steering/agent-hub.md scripts/agent/hub.sh scripts/agent/guard.sh .githooks/post-commit; do
  [ -f "$REPO/$f" ] || ko "缺少 $f"
done
check "各 Agent 配置是合法 JSON" 'for f in .claude/settings.json .codex/hooks.json .cursor/hooks.json .github/hooks/agent-hub.json .kiro/hooks/agent-hub.json; do node -e "JSON.parse(require(\"fs\").readFileSync(\"$f\",\"utf8\"))" || exit 1; done'
check "AGENTS.md 含回执格式与 agent-hub 说明" 'grep -q "agent-receipt" AGENTS.md && grep -q "submit_receipt" AGENTS.md'
git add -A && git commit -qm "chore: 接入 agent-hub"

echo "== 3. task.sh new / start =="
OUT=$(bash scripts/agent/task.sh new "导出改为异步" --allow 'src/**' --risk L2)
ID=$(printf '%s' "$OUT" | sed -nE 's/^已创建 (T[0-9]{6}-[a-z0-9]+).*/\1/p')
check "task.sh new 返回编号 $ID" '[ -n "$ID" ]'
check "新任务自动归到项目 demo" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.project)" = "demo" ]'
bash scripts/agent/task.sh start "$ID" export --agent claude-code > "$T/start.log" 2>&1
WT="$T/demo-app.worktrees/$ID"
check "worktree 已创建" '[ -d "$WT" ]'
check "任务单自动写入 specs/$ID.md" 'grep -q "允许修改：src/\*\*" "$WT/specs/$ID.md"'
check "hub 状态变为 执行中" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.status)" = "执行中" ]'
check "分支记录到任务" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.branch)" = "agent/$ID-export" ]'

echo "== 4. Claude Code 钩子 =="
cd "$WT"
S1="sess-claude-$RANDOM"
RESP=$(printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup","model":"claude-sonnet-5"}' "$S1" "$WT" | bash scripts/agent/hub.sh report claude-code SessionStart)
check "SessionStart 注入任务单（hookSpecificOutput.additionalContext）" 'printf "%s" "$RESP" | jget "o.hookSpecificOutput.additionalContext" | grep -q "$ID"'
printf '{"session_id":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/db/migrations/001.sql"}}' "$S1" "$WT" | CLAUDE_PROJECT_DIR="$WT" bash scripts/agent/guard.sh claude-code 2>"$T/guard.err"; rc=$?
check "PreToolUse 拦截受保护路径（退出码 2）" '[ $rc -eq 2 ] && grep -q "受保护路径" "$T/guard.err"'
printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/src/b.js"}}' "$WT" | bash scripts/agent/guard.sh claude-code; rc=$?
check "允许范围内的修改放行" '[ $rc -eq 0 ]'
printf '{"tool_name":"Read","tool_input":{"file_path":"%s/db/migrations/001.sql"}}' "$WT" | bash scripts/agent/guard.sh claude-code; rc=$?
check "读受保护路径不拦" '[ $rc -eq 0 ]'
printf '{"session_id":"%s","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/src/b.js"}}' "$S1" "$WT" "$WT" | bash scripts/agent/hub.sh report claude-code PostToolUse
echo "y" > src/b.js; git add -A; git commit -qm "feat: b"
check "commit-msg 自动补 Task 尾注" 'git log -1 --pretty=%B | grep -q "Task: $ID"'
# 结束前验证：让验证失败
printf '%s' '{}' | FAIL=1 bash scripts/agent/stop-verify.sh claude-code 2>"$T/stop.err"; rc=$?
check "Stop 钩子：验证失败时退出码 2 让 Agent 继续修" '[ $rc -eq 2 ] && grep -q "统一验证未通过" "$T/stop.err"'
printf '%s' '{}' | FAIL=1 bash scripts/agent/stop-verify.sh cursor > "$T/stop.out" 2>/dev/null; rc=$?
check "Cursor stop 钩子：返回 followup_message" '[ $rc -eq 0 ] && jget "o.followup_message" < "$T/stop.out" | grep -q "统一验证未通过"'
printf '%s' '{}' | bash scripts/agent/stop-verify.sh claude-code; rc=$?
check "验证通过后放行" '[ $rc -eq 0 ]'
MSG=$'已完成。\n\n```agent-receipt\ntask: '"$ID"$'\nstatus: done\nsummary: 订单导出改为异步生成\nchanged:\n  - src/b.js\nverify:\n  - bash scripts/agent/verify.sh: pass\nscope: ok\nrisks: 无\nsession: '"$S1"$'\nminutes: 12\nci_rounds: 1\n```'
node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],hook_event_name:"Stop",last_assistant_message:process.argv[3]}))' "$S1" "$WT" "$MSG" | bash scripts/agent/hub.sh report claude-code Stop
sleep 0.5
check "Stop 钩子回传回执 → 待评审" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.status)" = "待评审" ]'
check "回执内容写入任务" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.receipt.summary)" = "订单导出改为异步生成" ]'
check "任务 Agent 字段 = Claude Code" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.agent)" = "Claude Code" ]'

echo "== 5. OTel（Claude Code 日志事件）=="
NS=$(date +%s)000000000
OTLP=$(cat <<EOF
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeLogs":[{"logRecords":[
 {"timeUnixNano":"$NS","body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"event.name","value":{"stringValue":"api_request"}},{"key":"session.id","value":{"stringValue":"$S1"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}},{"key":"cost_usd","value":{"doubleValue":0.42}},{"key":"input_tokens","value":{"intValue":"12000"}},{"key":"output_tokens","value":{"intValue":"800"}}]},
 {"timeUnixNano":"$NS","body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"event.name","value":{"stringValue":"api_request"}},{"key":"session.id","value":{"stringValue":"$S1"}},{"key":"model","value":{"stringValue":"claude-sonnet-5"}},{"key":"cost_usd","value":{"doubleValue":0.08}},{"key":"input_tokens","value":{"intValue":"3000"}},{"key":"output_tokens","value":{"intValue":"200"}}]}
]}]}]}
EOF
)
api -X POST --data-binary "$OTLP" "$AGENT_HUB_URL/v1/logs" >/dev/null
check "OTel 成本汇总到任务（\$0.50）" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.usage.costUsd)" = "0.5" ]'
check "换算成人民币写入 cost" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget o.cost)" = "3.6" ]'
check "gzip 压缩的 OTLP 也能解析" 'printf "%s" "$OTLP" | gzip | curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" -H "Content-Encoding: gzip" --data-binary @- $AGENT_HUB_URL/v1/metrics | grep -q 200'
check "protobuf 请求返回 415 提示" '[ "$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/x-protobuf" --data-binary x $AGENT_HUB_URL/v1/logs)" = "415" ]'

echo "== 6. task.sh check / merge =="
echo "z" > README.extra; git add -A; git commit -qm "chore: 越界文件"
bash scripts/agent/task.sh check "$ID" > "$T/check.log" 2>&1; rc=$?
check "task.sh check 发现越界文件" '[ $rc -ne 0 ] && grep -q "越界：README.extra" "$T/check.log"'
check "检查结果回传 hub（lastCheck.outOfScope）" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget "o.lastCheck.outOfScope[0]")" = "README.extra" ]'
git rm -q README.extra; git commit -qm "revert extra"
bash scripts/agent/task.sh check "$ID" > "$T/check2.log" 2>&1; rc=$?
check "修正后 check 通过" '[ $rc -eq 0 ]'
sleep 0.3
check "post-commit 上报提交事件" '[ "$(api "$AGENT_HUB_URL/api/tasks/$ID/activity" | jget "o.events.filter(e=>e.kind===\"commit\").length")" -ge 1 ]'
cd "$REPO"
bash scripts/agent/task.sh merge "$ID" > "$T/merge.log" 2>&1; rc=$?
check "task.sh merge 成功" '[ $rc -eq 0 ]'
check "hub 标记 已合并 且记为一次通过" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID | jget "o.status+\"/\"+o.review.firstPass")" = "已合并/true" ]'
bash scripts/agent/task.sh clean "$ID" >/dev/null 2>&1

echo "== 7. 其他 Agent 的协议 =="
ID2=$(api -X POST -d '{"title":"多 Agent 协议测试","project":"demo","allow":"src/**"}' "$AGENT_HUB_URL/api/tasks" | jget o.id)
bash scripts/agent/task.sh start "$ID2" proto >/dev/null 2>&1
WT2="$T/demo-app.worktrees/$ID2"; cd "$WT2"
# Codex
R=$(printf '{"session_id":"cx-1","cwd":"%s","hook_event_name":"SessionStart","source":"startup","model":"gpt-5.5"}' "$WT2" | bash scripts/agent/hub.sh report codex SessionStart)
check "Codex SessionStart 注入上下文" 'printf "%s" "$R" | jget "o.hookSpecificOutput.additionalContext" | grep -q "$ID2"'
R=$(printf '{"session_id":"cx-1","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: db/migrations/002.sql\\n@@\\n-a\\n+b\\n*** End Patch"}}' | bash scripts/agent/guard.sh codex)
check "Codex apply_patch 改受保护路径 → JSON deny" '[ "$(printf "%s" "$R" | jget o.hookSpecificOutput.permissionDecision)" = "deny" ]'
# Cursor
R=$(printf '{"conversation_id":"cu-1","session_id":"cu-1","hook_event_name":"sessionStart","workspace_roots":["%s"]}' "$WT2" | bash scripts/agent/hub.sh report cursor sessionStart)
check "Cursor sessionStart 返回 additional_context" 'printf "%s" "$R" | jget o.additional_context | grep -q "$ID2"'
R=$(printf '{"conversation_id":"cu-1","tool_name":"Write","tool_input":{"file_path":"%s/yarn.lock"}}' "$WT2" | bash scripts/agent/guard.sh cursor)
check "Cursor 改 *.lock → permission deny" '[ "$(printf "%s" "$R" | jget o.permission)" = "deny" ]'
# Copilot：agentStop 不带回复，回执从会话记录尾部提取
R=$(printf '{"sessionId":"cp-1","cwd":"%s","source":"new"}' "$WT2" | bash scripts/agent/hub.sh report copilot sessionStart)
check "Copilot sessionStart 返回 additionalContext" 'printf "%s" "$R" | jget o.additionalContext | grep -q "$ID2"'
R=$(printf '{"sessionId":"cp-1","toolName":"edit","toolArgs":{"path":"%s/db/migrations/003.sql"}}' "$WT2" | bash scripts/agent/guard.sh copilot)
check "Copilot edit 受保护路径 → permissionDecision deny" '[ "$(printf "%s" "$R" | jget o.permissionDecision)" = "deny" ]'
R=$(printf '{"sessionId":"cp-1","toolName":"bash","toolArgs":{"command":"ls"}}' | bash scripts/agent/guard.sh copilot; echo "rc=$?")
check "Copilot 非写入工具放行且无输出" '[ "$R" = "rc=0" ]'
TR="$T/copilot-transcript.jsonl"
node -e 'const m="完成。\n\n```agent-receipt\ntask: "+process.argv[1]+"\nstatus: blocked\nsummary: 需要确认导出格式\nverify:\n  - bash scripts/agent/verify.sh: fail\nscope: ok\nrisks: 未完成\n```"; require("fs").writeFileSync(process.argv[2], JSON.stringify({type:"user",text:"做任务"})+"\n"+JSON.stringify({type:"assistant",text:m})+"\n")' "$ID2" "$TR"
printf '{"sessionId":"cp-1","cwd":"%s","transcriptPath":"%s","stopReason":"end_turn"}' "$WT2" "$TR" | bash scripts/agent/hub.sh report copilot agentStop
sleep 0.3
check "Copilot 回执从会话记录提取 → 需介入（blocked）" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID2 | jget o.status)" = "需介入" ]'
# Kiro：纯文本注入
R=$(printf '{"hook_event_name":"sessionStart","cwd":"%s","session_id":"kr-1"}' "$WT2" | bash scripts/agent/hub.sh report kiro SessionStart)
check "Kiro SessionStart 以纯文本输出任务单" 'printf "%s" "$R" | grep -q "^你正在执行 agent-hub 任务 $ID2"'
check "Kiro 会话开始把 需介入 拉回 执行中" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID2 | jget o.status)" = "执行中" ]'
R=$(printf '{"hook_event_name":"preToolUse","tool_name":"fs_write","tool_input":{"path":"db/migrations/9.sql"}}' | bash scripts/agent/guard.sh kiro 2>&1; echo "rc=$?")
check "Kiro fs_write 受保护路径 → 退出码 2" 'printf "%s" "$R" | grep -q "rc=2"'
check "拦截事件记入会话" '[ "$(api "$AGENT_HUB_URL/api/tasks/$ID2/activity" | jget "o.events.filter(e=>e.kind===\"deny\").length")" -ge 1 ] || { sleep 1; [ "$(api "$AGENT_HUB_URL/api/tasks/$ID2/activity" | jget "o.events.filter(e=>e.kind===\"deny\").length")" -ge 1 ]; }'
# hub 不可达时静默
R=$(printf '{"session_id":"x"}' | AGENT_HUB_URL=http://127.0.0.1:9 bash scripts/agent/hub.sh report claude-code SessionStart; echo "rc=$?")
check "hub 不可达：静默且退出码 0" '[ "$R" = "rc=0" ]'
R=$(printf '{"session_id":"x"}' | AGENT_HUB_URL= AGENT_HUB_CONFIG=/nonexistent bash scripts/agent/hub.sh report claude-code PostToolUse; echo "rc=$?")
check "未配置 hub：静默且退出码 0" '[ "$R" = "rc=0" ]'

echo "== 8. MCP 与 connect.mjs =="
cd "$ROOT"
node test/mcp.mjs "$AGENT_HUB_URL" "$HUB_TOKEN" "$ID2" > "$T/mcp.log" 2>&1; rc=$?
check "MCP：列工具 / today / get_task / submit_receipt / move_task" '[ $rc -eq 0 ]'; [ $rc -eq 0 ] || cat "$T/mcp.log"
FH="$T/home"; mkdir -p "$FH/.codex" "$FH/.cursor" "$FH/.kiro" "$FH/.copilot"
printf 'model = "gpt-5.5"\n\n[mcp_servers.agent-hub]\nurl = "http://old"\n\n[profiles.x]\nmodel = "o4"\n' > "$FH/.codex/config.toml"
curl -s "$AGENT_HUB_URL/connect.mjs" -o "$T/connect.mjs"
HOME="$FH" node "$T/connect.mjs" --url "$AGENT_HUB_URL" --token "$HUB_TOKEN" --agents codex,cursor,kiro,copilot > "$T/connect.log" 2>&1; rc=$?
check "connect.mjs 执行成功" '[ $rc -eq 0 ]'; [ $rc -eq 0 ] || cat "$T/connect.log"
check "写入 ~/.config/agent-hub/env（600）" '[ "$(stat -c %a "$FH/.config/agent-hub/env")" = "600" ]'
check "Codex config.toml 替换旧的 agent-hub 段并保留其他配置" '[ "$(grep -c "mcp_servers.agent-hub" "$FH/.codex/config.toml")" = "1" ] && grep -q "profiles.x" "$FH/.codex/config.toml" && grep -q "otlp-http" "$FH/.codex/config.toml" && ! grep -q "http://old" "$FH/.codex/config.toml"'
check "Cursor / Kiro / Copilot CLI 的 mcp.json 已写入" 'grep -q "agent=cursor" "$FH/.cursor/mcp.json" && grep -q "agent=kiro" "$FH/.kiro/settings/mcp.json" && grep -q "\"type\": \"http\"" "$FH/.copilot/mcp-config.json"'
check "改动前做了备份" 'ls "$FH/.codex/" | grep -q "bak-agent-hub"'
env -u AGENT_HUB_CONFIG HOME="$FH" AGENT_HUB_URL= AGENT_HUB_TOKEN= bash "$REPO/scripts/agent/hub.sh" ping > "$T/ping.log" 2>&1
check "hub.sh 能从 ~/.config/agent-hub/env 读取配置" 'grep -q "已连接" "$T/ping.log"'

echo
echo "通过 $pass 项，失败 $fail 项"
[ $fail -eq 0 ]
