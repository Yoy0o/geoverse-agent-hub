(function () {
  'use strict';
  window.createResultsUI = function ({ request, changed, toast, showText, getTasks, openDelivery, linked, connected }) {
    const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const sourceUrl = row => '/api/tasks/' + encodeURIComponent(row.taskId) + '/delivery/' + encodeURIComponent(row.deliveryId);
    const targetUrl = id => '/api/tasks/' + encodeURIComponent(id);
    let filters = { q:'', project:'', scope:'accepted' }, data = null, loading = false, error = '', sequence = 0, dirty = false, stale = false, draft = null, writing = false;
    const option = (value, label, selected) => '<option value="'+esc(value)+'"'+(value===selected?' selected':'')+'>'+esc(label)+'</option>';
    async function search(offset = 0) {
      const seq = ++sequence, query = { ...filters, offset:String(offset), limit:'20' }; loading = true; error = ''; changed();
      try {
        const result = await request('GET', '/api/deliveries?' + new URLSearchParams(query));
        if (seq === sequence) { data = result; dirty = Object.keys(filters).some(k => filters[k] !== query[k]); stale = false; }
      } catch(e) { if(seq===sequence) error=e.message || '无法读取成果'; }
      finally { if(seq===sequence) { loading=false; changed(); } }
    }
    async function loadReference(d) {
      const seq = d.sourceSeq = (d.sourceSeq || 0) + 1;
      d.loading = true; d.error = ''; d.view = null; changed();
      try { const v = await request('GET', sourceUrl(d.row)); if(draft===d && d.sourceSeq===seq) d.view=v; }
      catch(e) { if(draft===d && d.sourceSeq===seq) d.error=e.message; }
      finally { if(draft===d && d.sourceSeq===seq) { d.loading=false; changed(); } }
    }
    async function loadTarget(d, id) {
      const seq = d.targetSeq = (d.targetSeq || 0) + 1;
      d.targetId=id; d.target=null; d.error=''; changed(); if(!id) return;
      try { const v=await request('GET',targetUrl(id)+'/focus'); if(draft===d&&d.targetId===id&&d.targetSeq===seq) d.target=v; }
      catch(e) { if(draft===d&&d.targetId===id&&d.targetSeq===seq) d.error=e.message; }
      finally { if(draft===d) changed(); }
    }
    function reuseForm() {
      if(!draft) return '';
      const d=draft, v=d.view, selected=v?.selected, targets=getTasks().filter(t=>t.id!==d.row.taskId&&!['已合并','已放弃'].includes(t.status));
      return '<section class="panel" data-state-form><fieldset style="border:0;margin:0;padding:0;min-width:0"'+(writing?' disabled':'')+'><h3>引用具体成果版本</h3><p>'+esc(d.row.title)+' · '+esc(selected?.version||d.row.version)+'</p>'+
        (v?'<p class="hint">'+(v.accepted&&v.currentId===selected.id?'来源当前版本已验收。':'此来源不是当前已验收版本，请展开原任务核对适用范围。')+'引用只保存关联，不复制验收或启动执行。</p>':'<p class="hint">'+(d.loading?'正在核对来源…':'请重新读取来源。')+'</p>')+
        '<div class="form"><label class="f"><span>引用到哪个已有任务</span><select id="results-target">'+option('','请选择目标任务',d.targetId)+targets.map(t=>option(t.id,t.title+' · '+t.id,d.targetId)).join('')+'</select></label>'+
        (d.targetId&&!d.target?'<p class="hint">目标上下文尚未读取完成。</p>':'')+
        (d.target?.content.relations.some(r=>r.taskId===d.row.taskId)?'<p class="hint">目标已关联此来源任务；保存将替换为本次明确选择的版本和说明。</p>':'')+
        '<label class="f"><span>复用什么、有哪些适用限制</span><textarea id="results-note" maxlength="200" placeholder="例如：复用主次通道连接实验；跨楼层仍需重新验证">'+esc(d.note)+'</textarea></label></div>'+
        (d.error?'<p class="bad" role="alert">'+esc(d.error)+'；说明已保留。</p>':'')+
        '<div class="btns"><button class="btn pri" data-results-action="save"'+(!v||!d.target||!d.note.trim()||writing?' disabled':'')+'>保存版本引用</button><button class="btn" data-results-action="reload">重新读取并核对</button><button class="btn ghost" data-results-action="cancel">取消</button></div></fieldset></section>';
    }
    function view() {
      if(!connected()) return '<div class="panel"><h2>成果</h2><p>连接工作台后检索成果。</p></div>';
      if(!data&&!loading&&!error) search();
      const projects=[...new Set([...getTasks().map(t=>t.project),filters.project].filter(Boolean))].sort();
      const rows=data?.items||[];
      return '<section class="focus-home"><div><h2>查找可复用成果</h2><p class="hint">先看短结论，再打开对应版本。默认仅当前已验收成果；关键词匹配任务、结论、版本、文件和验收要求。</p></div>'+
        '<div class="form" data-state-form><label class="f"><span>关键词（空格分隔，需同时匹配）</span><input id="results-query" maxlength="200" value="'+esc(filters.q)+'" placeholder="例如：导航 断连，或提交号"></label><div class="row"><label class="f"><span>项目</span><select id="results-project">'+option('','全部项目',filters.project)+projects.map(p=>option(p,p,filters.project)).join('')+'</select></label><label class="f"><span>成果范围</span><select id="results-scope">'+[['accepted','当前已验收'],['current','全部当前版本'],['all','全部版本（含历史、归档）']].map(([k,l])=>option(k,l,filters.scope)).join('')+'</select></label></div><button class="btn pri" data-results-action="search"'+(loading?' disabled':'')+'>'+(loading?'读取中…':'查询 / 刷新')+'</button></div>'+
        (error?'<p class="bad" role="alert">'+esc(error)+'；保留上次结果，请重试。</p>':'')+(dirty?'<p class="hint">筛选已修改，请查询后查看新结果。</p>':'')+(stale?'<p class="hint">成果数据有更新，请刷新检索结果。</p>':'')+reuseForm()+
        (data?'<p class="small muted">共 '+data.total+' 版成果'+(rows.length?' · 当前显示 '+(data.offset+1)+'–'+(data.offset+rows.length):'')+'</p>':'')+
        rows.map(r=>'<article class="focus-card"><div class="focus-heading"><strong>'+esc(r.title)+'</strong><span class="pill">'+(r.accepted?'当前已验收':r.legacy?'旧回执':r.archivedReason&&!r.current?'归档':r.current?'当前待核对':'历史版本')+'</span></div><p class="focus-meta">'+esc(r.project||'未指定项目')+' · '+esc(r.version||'未标版本')+' · '+esc(r.at)+'</p><p>'+esc(r.summary)+'</p>'+(r.matchedOn.length?'<p class="hint">匹配：'+esc(r.matchedOn.join('、'))+'</p>':'')+'<div class="btns"><button class="btn sm" data-results-action="open" data-result-task="'+esc(r.taskId)+'" data-result-delivery="'+esc(r.deliveryId)+'">打开此版证据</button><button class="btn sm" data-results-action="context" data-result-task="'+esc(r.taskId)+'" data-result-delivery="'+esc(r.deliveryId)+'">复用摘要</button>'+(r.reusable?'<button class="btn sm" data-results-action="reuse" data-result-task="'+esc(r.taskId)+'" data-result-delivery="'+esc(r.deliveryId)+'">引用到任务</button>':'')+'</div></article>').join('')+
        (data&&!rows.length?'<div class="panel"><p>没有匹配成果。</p><p class="hint">可缩短关键词，或将成果范围改为全部版本。</p></div>':'')+
        (data?'<div class="btns"><button class="btn" data-results-action="previous"'+(!data.offset||dirty||loading?' disabled':'')+'>上一页</button><button class="btn" data-results-action="next"'+(data.nextOffset===null||dirty||loading?' disabled':'')+'>下一页</button></div>':'')+'</section>';
    }
    function capture(e) {
      const id=e.target.id;
      if(id==='results-query'||id==='results-project'||id==='results-scope') { filters[{ 'results-query':'q','results-project':'project','results-scope':'scope' }[id]]=e.target.value; dirty=true; changed(); }
      if(id==='results-note'&&draft) { draft.note=e.target.value; changed(); }
      if(e.type==='change'&&id==='results-target'&&draft&&!writing) loadTarget(draft,e.target.value);
    }
    document.addEventListener('input',capture); document.addEventListener('change',capture);
    document.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.id==='results-query') { e.preventDefault(); search(); } });
    document.addEventListener('click',async e=>{
      const el=e.target.closest('[data-results-action]'); if(!el||writing) return; e.preventDefault();
      const action=el.dataset.resultsAction, row=data?.items.find(r=>r.taskId===el.dataset.resultTask&&r.deliveryId===el.dataset.resultDelivery);
      if(action==='search') return search();
      if(action==='next'||action==='previous') return search(action==='next'?data.nextOffset:Math.max(0,data.offset-data.limit));
      if(action==='open'&&row) return openDelivery(row.taskId,row.deliveryId);
      if(action==='cancel') { draft=null; changed(); return; }
      if(action==='reuse'&&row) { draft={row,view:null,target:null,targetId:'',note:'',error:''}; await loadReference(draft); return; }
      if(action==='reload'&&draft) { const d=draft; await Promise.all([loadReference(d),loadTarget(d,d.targetId)]); return; }
      if(action==='context'&&row) {
        try { const v=await request('GET',sourceUrl(row)), r=v.selected; showText('复用参考', ['来源任务：'+row.taskId+' · '+row.title,'固定成果：'+r.id,'成果版本：'+(r.version||'未标明'),'结论：'+r.receipt.summary,'验证上报：',...(r.receipt.verify||[]).map(x=>x.cmd+'：'+x.result),'范围：'+(r.receipt.scope||'未说明'),'风险：'+(r.receipt.risks||'未说明'),'仅供复用参考，目标任务仍需独立验证和验收。'].join('\n'),row.taskId+'-reference.md'); } catch(e) { toast(e.message); } return;
      }
      if(action==='save'&&draft?.view&&draft.target&&draft.note.trim()) {
        const d=draft; writing=true; d.error=''; changed();
        try { await request('POST',targetUrl(d.targetId)+'/reuse',{ expectedFingerprint:d.target.fingerprint, sourceTaskId:d.row.taskId, deliveryId:d.row.deliveryId, expectedSourceFingerprint:d.view.expectedFingerprint, note:d.note.trim() }); if(draft===d) draft=null; linked(); toast('已保存固定版本引用，目标任务仍需独立验收'); }
        catch(e) { d.error=e.message; }
        finally { writing=false; changed(); }
      }
    });
    return { view, invalidate: () => { if(data) stale=true; } };
  };
})();
