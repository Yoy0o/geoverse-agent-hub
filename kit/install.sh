#!/usr/bin/env bash
# 把接入包装进本地项目：bash install.sh <项目根目录>
# 已存在且内容不同的 AGENTS.md / CLAUDE.md / 各 Agent 配置不会被覆盖，新版本另存为 *.agent-kit.new；
# scripts/agent 与 .githooks 下的脚本会更新，旧版本备份为 *.bak。
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd); DST=${1:-}
if [ -z "$DST" ] || [ ! -d "$DST" ]; then echo "用法：bash install.sh <项目根目录>" >&2; exit 1; fi
if ! git -C "$DST" rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "$DST 不是 Git 仓库，请先在该目录运行：git init" >&2; exit 1; fi
DST=$(git -C "$DST" rev-parse --show-toplevel)
cd "$SRC"
while IFS= read -r f; do
  f=${f#./}
  case "$f" in install.sh|AGENT-KIT.md) continue ;; esac
  mkdir -p "$DST/$(dirname "$f")"
  if [ ! -e "$DST/$f" ]; then cp "$f" "$DST/$f"; echo "新增  $f"
  elif cmp -s "$f" "$DST/$f"; then echo "相同  $f"
  else case "$f" in
      scripts/agent/*|.githooks/*) cp "$DST/$f" "$DST/$f.bak"; cp "$f" "$DST/$f"; echo "更新  $f（旧版本 $f.bak）" ;;
      *) cp "$f" "$DST/$f.agent-kit.new"; echo "保留  $f（新版本另存为 $f.agent-kit.new，请手动合并）" ;;
    esac
  fi
done < <(find . -type f | sort)
chmod +x "$DST"/scripts/agent/*.sh "$DST"/.githooks/*
git -C "$DST" config core.hooksPath .githooks
if [ -f "$DST/.gitignore" ]; then grep -qxF '.agent/' "$DST/.gitignore" || printf '\n.agent/\n' >> "$DST/.gitignore"; else printf '.agent/\n' > "$DST/.gitignore"; fi
echo; echo "已启用 git 钩子（core.hooksPath=.githooks）。检查 agent-hub 连接："
if ( cd "$DST" && bash scripts/agent/hub.sh ping ); then :; else echo "  还没连接 agent-hub：先在本机运行一次 connect.mjs（见 AGENT-KIT.md），任务流和上报才会生效。"; fi
echo; echo "运行一次统一验证："
if ( cd "$DST" && bash scripts/agent/verify.sh ); then echo "统一验证通过。"
else echo "统一验证未通过：先修正 scripts/agent/verify.sh 里的命令（或在工作台改项目档案后重新下载）。"; fi
echo; echo "确认无误后提交（worktree 从主分支创建，钩子和脚本必须先提交才会在任务目录里生效）："
echo "  cd \"$DST\" && git add AGENTS.md CLAUDE.md .gitignore .claude .codex .cursor .github/hooks .kiro .gemini .githooks scripts/agent specs && git commit -m \"chore: 接入 agent-hub\""
echo
echo "各 Agent 的额外一步："
echo "  Codex：在该项目里首次运行时选择信任项目，.codex/hooks.json 才会加载"
echo "  Kiro：打开项目后在 Agent Hooks 面板确认 agent-hub 的钩子已启用"
echo "  Cursor / Copilot CLI：钩子随仓库生效，无需额外操作"
