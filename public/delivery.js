(function () {
  'use strict';
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = (items, cls = '') => items.length ? '<ul class="small '+cls+'">'+items.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>' : '';
  window.renderDelivery = function (v) {
    if (!v?.selected) return '<p class="hint">尚无交付版本。提交回执后，这里显示本次变化和验收依据。</p>';
    const r=v.selected, diff=v.difference, historical=r.id!==v.currentId;
    let h='<div class="row"><label class="f"><span>成果版本</span><select id="delivery-choice">'+v.versions.map(x=>'<option value="'+esc(x.id)+'"'+(x.id===r.id?' selected':'')+'>第 '+x.number+' 版 · '+esc(x.version||'未标明成果版本')+(x.current?' · 当前':x.archivedReason?' · 归档':'')+'</option>').join('')+'</select></label></div>';
    h+='<p class="small"><span class="pill">'+(historical?'历史版本':v.accepted?'本版已验收':'本版待核对')+'</span> '+esc(r.by)+' · '+esc(r.at)+'</p><p>'+esc(r.receipt.summary)+'</p>';
    if(historical) h+='<p class="hint">正在查看历史版本，验收操作始终针对重新读取的当前成果。</p>';
    if(r.archivedReason) h+='<p class="hint">原归档原因：'+esc(r.archivedReason)+'。'+(historical?'该回执未自动覆盖当前工作。':'此版由用户明确选为当前成果。')+'</p>';
    if(!historical&&v.archivedCount) h+='<p class="hint">另有 '+v.archivedCount+' 版归档成果，可在版本列表查看。</p>';
    if(historical&&!r.legacy&&['待执行','待评审'].includes(v.status)&&!v.requirementsChanged) h+='<button class="btn sm" data-act="delivery-select" data-revision="'+esc(r.id)+'">采用此版作为当前成果</button>';
    if(diff&&!diff.first) h+='<details class="more" id="delivery-diff"><summary>相对上一版：改动清单新增 '+diff.addedFiles.length+'、移除 '+diff.removedFiles.length+' 项，验证变化 '+diff.verification.length+' 项</summary>'+
      (diff.summary?'<p class="small">上版结论：'+esc(diff.summary.before)+'</p>':'')+list(diff.addedFiles.map(x=>'新增文件记录：'+x).concat(diff.removedFiles.map(x=>'移除文件记录：'+x),diff.verification.map(x=>x.cmd+'：'+x.before+' → '+x.after)))+
      (diff.requirementsChanged?'<p class="bad small">需求或验收范围与上一版不同。</p>':'')+'<p class="hint">比较的是交付声明；实际代码变化请打开对应提交或 PR。</p></details>';
    if(!historical){ h+=list(v.blockers,'bad')+list(v.warnings,'muted'); }
    h+='<details class="more" id="delivery-evidence"><summary>查看这版验证与范围</summary>'+list((r.receipt.verify||[]).map(x=>x.cmd+'：'+x.result))+
      (v.check?'<p class="small">绑定的机器检查：'+(v.check.ok?'通过':'未通过')+' · '+esc(v.check.at)+'</p>'+list((v.check.verify||[]).map(x=>x.cmd+'：'+x.result))+list(v.check.outOfScope||[],'bad'):'<p class="hint">没有绑定这版成果的机器检查。</p>')+
      list((r.receipt.changed||[]).map(x=>'改动：'+x))+'<p class="small">范围：'+esc(r.receipt.scope||'未说明')+'；风险：'+esc(r.receipt.risks||'未说明')+'</p>'+
      list((r.requirements?.acceptance||[]).map(x=>'交付时的验收标准：'+x))+'</details>';
    if(v.reviews.length) h+='<details class="more" id="delivery-reviews"><summary>本版评审记录 '+v.reviews.length+' 条</summary>'+v.reviews.map(x=>'<p class="small">'+esc(x.at)+' · '+esc(x.by)+' · '+(x.action==='merge'?'验收通过':'退回修改')+'<br>'+esc(x.note)+'</p>').join('')+'</details>';
    return h;
  };
})();
