#!/usr/bin/env bash
# 端到端测试：启动 hub → 建项目 → 生成接入包装进临时仓库 → task.sh 全流程 →
# 模拟 Claude Code / Codex / Cursor / Copilot / Kiro 的钩子载荷 → OTel → MCP → connect.mjs → 执行端派发 → 多端同步
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8791}
T=$(mktemp -d)
export HUB_DATA_DIR="$T/data" HUB_TOKEN=e2e-token PORT
export AGENT_HUB_URL="http://127.0.0.1:$PORT" AGENT_HUB_TOKEN=e2e-token AGENT_HUB_CONFIG="$T/none"
# 测试本身可能跑在云端会话或 CI 里：固定执行位置，云端识别单独测试
export AGENT_HUB_LOCATION=local AGENT_HUB_HOST=e2e-host AGENT_HUB_RUNNER_FILE="$T/runner.json"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
ko(){ echo "  ✗ $1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else ko "$1"; fi; }
api(){ curl -sS -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" "$@"; }
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }

node --disable-warning=ExperimentalWarning src/server.js > "$T/hub.log" 2>&1 &
HUBPID=$!
HUB2PID=""
# 调试：E2E_KEEP=1 保留临时目录（日志、仓库、数据库）
trap 'kill $HUBPID $HUB2PID 2>/dev/null; if [ -n "${E2E_KEEP:-}" ]; then echo "保留测试目录：$T"; else rm -rf "$T"; fi' EXIT
for i in $(seq 1 30); do curl -sf "$AGENT_HUB_URL/api/health" >/dev/null && break; sleep 0.2; done

echo "== 1. 启动与导入 =="
check "health" '[ "$(curl -s $AGENT_HUB_URL/api/health | jget o.ok)" = "true" ]'
check "未带令牌 401" '[ "$(curl -s -o /dev/null -w %{http_code} $AGENT_HUB_URL/api/tasks)" = "401" ]'
BK="$ROOT/test/fixtures/workbench.json"
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

echo "== 9. 执行管理：执行记录、进度、执行端 =="
cd "$REPO"
ID3=$(api -X POST -d '{"title":"执行端自动执行","project":"demo","allow":"src/**","acceptance":["写入 src/c.js","验证通过"]}' "$AGENT_HUB_URL/api/tasks" | jget o.id)
bash scripts/agent/task.sh start "$ID3" manual > /dev/null 2>&1
WT3="$T/demo-app.worktrees/$ID3"
check "task.sh start 生成执行记录（执行中 · 本机 · 主机名）" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID3 | jget "o.exec.status+\"/\"+o.exec.location+\"/\"+o.exec.host")" = "running/local/e2e-host" ]'
check "执行编号写入 .agent/run" '[ -s "$WT3/.agent/run" ]'
RUN3=$(cat "$WT3/.agent/run" 2>/dev/null)
(cd "$WT3" && printf '{"session_id":"s3","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/src/c.js"}}' "$WT3" "$WT3" | bash scripts/agent/hub.sh report claude-code PostToolUse)
sleep 0.5
check "钩子事件（带执行编号）更新步骤与心跳" '[ "$(api $AGENT_HUB_URL/api/runs/$RUN3 | jget "o.step+\"/\"+o.session")" = "修改代码/s3" ]'
(cd "$WT3" && bash scripts/agent/hub.sh progress 45 "实现导出接口" >/dev/null)
check "hub.sh progress → 任务执行摘要 45% · 步骤" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID3 | jget "o.exec.progress+\"/\"+o.exec.step")" = "45/实现导出接口" ]'
check "task.sh status 显示执行情况" 'bash scripts/agent/task.sh status "$ID3" | grep -q "执行中 · 本机 · e2e-host"'
curl -s "$AGENT_HUB_URL/runner.mjs" -o "$T/runner.mjs"
cat > "$T/fake-agent.sh" <<'FAKE'
#!/usr/bin/env bash
# 假的 Agent：汇报进度、改文件并提交、输出交付回执
id=$1
bash scripts/agent/hub.sh progress 60 "fake 实现中" >/dev/null
echo "c" > src/c.js && git add -A && git commit -qm "feat: c"
printf '完成。\n\n```agent-receipt\ntask: %s\nstatus: done\nsummary: 执行端自动执行完成\nchanged:\n  - src/c.js\nverify:\n  - bash scripts/agent/verify.sh: pass\nscope: ok\nrisks: 无\n```\n' "$id"
FAKE
printf '#!/usr/bin/env bash\necho "什么也没做"\n' > "$T/lazy-agent.sh"
node "$T/runner.mjs" register --name e2e-runner --project demo="$REPO" --agent-cmd fake='["bash","'"$T"'/fake-agent.sh","{task}"]' --agent-cmd lazy='["bash","'"$T"'/lazy-agent.sh"]' --exec > "$T/register.log" 2>&1; rc=$?
check "runner.mjs register 登记执行端" '[ $rc -eq 0 ] && grep -q "已登记执行端「e2e-runner」" "$T/register.log"'; [ $rc -eq 0 ] || cat "$T/register.log"
RID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id)' "$T/runner.json" 2>/dev/null)
check "工作台看到执行端在线（项目、Agent、自动执行）" '[ "$(api $AGENT_HUB_URL/api/runners | jget "(r=>r.online+\"/\"+r.projects+\"/\"+r.agents+\"/\"+r.mode)(o.find(r=>r.id===\"$RID\"))")" = "true/demo/fake,lazy/exec" ]'
check "已有进行中的执行时派发返回 409" '[ "$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" -d "{\"mode\":\"exec\",\"agent\":\"fake\"}" $AGENT_HUB_URL/api/tasks/$ID3/dispatch)" = "409" ]'
R=$(api -X POST -d '{"mode":"exec","agent":"fake","force":true}' "$AGENT_HUB_URL/api/tasks/$ID3/dispatch")
NRUN=$(printf '%s' "$R" | jget o.run.id)
check "派发（替换当前执行）→ 排队中，附带交给云端 Agent 的提示词" '[ "$(printf "%s" "$R" | jget o.run.status)" = "queued" ] && printf "%s" "$R" | jget o.prompt | grep -q "task.sh attach $ID3"'
check "原执行记录标记为已替代" '[ "$(api $AGENT_HUB_URL/api/runs/$RUN3 | jget o.status)" = "superseded" ]'
node "$T/runner.mjs" once > "$T/runner.log" 2>&1; rc=$?
check "runner.mjs once：领取 → 复用 worktree → 启动 Agent" '[ $rc -eq 0 ] && grep -q "已启动 fake" "$T/runner.log"'; [ $rc -eq 0 ] || cat "$T/runner.log"
check "Agent 输出的回执由执行端兜底回传 → 待评审" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID3 | jget "o.status+\"/\"+o.receipt.summary")" = "待评审/执行端自动执行完成" ]'
check "执行记录：已交付 · 本机 · 该执行端 · 退出码 0" '[ "$(api $AGENT_HUB_URL/api/runs/$NRUN | jget "[o.status,o.location,o.runner,o.exitCode,o.progress].join(\"/\")")" = "done/local/$RID/0/100" ]'
check "Agent 中途的进度汇报关联到同一执行" '[ "$(api "$AGENT_HUB_URL/api/tasks/$ID3/activity" | jget "o.events.some(e=>e.kind===\"progress\"&&e.summary.includes(\"fake 实现中\"))")" = "true" ]'
check "任务记录了 2 次执行尝试" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID3 | jget o.exec.attempts)" = "2" ]'
# 准备模式：只建工作区，人来启动 Agent
ID4=$(api -X POST -d '{"title":"准备模式","project":"demo","allow":"src/**"}' "$AGENT_HUB_URL/api/tasks" | jget o.id)
api -X POST -d '{"mode":"prepare"}' "$AGENT_HUB_URL/api/tasks/$ID4/dispatch" >/dev/null
node "$T/runner.mjs" once > "$T/runner2.log" 2>&1
WT4="$T/demo-app.worktrees/$ID4"
check "准备模式：执行端建好 worktree → 待启动" '[ -d "$WT4" ] && [ "$(api $AGENT_HUB_URL/api/tasks/$ID4 | jget "o.status+\"/\"+o.exec.status")" = "执行中/ready" ]'
R=$(cd "$WT4" && printf '{"session_id":"s4","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}' "$WT4" | bash scripts/agent/hub.sh report claude-code SessionStart)
check "在工作区启动 Agent（会话开始钩子）→ 执行中，仍是同一执行" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID4 | jget "o.exec.status+\"/\"+o.exec.attempts+\"/\"+o.exec.runner")" = "running/1/$RID" ]'
# 停滞：执行摘要超过阈值没有心跳 → 今日待办
api -X PATCH -d "{\"exec\":$(api $AGENT_HUB_URL/api/tasks/$ID4 | jget "Object.assign(o.exec,{heartbeatAt:new Date(Date.now()-3600e3).toISOString()})")}" "$AGENT_HUB_URL/api/docs/tasks/$ID4" >/dev/null
check "执行停滞进入待办（today attention）" 'node "$ROOT/test/mcp-call.mjs" "$AGENT_HUB_URL" "$HUB_TOKEN" today "{}" | grep -q "执行停滞"'
# 取消排队中的派发
ID5=$(api -X POST -d '{"title":"取消派发","project":"demo"}' "$AGENT_HUB_URL/api/tasks" | jget o.id)
R5=$(api -X POST -d "{\"mode\":\"exec\",\"agent\":\"fake\",\"runner\":\"$RID\"}" "$AGENT_HUB_URL/api/tasks/$ID5/dispatch" | jget o.run.id)
check "取消排队中的派发 → 已取消" '[ "$(api -X POST $AGENT_HUB_URL/api/runs/$R5/cancel | jget o.run.status)" = "cancelled" ]'
check "已取消的派发不会被领取" '[ "$(api -X POST $AGENT_HUB_URL/api/runners/$RID/claim | jget o.run)" = "null" ]'
# Agent 退出却没有回执 → 失败、需介入
api -X POST -d "{\"mode\":\"exec\",\"agent\":\"lazy\",\"runner\":\"$RID\"}" "$AGENT_HUB_URL/api/tasks/$ID5/dispatch" >/dev/null
node "$T/runner.mjs" once > "$T/runner3.log" 2>&1
check "Agent 退出但没有回执 → 执行失败、任务需介入" '[ "$(api $AGENT_HUB_URL/api/tasks/$ID5 | jget "o.status+\"/\"+o.exec.status+\"/\"+o.exec.note")" = "需介入/failed/Agent 已退出，但没有收到交付回执" ]'
# 云端会话：不建 worktree，直接 attach；位置自动识别为云端
ID6=$(api -X POST -d '{"title":"云端执行","project":"demo"}' "$AGENT_HUB_URL/api/tasks" | jget o.id)
R=$(api -X POST -d '{"mode":"handoff"}' "$AGENT_HUB_URL/api/tasks/$ID6/dispatch")
HRUN=$(printf '%s' "$R" | jget o.run.id)
check "交给云端 Agent：派发为等待接手（云端）" '[ "$(printf "%s" "$R" | jget "o.run.status+\"/\"+o.run.location+\"/\"+o.run.mode")" = "queued/cloud/handoff" ]'
check "交给云端 Agent 的派发不会被执行端领取" '[ "$(api -X POST $AGENT_HUB_URL/api/runners/$RID/claim | jget o.run)" = "null" ]'
git clone -q "$REPO" "$T/cloud-clone" && cd "$T/cloud-clone" && git checkout -q -b claude/cloud-session
env -u AGENT_HUB_LOCATION -u AGENT_HUB_HOST CLAUDE_CODE_REMOTE=true bash scripts/agent/task.sh attach "$ID6" > "$T/attach.log" 2>&1; rc=$?
check "task.sh attach（云端会话）接手同一执行 → 执行中 · 云端" '[ $rc -eq 0 ] && [ "$(api $AGENT_HUB_URL/api/tasks/$ID6 | jget "[o.status,o.exec.run,o.exec.status,o.exec.location,o.exec.host].join(\"/\")")" = "执行中/$HRUN/running/cloud/Claude Code 云端" ]'; [ $rc -eq 0 ] || cat "$T/attach.log"
check "attach 写入任务单与 .agent/task" '[ -f specs/$ID6.md ] && [ "$(cat .agent/task)" = "$ID6" ]'
printf '{"session_id":"c6","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/src/d.js"}}' "$T/cloud-clone" "$T/cloud-clone" | env -u AGENT_HUB_LOCATION CLAUDE_CODE_REMOTE=true bash scripts/agent/hub.sh report claude-code PostToolUse
sleep 0.5
check "云端会话的钩子事件按 .agent/task 关联任务" '[ "$(api $AGENT_HUB_URL/api/runs/$HRUN | jget "o.step+\"/\"+o.session")" = "修改代码/c6" ]'
check "合并任务后进行中的执行自动收尾" '[ "$(api -X POST -d "{\"action\":\"drop\",\"dropReason\":\"需求取消\"}" $AGENT_HUB_URL/api/tasks/$ID6/review >/dev/null; api $AGENT_HUB_URL/api/runs/$HRUN | jget o.status)" = "cancelled" ]'
cd "$ROOT"
check "执行总览接口（执行端 + 进行中 + 最近结束）" '[ "$(api $AGENT_HUB_URL/api/exec | jget "o.runners.length>=1&&o.active.length>=1&&o.recent.length>=3")" = "true" ]'

