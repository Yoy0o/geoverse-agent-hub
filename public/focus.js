// Progressive disclosure for the existing task workbench. No model calls or automatic acknowledgement.
(function () {
  "use strict";
  window.createFocusUI = function ({ request, changed, toast, showText, getTasks, currentTask, relevant, connected }) {
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const url = (id) => "/api/tasks/" + encodeURIComponent(id) + "/focus";
    const safeUrl = (s) => { try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : ""; } catch { return ""; } };
    let data = null, cache = new Map(), dirty = true, pending = null, timer = null, error = "", editor = null, revision = null, busy = false;
    function invalidate() {
      dirty = true;
      if (!timer && connected() && relevant() && !document.hidden) timer = setTimeout(() => { timer = null; refresh(); }, 150);
    }
    async function refresh() {
      if (pending || !connected()) return pending;
      dirty = false;
      pending = (async () => {
        try {
          const result = await request("GET", "/api/focus");
          const next = new Map([...result.items, ...result.remaining, ...result.updates].map((v) => [v.id, v]));
          const id = currentTask();
          if (id && !next.has(id)) {
            try { next.set(id, await request("GET", url(id))); } catch (e) { if (e.status !== 404) throw e; }
          }
          data = result; cache = next; error = "";
        } catch (e) { error = e.message || "无法读取工作摘要"; }
        finally { pending = null; changed(); if (dirty) invalidate(); }
      })();
      return pending;
    }
    function button(action, label, v, surface, primary = false) {
      return '<button type="button" class="btn sm' + (primary ? ' pri' : '') + '" data-focus-action="' + action + '" data-focus-id="' + esc(v.id) + '" data-focus-surface="' + surface + '" data-focus-fingerprint="' + v.fingerprint + '"' + (busy ? ' disabled' : '') + '>' + label + '</button>';
    }
    const line = (label, value, cls = "") => value ? '<div class="focus-line ' + cls + '"><span class="focus-label">' + label + '</span><div>' + esc(value) + '</div></div>' : '';
    function describe(field, value) {
      if (value == null) return "尚未记录";
      if (typeof value === "string") return value || "已清除";
      if (field === "relations") return value.map((r) => `${r.label} ${r.title}（${r.taskId} · ${r.status}）：${r.note}`).join("\n") || "无关联";
      if (field === "evidence") return value.map((e) => `${e.label} ${e.url}${e.version ? " @ " + e.version : ""}`).join("\n") || "无链接";
      if (field === "delivery") return [value.summary, value.version && "提交：" + value.version, value.pr, ...(value.changed || []), ...(value.verify || []).map((v) => `${v.cmd}：${v.result}`)].filter(Boolean).join("\n") || "尚无回执";
      if (field === "checks") return [value.ok == null ? "尚未检查" : value.ok ? "上报检查通过" : "上报检查未通过", ...(value.verify || []).map((v) => `${v.cmd}：${v.result}`), ...(value.outOfScope || []).map((s) => "越界：" + s)].join("\n");
      if (field === "checkpoint") return ["暂停原因：" + value.reason, "当时结论：" + value.summary, "恢复第一步：" + value.nextAction, value.interruption ? "插单：" + value.interruption.title + " · " + value.interruption.status : "无插单"].join("\n");
      if (field === "requirements") return [value.goal, "允许：" + (value.allow || "未限定"), "禁止：" + (value.deny || "无额外限制"), ...(value.acceptance || []).map((a) => (a.done ? "已勾选：" : "待验证：") + a.text), "规格版本：" + value.specFingerprint.slice(0, 10)].join("\n");
      return "内容已更新";
    }
    function details(v, surface) {
      const s = v.snapshot;
      const changes = v.firstRead ? '<p class="hint">首次阅读：下面是当前工作状态；之后只比较你明确标记已读的版本。</p>' : v.changes.length ? v.changes.map((c) => '<div class="focus-diff"><h4>' + esc(c.label) + '</h4><div class="focus-before"><span class="focus-label">上次已读</span><pre>' + esc(describe(c.field, c.before)) + '</pre></div><div><span class="focus-label">当前</span><pre>' + esc(describe(c.field, c.after)) + '</pre></div></div>').join('') : '<p class="hint">相对上次已读，没有新增变化。</p>';
      return '<details class="more focus-details" id="focus-details-' + surface + '-' + esc(v.id) + '"><summary>变化、关联与依据</summary>' + changes +
        (s.relations.length ? '<h4>关联已有工作</h4><ul class="focus-relations">' + s.relations.map((r) => '<li><span class="pill">' + esc(r.label) + '</span> ' + (r.status === "missing" ? '<span class="bad">任务已不存在：' + esc(r.taskId) + '</span>' : '<button class="btn ghost sm" data-act="open" data-id="' + esc(r.taskId) + '">' + esc(r.title) + '</button> <span class="small muted">' + esc(r.status) + '</span>') + '<div>' + esc(r.note) + '</div></li>').join('') + '</ul>' : '') +
        (s.evidence.length ? '<h4>成果依据</h4><ul>' + s.evidence.map((e) => '<li>' + (safeUrl(e.url) ? '<a href="' + esc(safeUrl(e.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(e.label) + '</a>' : esc(e.label)) + (e.version ? ' · ' + esc(e.version) : '') + '</li>').join('') + '</ul>' : '') +
        '<h4>回执与检查</h4><pre class="focus-evidence">' + esc(describe('delivery', s.delivery) + '\n' + describe('checks', s.checks)) + '</pre><p class="hint">回执与链接为上报依据，按任务验收条件核查。</p>' +
        (v.resolution ? '<p class="hint">上次决定：' + (v.resolution.action === 'accept' ? '采纳建议' : '要求调整') + (v.resolution.note ? '；' + esc(v.resolution.note) : '') + (v.resolutionStale ? '（所依据的状态已变化）' : '') + '</p>' : '') + '</details>';
    }
    function editorHtml(v, surface) {
      if (!editor || editor.id !== v.id || editor.surface !== surface) return '';
      const p = editor.prefix, b = editor.content;
      const field = (key, label, max, value = b[key]) => '<label class="f"><span>' + label + '</span><textarea id="' + p + '-' + key + '" maxlength="' + max + '">' + esc(value || '') + '</textarea></label>';
      const taskOptions = (selected) => '<option value="">选择已有任务</option>' + getTasks().filter((t) => t.id !== v.id).map((t) => '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.title + ' · ' + t.id + ' · ' + t.status) + '</option>').join('');
      const relRows = Array.from({ length: editor.relationRows }, (_, i) => {
        const r = b.relations[i] || {};
        return '<div class="focus-edit-row"><label class="f"><span>已有任务</span><select id="' + p + '-rel-' + i + '-task">' + taskOptions(r.taskId) + '</select></label><label class="f"><span>关系</span><select id="' + p + '-rel-' + i + '-type">' + Object.entries({ reuses: '复用', extends: '补充', supersedes: '替代', impacts: '影响' }).map(([k, text]) => '<option value="' + k + '"' + (k === r.type ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label><label class="f"><span>具体关系</span><input id="' + p + '-rel-' + i + '-note" maxlength="200" value="' + esc(r.note || '') + '"></label></div>';
      }).join('');
      const evRows = Array.from({ length: editor.evidenceRows }, (_, i) => {
        const e = b.evidence[i] || {};
        return '<div class="focus-edit-row"><label class="f"><span>成果标题</span><input id="' + p + '-ev-' + i + '-label" maxlength="100" value="' + esc(e.label || '') + '"></label><label class="f"><span>链接</span><input type="url" id="' + p + '-ev-' + i + '-url" maxlength="2000" value="' + esc(e.url || '') + '"></label><label class="f"><span>版本（可选）</span><input id="' + p + '-ev-' + i + '-version" maxlength="100" value="' + esc(e.version || '') + '"></label></div>';
      }).join('');
      return '<section class="focus-editor"><h3>更新当前摘要</h3>' + (editor.fingerprint !== v.fingerprint ? '<p class="bad" role="alert">工作内容已有变化。草稿已保留；保存会进行版本检查。可取消后重新编辑。</p>' : '') + '<div class="form">' + field('summary', '当前结论', 280) + field('nextAction', '下一步', 200) + field('risk', '风险与未决项（没有可留空）', 280) +
        '<details class="more" id="' + p + '-decision-fields"><summary>需要用户决定时填写</summary>' + field('decision', '需要决定什么', 160) + field('recommendation', '推荐动作与理由', 200) + '</details>' +
        '<details class="more" id="' + p + '-relations"><summary>关联工作与成果依据</summary>' + relRows + (editor.relationRows < 12 ? button('add-relation', '增加关联', v, surface) : '') + evRows + (editor.evidenceRows < 12 ? button('add-evidence', '增加依据', v, surface) : '') + '</details>' +
        '<div class="btns">' + button('save', '保存摘要', v, surface, true) + button('cancel-edit', '取消', v, surface) + '</div></div></section>';
    }
    function card(v, surface = 'today') {
      const s = v.snapshot, hasMissing = s.relations.some((r) => r.status === 'missing');
      const risk = s.risk.length > 280 ? s.risk.slice(0, 279) + '…' : s.risk;
      const heading = surface === 'drawer' ? '<h3>当前工作摘要</h3>' : '<button class="focus-title" data-act="open" data-id="' + esc(v.id) + '">' + esc(v.title) + '</button>';
      return '<article class="focus-card' + (s.risk || hasMissing || ['需介入', '验证未通过'].includes(v.reason) ? ' focus-warning' : '') + '"><div class="focus-heading">' + heading + '<span class="pill">' + esc(v.needsDecision ? '待决策' : v.reason || s.status) + '</span></div>' +
        '<p class="focus-meta">' + esc(v.project || '未指定项目') + ' · ' + (v.unread ? v.firstRead ? '首次阅读' : '新增变化：' + esc(v.changes.map((c) => c.label).join('、')) : '没有未读变化') + '</p>' +
        line('当前结论', s.summary) + (v.needsDecision ? line('需要决定', s.decision) + line('推荐动作', s.recommendation) : line(s.status === '已暂停' ? '恢复第一步' : '下一步', s.nextAction)) +
        line('风险 / 未决', risk, 'bad') + (risk !== s.risk ? '<details class="more focus-details" id="focus-risk-' + surface + '-' + esc(v.id) + '"><summary>查看完整风险与未决项</summary><pre>' + esc(s.risk) + '</pre></details>' : '') + (v.reason === '验证未通过' ? '<p class="bad">存在未通过的验证或范围检查，展开依据查看。</p>' : '') + (hasMissing ? '<p class="bad">关联任务已不存在，请核对引用。</p>' : '') + (v.resolutionStale && s.decision ? '<p class="bad">先前决定的依据已变化，请重新核对。</p>' : '') +
        (v.decisionResolved ? '<p class="small ok">已采纳当前建议，任务仍按原流程验收。</p>' : '') +
        (v.resolution?.action === 'revise' ? line('调整要求', v.resolution.note) : '') + details(v, surface) +
        '<div class="btns focus-actions">' + (v.needsDecision && s.recommendation ? button('accept', '采纳建议', v, surface, true) : '') + (v.needsDecision ? button('revise', '要求调整', v, surface) : '') + (v.unread ? button('read', '标记已读', v, surface) : '') + button('context', '续接上下文', v, surface) + button('edit', '编辑摘要', v, surface) + '</div>' +
        (revision?.id === v.id && revision.surface === surface ? '<div class="form focus-editor"><label class="f"><span>需要怎样调整</span><textarea id="focus-revision-' + surface + '-' + esc(v.id) + '" maxlength="500"></textarea></label><div class="btns">' + button('submit-revision', '提交调整意见', v, surface, true) + button('cancel-revision', '取消', v, surface) + '</div></div>' : '') + editorHtml(v, surface) + '</article>';
    }
    function today() {
      if (!connected()) return '<div class="panel"><h2>今日推进</h2><p class="hint">连接工作台后读取当前状态。</p></div>';
      if (dirty && !pending && !timer && !error) invalidate();
      const message = error ? '<p class="bad" role="alert">' + esc(error) + '</p><button class="btn sm" data-focus-action="refresh">重试</button>' : '';
      if (!data) return '<div class="panel"><h2>今日推进</h2>' + message + (!error ? '<p class="hint">正在读取需要你处理的事项…</p>' : '') + '</div>';
      return '<section class="focus-home"><div class="focus-heading"><div><h2>需要我判断什么</h2><p class="hint">' + data.counts.attention + ' 项待处理 · ' + data.counts.updates + ' 项普通变化</p></div><button class="btn ghost sm" data-focus-action="refresh">刷新</button></div>' + message +
        (data.items.length ? data.items.map((v) => card(v)).join('') : '<div class="panel"><p>当前没有需要你判断的事项。</p><p class="hint">普通变化在下方展开，任务执行与评审保持原流程。</p></div>') +
        (data.remaining.length ? '<details class="more" id="focus-more-actions"><summary>其余 ' + data.remaining.length + ' 项待处理</summary>' + data.remaining.map((v) => card(v)).join('') + '</details>' : '') +
        (data.updates.length ? '<details class="more" id="focus-normal-updates"><summary>' + data.updates.length + ' 项普通变化</summary>' + data.updates.map((v) => card(v, 'updates')).join('') + '</details>' : '') +
        (!data.total ? '<p class="hint">先创建任务；已有任务会直接生成工作卡，无需迁移。</p>' : '') + '</section>';
    }
    function drawer(id) {
      const v = cache.get(id);
      if (!v) { if (!pending && !timer && !error) invalidate(); return '<div class="sec"><p class="hint">' + (error ? esc(error) : '正在读取工作摘要…') + '</p>' + (error ? '<button class="btn sm" data-focus-action="refresh">重试</button>' : '') + '</div>'; }
      return '<div class="sec">' + card(v, 'drawer') + '</div>';
    }
    function input(p, key) { return document.getElementById(p + '-' + key)?.value.trim() || ''; }
    function readEditor() {
      const b = {}, p = editor.prefix;
      ['summary', 'nextAction', 'decision', 'recommendation', 'risk'].forEach((k) => { b[k] = input(p, k); });
      b.relations = Array.from({ length: editor.relationRows }, (_, i) => ({ taskId: input(p, `rel-${i}-task`), type: input(p, `rel-${i}-type`), note: input(p, `rel-${i}-note`) })).filter((r) => r.taskId || r.note);
      b.evidence = Array.from({ length: editor.evidenceRows }, (_, i) => ({ label: input(p, `ev-${i}-label`), url: input(p, `ev-${i}-url`), version: input(p, `ev-${i}-version`) })).filter((e) => e.label || e.url || e.version);
      return b;
    }
    document.addEventListener('click', async (event) => {
      const el = event.target.closest('[data-focus-action]');
      if (!el || busy) return;
      event.preventDefault();
      const action = el.dataset.focusAction, id = el.dataset.focusId, surface = el.dataset.focusSurface;
      const expectedFingerprint = el.dataset.focusFingerprint, v = cache.get(id);
      if (action === 'refresh') { error = ''; dirty = true; await refresh(); return; }
      if (!v) { invalidate(); return; }
      if (action === 'edit') {
        editor = { id, surface, fingerprint: expectedFingerprint, prefix: 'focus-edit-' + surface + '-' + id + '-' + expectedFingerprint.slice(0, 10), content: structuredClone(v.content), relationRows: Math.min(12, v.content.relations.length + 1), evidenceRows: Math.min(12, v.content.evidence.length + 1) };
        changed(); return;
      }
      if (action === 'cancel-edit') { editor = null; changed(); return; }
      if (action === 'add-relation' && editor) { editor.relationRows = Math.min(12, editor.relationRows + 1); changed(); return; }
      if (action === 'add-evidence' && editor) { editor.evidenceRows = Math.min(12, editor.evidenceRows + 1); changed(); return; }
      if (action === 'revise') { revision = { id, surface, fingerprint: expectedFingerprint }; changed(); return; }
      if (action === 'cancel-revision') { revision = null; changed(); return; }
      busy = true; el.disabled = true;
      try {
        if (action === 'context') { const context = await request('GET', url(id) + '/context'); showText('续接上下文', context.brief, id + '-context.md'); }
        else if (action === 'read') { await request('POST', url(id) + '/read', { expectedFingerprint }); toast('已标记当前版本已读；未改变验收或决定'); }
        else if (action === 'accept') { await request('POST', url(id) + '/decision', { expectedFingerprint, action: 'accept' }); toast('已记录采纳；未执行或合并任务'); }
        else if (action === 'submit-revision' && revision) {
          const note = document.getElementById('focus-revision-' + surface + '-' + id)?.value.trim();
          await request('POST', url(id) + '/decision', { expectedFingerprint: revision.fingerprint, action: 'revise', note }); revision = null; toast('已记录调整要求');
        } else if (action === 'save' && editor) {
          await request('PUT', url(id), { expectedFingerprint: editor.fingerprint, content: readEditor() }); editor = null; toast('当前摘要已更新');
        }
        dirty = true;
      } catch (e) { toast(e.message || '操作失败'); if (e.status === 409) dirty = true; }
      finally { busy = false; el.disabled = false; if (dirty) await refresh(); changed(); }
    });
    return { today, drawer, invalidate };
  };
})();