echo "== 10. 多端同步（本地 Hub ↔ 另一个 Hub）=="
PORT2=$((PORT+1))
HUB_DATA_DIR="$T/data2" HUB_TOKEN=e2e-token-2 PORT=$PORT2 HUB_NAME="e2e 本地" HUB_SYNC_URL="$AGENT_HUB_URL" HUB_SYNC_TOKEN=e2e-token HUB_SYNC_INTERVAL=0 \
  node --disable-warning=ExperimentalWarning src/server.js > "$T/hub2.log" 2>&1 &
HUB2PID=$!
H2="http://127.0.0.1:$PORT2"
for i in $(seq 1 30); do curl -sf "$H2/api/health" >/dev/null && break; sleep 0.2; done
api2(){ curl -sS -H "Authorization: Bearer e2e-token-2" -H "Content-Type: application/json" "$@"; }
N1=$(api "$AGENT_HUB_URL/api/tasks" | jget o.length)
check "预览同步：不写入，列出要拉取的数量" '[ "$(api2 -X POST -d "{\"dryRun\":true}" $H2/api/sync/run | jget "o.pull>=$N1&&o.dryRun")" = "true" ] && [ "$(api2 $H2/api/tasks | jget "o.filter(t=>t.id===\"$ID3\").length")" = "0" ]'
S=$(api2 -X POST -d '{}' "$H2/api/sync/run")
check "首次同步：拉取对端全部任务" '[ "$(api2 $H2/api/tasks | jget o.length)" -ge "$N1" ] && [ "$(api2 $H2/api/tasks/$ID3 | jget o.receipt.summary)" = "执行端自动执行完成" ]'
check "设置也同步过来（项目 demo）" '[ "$(api2 $H2/api/docs/config/main | jget "o.data.projects.some(p=>p.name===\"demo\")")" = "true" ]'
check "执行摘要随任务同步（对端看得到进度与位置）" '[ "$(api2 $H2/api/tasks/$ID3 | jget "o.exec.status+\"/\"+o.exec.location")" = "done/local" ]'
check "再同步一次没有重复传输" '[ "$(api2 -X POST -d "{}" $H2/api/sync/run | jget "o.pulled+o.pushed")" = "0" ]'
L1=$(api2 -X POST -d '{"title":"在本地 Hub 新建","project":"demo"}' "$H2/api/tasks" | jget o.id)
api2 -X POST -d '{}' "$H2/api/sync/run" >/dev/null
check "本地新建的任务推送到对端" '[ "$(api $AGENT_HUB_URL/api/tasks/$L1 | jget o.title)" = "在本地 Hub 新建" ]'
# 冲突：两端同时修改同一任务
api -X PATCH -d '{"goal":"对端改的目标"}' "$AGENT_HUB_URL/api/docs/tasks/$L1" >/dev/null
sleep 0.05
api2 -X POST -d '{"to":"需介入"}' "$H2/api/tasks/$L1/transition" >/dev/null
S=$(api2 -X POST -d '{}' "$H2/api/sync/run")
check "两端都改过：合并并记录冲突" '[ "$(printf "%s" "$S" | jget o.conflicts)" = "1" ] && [ "$(api2 $H2/api/sync/status | jget "o.conflictLog[0].id")" = "$L1" ]'
check "合并结果两端一致：状态取最后一次流转，状态历史不丢" '[ "$(api $AGENT_HUB_URL/api/tasks/$L1 | jget "o.status+\"/\"+o.history.length")" = "需介入/2" ] && [ "$(api2 $H2/api/tasks/$L1 | jget "o.status+\"/\"+o.history.length")" = "需介入/2" ]'
api -X DELETE "$AGENT_HUB_URL/api/docs/tasks/$L1" >/dev/null
api2 -X POST -d '{}' "$H2/api/sync/run" >/dev/null
check "对端删除同步到本端" '[ "$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer e2e-token-2" $H2/api/tasks/$L1)" = "404" ]'
check "同步状态：对端名称、最近成功时间" '[ "$(api2 $H2/api/sync/status | jget "!!o.lastOk&&o.peer.kind===\"local\"&&o.configured")" = "true" ]'
check "能力接口返回 Hub 身份（名称 / 类型）" '[ "$(api2 $H2/api/capabilities | jget "o.hub.name+\"/\"+o.hub.kind")" = "e2e 本地/local" ]'
HUB_DATA_DIR="$T/data3" HUB_SYNC_URL="$AGENT_HUB_URL" HUB_SYNC_TOKEN=wrong node --disable-warning=ExperimentalWarning src/cli.js sync > "$T/sync-wrong.log" 2>&1
check "错误的对端令牌给出明确提示" 'grep -q "对端拒绝了令牌" "$T/sync-wrong.log"'; grep -q "对端拒绝了令牌" "$T/sync-wrong.log" || cat "$T/sync-wrong.log"

echo
echo "通过 $pass 项，失败 $fail 项"
[ $fail -eq 0 ]
