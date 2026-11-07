let cur = null, viewMode = 1, editActive = false, copyActive = false;
let hrows = {}, hcols = {}, edits = {}, selRows = {};
let sortKey = 'id', sortDir = 1;
let token       = sessionStorage.getItem('cg_token');
let currentUser = sessionStorage.getItem('cg_user');

const BASE_FIXED = [
  {k:'id',      l:'ID půjčky',         w:'90px'},
  {k:'product', l:'Produkt',            w:'80px'},
  {k:'status',  l:'Status',             w:'130px'},
  {k:'klient',  l:'ID klienta',         w:'70px'},
  {k:'origin',  l:'ID orig. půjčky',    w:'92px'},
  {k:'schval',  l:'Schváleno dne',      w:'84px'},
  {k:'splatn',  l:'Splatnost',          w:'78px'},
  {k:'vprodl',  l:'Ve prodlení (dny)',  w:'84px'},
  {k:'jistina', l:'Jistina',            w:'80px',  num:true},
  {k:'platba',      l:'Celkem zaplaceno',  w:'92px',  num:true},
  {k:'uhrJist',     l:'Úhrada jistiny',    w:'84px',  num:true},
  {k:'dluh',        l:'Celkový dluh',      w:'84px',  num:true, hideInExt:true},
];

const PAIRS = [
  {g:'Částka na prodloužení',          v:'castProd', u:'castProdU'},
  {g:'Náklady na půjčku',              v:'naklPujc', u:'naklPujcU'},
  {g:'Sml. pokuta 0,1% denně',         v:'smlPok',   u:'smlPokU'},
  {g:'Kompenz. sml. úrok 36% ročně',   v:'kompUrk',  u:'kompUrkU'},
  {g:'Placené upomínky',               v:'upomink',  u:'upominkU'},
  {g:'Adm. náklady — ink. agentura',   v:'inkasni',  u:'inkasniU'},
  {g:'Náklady na vymáhání prostř. IA', v:'vymah',    u:'vymahU'},
];

const TAIL = [{k:'dluh', l:'Celkový dluh', w:'84px', num:true}]; // shown at end in extended mode

function getBase() {
  const cols = [...BASE_FIXED];
  if (cur && cur.hasWriteoff) {
    cols.push({k:'writeoff', l:'Odepsáno', w:'80px', num:true, isWriteoff:true});
  }
  return cols;
}

// ── Auth ──────────────────────────────────────────────────
function checkAuth() {
  if (token) {
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('app').style.display = '';
    document.getElementById('topbar-user').textContent = currentUser || '';
  } else {
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

async function doLogin() {
  const username = document.getElementById('l-user').value.trim();
  const password = document.getElementById('l-pass').value;
  const btn = document.getElementById('l-btn');
  const err = document.getElementById('l-err');
  if (!username || !password) { err.textContent = 'Vyplňte všechna pole'; return; }
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Přihlašování…';
  try {
    const res  = await fetch('/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username, password}),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || 'Chyba přihlášení'; return; }
    token = data.token; currentUser = data.username;
    currentRole = data.role; caps = data.caps || [];
    sessionStorage.setItem('cg_token', token);
    sessionStorage.setItem('cg_user',  currentUser);
    checkAuth();
    applyCaps();
  } catch { err.textContent = 'Chyba připojení k serveru'; }
  finally  { btn.disabled = false; btn.textContent = 'Přihlásit se'; }
}

function doLogout() {
  token = null; currentUser = null; cur = null;
  currentRole = null; caps = []; activeTab = null;
  document.getElementById('tabs').innerHTML = '';
  sessionStorage.removeItem('cg_token'); sessionStorage.removeItem('cg_user');
  document.getElementById('main').style.display = 'none';
  document.getElementById('emp').innerHTML = '<div class="empty-icon">🔍</div><div>Zadejte ID klienta a stiskněte Hledat</div>';
  document.getElementById('emp').style.display = '';
  checkAuth();
}

function handleUnauth() {
  sessionStorage.removeItem('cg_token'); sessionStorage.removeItem('cg_user');
  token = null; currentRole = null; caps = []; activeTab = null;
  document.getElementById('tabs').innerHTML = '';
  checkAuth();
}

document.getElementById('l-user').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('l-pass').focus(); });
document.getElementById('l-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

// ── Search ────────────────────────────────────────────────
async function hledat() {
  const id = document.getElementById('sid').value.trim();
  if (!id) return;
  const sl = document.getElementById('slabel'), sb = document.getElementById('sbtn');
  sl.innerHTML = '<span class="spinner"></span>'; sb.disabled = true;
  try {
    const res = await fetch(`/api/client/${encodeURIComponent(id)}`, {
      headers:{'Authorization':'Bearer '+token},
    });
    if (res.status===401) { handleUnauth(); return; }
    const data = await res.json();
    if (!res.ok) { showEmp('❌',`<span class="err">${esc(data.error||'Chyba při načítání dat')}</span>`); return; }
    if (!data.loans||data.loans.length===0) { showEmp('📭',`Klient ID <strong>${esc(id)}</strong> nenalezen nebo nemá žádné půjčky`); return; }
    cur = data; hrows={}; hcols={}; edits={}; selRows={}; editActive=false; copyActive=false;
    document.getElementById('emp').style.display  = 'none';
    document.getElementById('main').style.display = '';
    document.getElementById('clbl').innerHTML =
      `Klient <strong>#${esc(data.customerId)}</strong> · ${esc(data.meta.loanCount)} půjček · Jistina: <strong>${fmt(data.totalJistina)}</strong>`;
    setView(1);
  } catch { showEmp('⚠️','<span class="err">Chyba připojení k serveru</span>'); }
  finally  { sb.disabled=false; sl.textContent='Hledat'; }
}

function showEmp(icon,msg) {
  document.getElementById('emp').innerHTML=`<div class="empty-icon">${icon}</div><div>${msg}</div>`;
  document.getElementById('main').style.display='none';
  document.getElementById('emp').style.display='';
}

document.getElementById('sid').addEventListener('keydown', e => { if(e.key==='Enter') hledat(); });

// ── Mode & action control ─────────────────────────────────
function setView(v) {
  viewMode = v;
  document.getElementById('mb1').className = 'btn' + (v===1?' act':'');
  document.getElementById('mb2').className = 'btn' + (v===2?' act':'');
  updateActionBtns();
  render();
}

function togEdit() {
  editActive = !editActive;
  if (editActive) copyActive = false; // mutually exclusive
  updateActionBtns();
  render();
}

function togCopy() {
  copyActive = !copyActive;
  if (copyActive) editActive = false; // mutually exclusive
  if (!copyActive) selRows = {};
  updateActionBtns();
  render();
}

function togSaveMenu() {
  const m = document.getElementById('save-menu');
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
function closeSaveMenu() {
  document.getElementById('save-menu').style.display = 'none';
}
// Close save menu on outside click
document.addEventListener('click', e => {
  const wrap = document.querySelector('.save-wrap');
  if (wrap && !wrap.contains(e.target)) closeSaveMenu();
});

const U_KEYS = ['castProdU','naklPujcU','smlPokU','kompUrkU','upominkU','inkasniU','vymahU'];

function togAllUhrazeno() {
  const allHidden = U_KEYS.every(k => hcols[k]);
  U_KEYS.forEach(k => { hcols[k] = !allHidden; });
  updateActionBtns();
  render();
}

function updateActionBtns() {
  const eb = document.getElementById('edit-btn');
  const cb2 = document.getElementById('copy-mode-btn');
  const ub = document.getElementById('uhrazeno-btn');
  const bnr = document.getElementById('bnr');
  const bnrCopy = document.getElementById('bnr-copy');
  const legGray = document.getElementById('leg-gray');

  eb.className  = 'btn' + (editActive  ? ' edit-act' : '');
  cb2.className = 'btn' + (copyActive  ? ' copy-act' : '');
  bnr.style.display     = editActive  ? 'flex' : 'none';
  bnrCopy.style.display = copyActive  ? 'flex' : 'none';
  if(legGray) legGray.style.display = editActive ? 'flex' : 'none';

  if(ub) {
    const isExt = viewMode === 2;
    ub.style.display = isExt ? '' : 'none';
    const allHidden = U_KEYS.every(k => hcols[k]);
    ub.className = 'btn' + (allHidden ? ' edit-act' : '');
    const lbl = document.getElementById('uhrazeno-lbl');
    if(lbl) lbl.textContent = allHidden ? 'Zobrazit «Uhrazeno»' : 'Skrýt «Uhrazeno»';
  }
  updateCopyBtn();
}
function updateCopyBtn(){
  const n=Object.values(selRows).filter(Boolean).length;
  const el=document.getElementById('copy-btn-lbl');
  if(el) el.textContent='Kopírovat vybrané ('+n+')';
  const selBtn=document.getElementById('copy-sel-btn');
  if(selBtn) selBtn.style.display = n>0 ? 'inline-flex' : 'none';
}

function togSelRow(li){
  selRows[li]=!selRows[li];
  updateCopyBtn();
  render();
}


function copySelected(){
  if(!cur){ alert('Nejsou data.'); return; }
  const selected = Object.entries(selRows).filter(([,v])=>v).map(([k])=>Number(k));
  if(!selected.length){ alert('Nejsou vybrány žádné řádky.'); return; }
  // Pass selRows as row filter — getTableData picks only those rows, no totals row
  const data = getTableData(selRows);
  if(!data.length){ alert('Nejsou data.'); return; }
  const tsv = data.map(r=>r.map(cell=>{
    const s=String(cell);
    return (s.includes('\t')||s.includes('\n')||s.includes('"'))?'"'+s.replace(/"/g,'""')+'"':s;
  }).join('\t')).join('\n');
  const btn=document.getElementById('copy-btn-lbl');
  const orig=btn.textContent;
  try{
    if(navigator.clipboard&&window.isSecureContext){
      navigator.clipboard.writeText(tsv).then(()=>{ btn.textContent='✓ Zkopírováno!'; setTimeout(()=>{btn.textContent=orig;},2000); });
    } else {
      const ta=document.createElement('textarea');
      ta.value=tsv; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      btn.textContent='✓ Zkopírováno!'; setTimeout(()=>{btn.textContent=orig;},2000);
    }
  } catch(e){ alert('Chyba při kopírování: '+e.message); }
}

function expPDF(){ if(!cur) return; document.getElementById('pdf-modal').style.display='flex'; }
function closePdfModal(){ document.getElementById('pdf-modal').style.display='none'; }
function doPDF(v){
  closePdfModal();
  const prevEdit=editActive, prevCopy=copyActive, prevView=viewMode;
  editActive=false; copyActive=false;
  viewMode=v; updateActionBtns(); render();

  const isExt = v === 2;
  if(isExt){
    document.body.classList.add('print-ext');
    // Measure table vs page width and compute scale so it fits in one pass
    setTimeout(()=>{
      const tw = document.getElementById('twrap');
      const tableW = tw ? tw.scrollWidth : 0;
      // A4 landscape printable width at 96dpi ≈ 1040px (277mm - 10mm margins)
      const pageW = 1040;
      const scale = tableW > pageW ? Math.max(0.4, pageW / tableW) : 1;
      document.documentElement.style.setProperty('--print-scale', scale.toFixed(3));
      window.print();
      cleanup();
    }, 150);
  } else {
    document.body.classList.remove('print-ext');
    document.documentElement.style.removeProperty('--print-scale');
    setTimeout(()=>{ window.print(); cleanup(); }, 120);
  }

  function cleanup(){
    document.body.classList.remove('print-ext');
    document.documentElement.style.removeProperty('--print-scale');
    viewMode=prevView; editActive=prevEdit; copyActive=prevCopy;
    updateActionBtns(); render();
  }
}
function ek(li,k){return li+'__'+k;}
function gv(l,k,li){const e=ek(li,k);return edits[e]!==undefined?edits[e]:l[k];}
function togRow(li,show){hrows[li]=!show;render();}
function togCol(k,show){hcols[k]=!show;render();}
function editV(li,k,el){
  const raw=parseFloat(el.value.replace(/[^\d.,-]/g,'').replace(',','.'));
  if(!isNaN(raw)){edits[ek(li,k)]=raw;el.classList.add('mod');}
  render();
}
function resetAll(){if(!confirm('Obnovit všechna původní data?'))return;edits={};hrows={};hcols={};render();}
// ── Helpers ───────────────────────────────────────────────
window.addEventListener('beforeunload',e=>{if(Object.keys(edits).length>0){e.preventDefault();e.returnValue='';} });

function fmt(v){return Number(v).toLocaleString('cs-CZ')+' Kč';}
function jsArg(value){return esc(JSON.stringify(String(value)));}

// Strip time from datetime string: "2019-06-12 07:08:04" → "2019-06-12"
function fmtDate(v){if(!v||v==='—')return'—';return String(v).substring(0,10);}

function sbadge(status,prodan){
  if(prodan) return '<span class="badge b-sold">🏷 Schváleno — prodáno</span>';
  const s=(status||'').toLowerCase();
  if(s.includes('schval')||s.includes('schvál')||s==='approved') return `<span class="badge b-schv">✓ ${esc(status)}</span>`;
  if(s.includes('přihláš')||s.includes('nová')||s.includes('pending')||s.includes('new')) return `<span class="badge b-pril">○ ${esc(status)}</span>`;
  if(s.includes('splacen')||s.includes('paid')||s.includes('uhrazen')) return `<span class="badge b-payd">${esc(status)}</span>`;
  if(s.includes('zamítn')||s.includes('reject')) return `<span class="badge b-crl">${esc(status)}</span>`;
  return `<span class="badge b-oth">${esc(status||'—')}</span>`;
}
function pbadge(p){
  const s=(p||'').toLowerCase();
  if(s.includes('payday')) return '<span class="badge b-payd">Payday</span>';
  if(s.includes('credit')||s.includes('line')) return '<span class="badge b-crl">CreditLine</span>';
  return `<span class="badge b-oth">${esc(p||'—')}</span>`;
}
function cb(k,chk){return `<input type="checkbox" style="margin-right:4px" ${chk?'checked':''} data-action="toggle-column" data-key="${esc(k)}">`;}

// ── Sort ─────────────────────────────────────────────────
function sortBy(k){
  if(sortKey===k) sortDir*=-1;
  else { sortKey=k; sortDir=1; }
  render();
}

function sortedLoans(loans){
  const k=sortKey;
  return [...loans].sort((a,b)=>{
    let av=a[k], bv=b[k];
    // Date columns: compare as strings (ISO format sorts correctly)
    return (Number(av||0)-Number(bv||0))*sortDir;
  });
}

function togChain(originId, show) {
  const loans = cur.loans;
  loans.forEach((l, li) => {
    if (String(l.id) === String(originId) || String(l.origin) === String(originId)) {
      hrows[li] = !show;
    }
  });
  render();
}

// ── Render ────────────────────────────────────────────────
function render(){
  if(!cur) return;
  const loans=cur.loans, isExt=viewMode===2, isEdit=editActive, isCopy=copyActive;
  const BASE=getBase().filter(c=>!(isExt&&c.hideInExt));
  let html='<table><thead>';

  if(isExt){
    html+='<tr>';
    if(isEdit) html+='<th style="width:28px" rowspan="2"></th>';
    if(isCopy) html+='<th style="width:28px" rowspan="2" class="no-print"></th>';
    BASE.forEach(c=>{
      const off=hcols[c.k];
      let hCls = c.isWriteoff ? 'wo-hdr'+(off?' off':'') : c.isOverPay ? 'overpay-hdr'+(off?' off':'') : (off?'base-off ':' ')+(c.num?'num':'');
      const sortable=!isEdit&&c.k==='id';
      const sIcon=sortable?`<i class="sort-icon${sortKey===c.k?' act':''}">${sortKey===c.k?(sortDir===1?'↑':'↓'):'↕'}</i>`:'';
      html+=`<th class="${hCls.trim()}${sortable?' th-sort':''}" rowspan="2" style="min-width:${c.w}"${sortable?` data-action="sort" data-key="${esc(c.k)}"`:''}>`;
      html+=isEdit?`<div class="cbwrap">${cb(c.k,!off)}<span>${c.l}</span></div>`:`${c.l}${sIcon}`;
      html+='</th>';
    });
    PAIRS.forEach(p=>{
      const bo=hcols[p.v]&&hcols[p.u];
      html+=`<th class="grp${bo?' off':''}" colspan="2" style="min-width:140px">`;
      html+=isEdit?`<div style="display:flex;align-items:center;justify-content:center;gap:4px">${cb(p.v+'|'+p.u,!bo).replace('data-action="toggle-column"', 'data-action="toggle-column-group"')}<span>${p.g}</span></div>`:p.g;
      html+='</th>';
    });
    TAIL.forEach(c=>{
      const off=hcols[c.k];
      html+=`<th class="num${off?' base-off':''}" rowspan="2" style="min-width:${c.w}">`;
      html+=isEdit?`<div class="cbwrap">${cb(c.k,!off)}<span>${c.l}</span></div>`:c.l;
      html+='</th>';
    });
    html+='</tr><tr>';
    PAIRS.forEach(p=>{
      const ov=hcols[p.v],ou=hcols[p.u];
      html+=`<th class="sub-v${ov?' off':''}" style="min-width:70px">`;
      html+=isEdit?`<div class="cbwrap">${cb(p.v,!ov)}<span>Vystaveno</span></div>`:'Vystaveno';
      html+='</th>';
      html+=`<th class="sub-u${ou?' off':''}" style="min-width:70px">`;
      html+=isEdit?`<div class="cbwrap">${cb(p.u,!ou)}<span>Uhrazeno</span></div>`:'Uhrazeno';
      html+='</th>';
    });
    html+='</tr>';
  } else {
    html+='<tr>';
    if(isEdit) html+='<th style="width:28px"></th>';
    if(isCopy) html+='<th style="width:28px" rowspan="2" class="no-print"></th>';
    BASE.forEach(c=>{
      const off=hcols[c.k];
      let hCls = c.isWriteoff ? 'wo-hdr'+(off?' off':'') : c.isOverPay ? 'overpay-hdr'+(off?' off':'') : (off?'base-off ':' ')+(c.num?'num':'');
      const sortable2=!isEdit&&c.k==='id';
      const sIcon2=sortable2?`<i class="sort-icon${sortKey===c.k?' act':''}">${sortKey===c.k?(sortDir===1?'↑':'↓'):'↕'}</i>`:'';
      html+=`<th class="${hCls.trim()}${sortable2?' th-sort':''}" style="min-width:${c.w}"${sortable2?` data-action="sort" data-key="${esc(c.k)}"`:''}>`;
      html+=isEdit?`<div class="cbwrap">${cb(c.k,!off)}<span>${c.l}</span></div>`:`${c.l}${sIcon2}`;
      html+='</th>';
    });
    html+='</tr>';
  }
  html+='</thead><tbody>';

  // Totals accumulator
  const tots={};
  BASE.filter(c=>c.num).forEach(c=>{tots[c.k]=0;});
  PAIRS.forEach(p=>{tots[p.v]=0;tots[p.u]=0;});
  TAIL.forEach(c=>{tots[c.k]=0;});

  // Data rows — apply sort (totals row still uses original indices for hrows)
  const sortedIdx = sortedLoans(loans.map((l,i)=>({...l,__i:i}))).map(l=>l.__i);
  sortedIdx.forEach(li=>{
    const l=loans[li];
    const hidden=hrows[li];
    const isSel=selRows[li]||false;
    let rc='';
    if(hidden)          rc='row-hidden';
    else if(l.prodan)   rc='row-prodan';
    else if(l.vprodl>0) rc='row-prodl';
    else                rc=li%2===1?'row-even':'';
    if(isSel) rc+=' row-selected';

    const rowClick=isCopy?` data-action="toggle-selected-row" data-row="${li}" style="cursor:pointer"`:'';
    html+=`<tr class="${rc.trim()}"${rowClick}>`;
      if(isEdit){
  const hasExt = cur.loans.some(x => String(x.origin) === String(l.id));
  if(!l.origin && hasExt){
    const allShown = cur.loans
      .filter(x => String(x.id)===String(l.id) || String(x.origin)===String(l.id))
      .every((x,_,arr) => { const idx=cur.loans.indexOf(x); return !hrows[idx]; });
    html+=`<td style="text-align:center;padding:7px 4px;display:flex;gap:4px;align-items:center;justify-content:center">
      <input type="checkbox" title="Pouze tento" ${hidden?'':'checked'} data-action="toggle-row" data-row="${li}">
      <input type="checkbox" style="accent-color:var(--blue)" title="Celá řetězec" ${allShown?'checked':''} data-action="toggle-chain" data-origin="${esc(l.id)}">
    </td>`;
  } else {
    html+=`<td style="text-align:center;padding:7px 6px"><input type="checkbox" ${hidden?'':'checked'} data-action="toggle-row" data-row="${li}"></td>`;
  }
}
    if(isCopy) html+=`<td class="no-print" data-action="stop-row-click" style="text-align:center;padding:7px 6px"><input type="checkbox" class="copy-check" ${isSel?'checked':''} data-action="toggle-selected-row" data-row="${li}"></td>`;

    BASE.forEach(c=>{
      const off=hcols[c.k], cv=gv(l,c.k,li);
      let d='';
      if     (c.k==='status')  d=sbadge(l.status,l.prodan);
      else if(c.k==='product') d=pbadge(l.product);
      else if(c.k==='origin')  d=l.origin?`<span class="id-link">↩ ${esc(l.origin)}</span>`:'<span class="muted">—</span>';
      else if(c.k==='vprodl')  d=cv>0?`<span class="warn">${cv} dní</span>`:'<span class="muted">—</span>';
      else if(c.k==='schval'||c.k==='splatn') d=esc(fmtDate(cv)); // FIX: strip time
      else if(c.num) d=isEdit?`<input class="editable${edits[ek(li,c.k)]!==undefined?' mod':''}" type="text" value="${esc(cv)}" data-action="edit-value" data-row="${li}" data-key="${esc(c.k)}">`:fmt(cv);
      else d=(cv!==null&&cv!==undefined)?esc(cv):'<span class="muted">—</span>';

      let cellCls = c.isWriteoff ? (off?'col-off':'val-wo') : c.isOverPay ? (off?'col-off':'val-overpay') : (c.num?'num':'')+(off?' col-off':'');
      html+=`<td class="${cellCls.trim()}">${c.k==='id'?`<strong>${esc(l.id)}</strong>`:d}</td>`;
      // jistina: skip extension loans (origin != null) to avoid double-counting principal
      if(!hidden&&!off&&c.num) {
        // jistina + platba + uhrJist: duplicate in every extension — only count originals
        const originOnly=['jistina']; // only principal double-counts in extensions
        if(originOnly.includes(c.k) && l.origin) { /* skip */ }
        else tots[c.k]=(tots[c.k]||0)+Number(cv);
      }
    });

    if(isExt){
      PAIRS.forEach(p=>{
        const ov=hcols[p.v],ou=hcols[p.u],cv=gv(l,p.v,li),cu=gv(l,p.u,li);
        html+=`<td class="val-v${ov?' col-off':''}">`;
        html+=isEdit?`<input class="editable${edits[ek(li,p.v)]!==undefined?' mod':''}" type="text" value="${esc(cv)}" data-action="edit-value" data-row="${li}" data-key="${esc(p.v)}">`:fmt(cv);
        html+='</td>';
        html+=`<td class="val-u${ou?' col-off':''}">`;
        html+=isEdit?`<input class="editable${edits[ek(li,p.u)]!==undefined?' mod':''}" type="text" value="${esc(cu)}" data-action="edit-value" data-row="${li}" data-key="${esc(p.u)}">`:fmt(cu);
        html+='</td>';
        if(!hidden){
          // "Issued" (v) fields: naklPujc/smlPok/kompUrk/upomink/inkasni/vymah are
          // naklPujc (charge_10): skip for extensions (value repeated) AND for originals
          // whose chain is still open (fee not yet applied to a closed debt).
          // All other V fields: unique per loan, sum all rows.
          const skipV = p.v==='naklPujc' && (l.origin || l.chainOpen);
          if(!ov && !skipV) tots[p.v]=(tots[p.v]||0)+Number(cv);
          // "Paid" (u) fields: these come from _pokryto (already deduped per-credit on server).
          // They ARE unique per credit, so sum all rows.
          if(!ou) tots[p.u]=(tots[p.u]||0)+Number(cu);
        }
      });
      TAIL.forEach(c=>{
        const off=hcols[c.k],cv=gv(l,c.k,li);
        html+=`<td class="num${off?' col-off':''}" style="color:var(--red);font-weight:600">`;
        html+=isEdit?`<input class="editable${edits[ek(li,c.k)]!==undefined?' mod':''}" type="text" value="${esc(cv)}" data-action="edit-value" data-row="${li}" data-key="${esc(c.k)}">`:fmt(cv);
        html+='</td>';
        if(!hidden&&!off) tots[c.k]=(tots[c.k]||0)+Number(cv);
      });
    }
    html+='</tr>';
  });

  // ── Totals row ───────────────────────────────────────────
  
  html += '<tr class="tot-row">';
  if (isEdit) html += '<td></td>';
  if(isCopy) html += '<td></td>';

  let firstCell = true;
  BASE.forEach(c => {
    const off = hcols[c.k];
    
    // Keep cells empty for non-numeric columns and overdue days.
    if (!c.num || c.k === 'vprodl') {
      let cls = off ? ' class="col-off"' : '';
      html += '<td' + cls + '>' + (firstCell ? 'Celkem' : '') + '</td>';
      firstCell = false;
    } else {
      let cellCls = c.isWriteoff ? (off ? 'col-off' : 'val-wo') : c.isOverPay ? (off ? 'col-off' : 'val-overpay') : (off ? 'num col-off' : 'num');
      html += '<td class="' + cellCls + '">' + fmt(tots[c.k] || 0) + '</td>';
    }
  });

  if (isExt) {
    PAIRS.forEach(p => {
      html += '<td class="val-v' + (hcols[p.v] ? ' col-off' : '') + '" style="font-weight:600">' + fmt(tots[p.v] || 0) + '</td>';
      html += '<td class="val-u' + (hcols[p.u] ? ' col-off' : '') + '" style="font-weight:600">' + fmt(tots[p.u] || 0) + '</td>';
    });
    TAIL.forEach(c => {
      html += '<td class="num' + (hcols[c.k] ? ' col-off' : '') + '" style="color:var(--red);font-weight:600">' + fmt(tots[c.k] || 0) + '</td>';
    });
  }
  html += '</tr></tbody></table>';
  
  document.getElementById('twrap').innerHTML = html;
  // Sync sticky scrollbar width with real table width
  const tw=document.getElementById('twrap'), sm=document.getElementById('smirror'), si=document.getElementById('smirror-inner');
  if(tw&&sm&&si){
    si.style.width=tw.scrollWidth+'px';
    sm.style.display=tw.scrollWidth>tw.clientWidth?'block':'none';
    sm.addEventListener('scroll', () => { tw.scrollLeft=sm.scrollLeft; });
    tw.addEventListener('scroll', () => { sm.scrollLeft=tw.scrollLeft; });
  }
}

// ── Export helpers ─────────────────────────────────────────

// Shared helper: build cell value for a loan column
function cellVal(l, c, li) {
  const cv = gv(l, c.k, li);
  if      (c.k === 'status')  return l.prodan ? 'Schváleno — prodáno' : (l.status || '—');
  else if (c.k === 'product') return l.product || '—';
  else if (c.k === 'origin')  return l.origin != null ? String(l.origin) : '—';
  else if (c.k === 'vprodl')  return cv > 0 ? cv : 0;
  else if (c.k === 'schval' || c.k === 'splatn') return fmtDate(cv);
  else if (c.num) return Number(cv) || 0;
  return cv != null ? String(cv) : '—';
}

function getTableData(overrideRows) {
  if (!cur) return [];
  const loans = cur.loans;
  const isExt = viewMode === 2;

  // Respect hcols — only visible columns go into export
  const BASE = getBase().filter(c => !(isExt && c.hideInExt) && !hcols[c.k]);
  const visPairs = isExt ? PAIRS.map(p => ({
    ...p,
    showV: !hcols[p.v],
    showU: !hcols[p.u],
  })).filter(p => p.showV || p.showU) : [];
  const visTail = isExt ? TAIL.filter(c => !hcols[c.k]) : [];

  // Headers
  const headers = BASE.map(c => c.l);
  visPairs.forEach(p => {
    if (p.showV) headers.push(p.g + ' — Vystaveno');
    if (p.showU) headers.push(p.g + ' — Uhrazeno');
  });
  visTail.forEach(c => headers.push(c.l));

  const rows = [headers];

  // Totals
  const tots = {};
  BASE.filter(c => c.num).forEach(c => { tots[c.k] = 0; });
  visPairs.forEach(p => { tots[p.v] = 0; tots[p.u] = 0; });
  visTail.forEach(c => { tots[c.k] = 0; });

  const allIdx = sortedLoans(loans.map((l, i) => ({...l, __i: i}))).map(l => l.__i);
  const idxToUse = overrideRows
    ? allIdx.filter(li => overrideRows[li])   // copySelected: selected rows only
    : allIdx.filter(li => !hrows[li]);         // getTableData: skip hidden rows

  idxToUse.forEach(li => {
    const l = loans[li];
    const row = BASE.map(c => cellVal(l, c, li));

    // Totals for BASE
    BASE.forEach(c => {
      if (!c.num) return;
      const cv = gv(l, c.k, li);
      if (c.k === 'jistina' && l.origin) return; // no double-count
      tots[c.k] = (tots[c.k] || 0) + Number(cv);
    });

    // Extended PAIRS (visible only)
    visPairs.forEach(p => {
      const cv = gv(l, p.v, li), cu = gv(l, p.u, li);
      if (p.showV) {
        row.push(Number(cv) || 0);
        const skipV = p.v === 'naklPujc' && (l.origin || l.chainOpen);
        if (!skipV) tots[p.v] = (tots[p.v] || 0) + Number(cv);
      }
      if (p.showU) {
        row.push(Number(cu) || 0);
        tots[p.u] = (tots[p.u] || 0) + Number(cu);
      }
    });

    // Tail (visible only)
    visTail.forEach(c => {
      const cv = gv(l, c.k, li);
      row.push(Number(cv) || 0);
      tots[c.k] = (tots[c.k] || 0) + Number(cv);
    });

    rows.push(row);
  });

  // Totals row (skip for copySelected — no overrideRows)
  if (!overrideRows) {
    const totRow = BASE.map((c, i) =>
      (!c.num || c.k === 'vprodl') ? (i === 0 ? 'Celkem' : '') : (tots[c.k] || 0)
    );
    visPairs.forEach(p => {
      if (p.showV) totRow.push(tots[p.v] || 0);
      if (p.showU) totRow.push(tots[p.u] || 0);
    });
    visTail.forEach(c => totRow.push(tots[c.k] || 0));
    rows.push(totRow);
  }

  return rows;
}

function copyAll() {
  const data = getTableData();
  if (!data.length || !cur) { alert('Nejsou data k zkopírování.'); return; }
  const tsv = data.map(row =>
    row.map(cell => {
      const s = String(cell);
      return (s.includes('\t') || s.includes('\n') || s.includes('"'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join('\t')
  ).join('\n');
  const btn = document.getElementById('copy-all-btn');
  const origHTML = btn.innerHTML;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(tsv).then(() => {
        btn.textContent = '✓ Zkopírováno!';
        setTimeout(() => { btn.innerHTML = origHTML; }, 2000);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = tsv; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      btn.textContent = '✓ Zkopírováno!';
      setTimeout(() => { btn.innerHTML = origHTML; }, 2000);
    }
  } catch(e) { alert('Chyba při kopírování: ' + e.message); }
}

function downloadExcel() {
  const data = getTableData();
  if (!data.length || !cur) { alert('Nejsou data ke stažení.'); return; }

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Auto column widths based on header length
  ws['!cols'] = data[0].map((h, ci) => {
    const maxLen = Math.max(...data.map(r => String(r[ci] || '').length), String(h).length);
    return { wch: Math.min(maxLen + 2, 40) };
  });

  // Bold totals row (last row)
  const lastRow = data.length; // 1-indexed in xlsx
  data[0].forEach((_, ci) => {
    const cellRef = XLSX.utils.encode_cell({ r: lastRow - 1, c: ci });
    if (ws[cellRef]) {
      ws[cellRef].s = { font: { bold: true } };
    }
  });

  const wb = XLSX.utils.book_new();
  const modeName = viewMode === 2 ? 'rozsireny' : 'zakladni';
  XLSX.utils.book_append_sheet(wb, ws, 'Půjčky');
  XLSX.writeFile(wb, `client-loans-report-${cur.customerId}-${modeName}.xlsx`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Moduly a oprávnění
//
// Seznam schopností přichází z /auth/me. Frontend si vlastní tabulku rolí
// nedrží záměrně: dva zdroje pravdy se rozejdou, a rozejdou se směrem
// k přebývajícímu přístupu. Skrytá záložka navíc není ochrana — každý routa
// si oprávnění kontroluje sama.
// ══════════════════════════════════════════════════════════════════════════════

let caps = [];
let currentRole = null;
let activeTab = null;

const TABS = [
  { id: 'prehled',  cap: 'prehled',  label: 'Přehled půjček' },
  { id: 'odpis',    cap: 'writeoff', label: 'Odpis dluhu', wo: true },
  { id: 'uziv',     cap: 'users',    label: 'Uživatelé' },
];

function has(cap) { return caps.indexOf(cap) !== -1; }

function renderTabs() {
  const host = document.getElementById('tabs');
  const allowed = TABS.filter(t => has(t.cap));
  host.innerHTML = allowed.map(t =>
    `<button class="tab${t.wo ? ' tab-wo' : ''}${t.id === activeTab ? ' act' : ''}"
       id="tab-${t.id}" data-action="show-tab" data-tab="${esc(t.id)}">
       <span class="tdot"></span>${t.label}
       ${t.soon ? '<span class="chip">Připravuje se</span>' : ''}
     </button>`).join('');
  host.style.display = allowed.length > 1 ? '' : 'none';
}

function showTab(id) {
  if (!TABS.some(t => t.id === id && has(t.cap))) return;
  activeTab = id;
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('act'));
  const pane = document.getElementById('pane-' + id);
  if (pane) pane.classList.add('act');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('act'));
  const tab = document.getElementById('tab-' + id);
  if (tab) tab.classList.add('act');

  // Hledat v topbaru hledá klienta pro přehled — roli bez přehledu nepatří.
  document.getElementById('search-wrap').style.display = id === 'prehled' ? '' : 'none';

  if (id === 'uziv') uLoad();
}

function applyCaps() {
  document.getElementById('topbar-role').textContent = (currentRole || '').toUpperCase();
  document.getElementById('brand-sub').textContent = has('writeoff')
    ? 'Odpis zapisuje do CRM · přehled je pouze pro čtení'
    : 'Pouze čtení · data se neukládají do CRM';
  activeTab = (TABS.find(t => has(t.cap)) || {}).id || null;
  renderTabs();
  if (activeTab) showTab(activeTab);
}

// ── Formátování ───────────────────────────────────────────────────────────
// Server posílá u každé částky { minor, text }. Frontend peníze nepočítá:
// z minor jen formátuje, aby se v prohlížeči nemohla objevit jiná čísla
// než ta, se kterými pracoval modul.
function kcFmt(m) {
  if (!m) return '0,00';
  return (m.minor / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function woMsg(text, kind) {
  const el = document.getElementById('w-msg');
  if (!text) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = text;
  if (kind === 'err') {
    el.style.background = 'var(--red-l)'; el.style.color = 'var(--red)'; el.style.borderColor = '#F09595';
  } else if (kind === 'ok') {
    el.style.background = 'var(--green-l)'; el.style.color = 'var(--green)'; el.style.borderColor = '#97C459';
  } else {
    el.style.background = 'var(--amber-l)'; el.style.color = 'var(--amber)'; el.style.borderColor = 'var(--amber-m)';
  }
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({
    headers: Object.assign({ 'Authorization': 'Bearer ' + token }, (opts && opts.body) ? { 'Content-Type': 'application/json' } : {}),
  }, opts || {}));
  if (res.status === 401) { handleUnauth(); throw new Error('unauth'); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data: data };
}

// ── Odpis: stav ───────────────────────────────────────────────────────────
let woPlan = null;

function woReset() {
  woPlan = null;
  document.getElementById('w-result').style.display = 'none';
  document.getElementById('w-empty').style.display = '';
  woMsg('');
}

async function woLoadCredits() {
  const cust = document.getElementById('w-cust').value.trim();
  if (!/^\d+$/.test(cust)) { woMsg('Zadejte platné ID klienta.', 'err'); return; }
  const btn = document.getElementById('w-credits-btn');
  btn.disabled = true;
  woMsg('');
  try {
    const r = await api(`/api/writeoff/credits/${encodeURIComponent(cust)}`);
    if (!r.ok) { woMsg(esc(r.data && r.data.error || 'Chyba při načítání půjček'), 'err'); return; }
    const row = document.getElementById('w-chips-row');
    if (!r.data.credits.length) {
      document.getElementById('w-chips').style.display = '';
      row.innerHTML = '<span style="font-size:11px;color:var(--gray)">Klient nemá žádnou půjčku s dluhem.</span>';
      return;
    }
    row.innerHTML = r.data.credits.map(c =>
    `<button class="wchip" data-action="wo-pick-credit" data-credit-id="${esc(c.creditId)}">
         <b>${esc(c.creditId)}</b><span>${kcFmt(c.debt)} Kč</span>
       </button>`).join('');
    document.getElementById('w-chips').style.display = '';
  } catch (e) { if (e.message !== 'unauth') woMsg('Chyba připojení k serveru', 'err'); }
  finally { btn.disabled = false; }
}

function woPickCredit(id, el) {
  document.getElementById('w-cred').value = id;
  document.querySelectorAll('#w-chips-row .wchip').forEach(c => c.classList.remove('sel'));
  if (el) el.classList.add('sel');
}

async function woPreview() {
  const customerId = document.getElementById('w-cust').value.trim();
  const creditId = document.getElementById('w-cred').value.trim();
  const target = document.getElementById('w-target').value.trim().replace(/\s/g, '').replace(',', '.');

  if (!/^\d+$/.test(customerId) || !/^\d+$/.test(creditId)) {
    woMsg('Zadejte platné ID klienta a půjčky.', 'err'); return;
  }
  if (target === '') { woMsg('Zadejte cílový zůstatek.', 'err'); return; }

  const btn = document.getElementById('w-preview-btn');
  const lbl = document.getElementById('w-preview-lbl');
  btn.disabled = true; lbl.innerHTML = '<span class="wspin"></span>';
  woMsg('');

  try {
    const bal = await api(`/api/writeoff/balance/${customerId}/${creditId}`);
    if (!bal.ok) { woMsg(esc(bal.data && bal.data.error || 'Chyba při čtení zůstatků'), 'err'); return; }

    const pv = await api('/api/writeoff/preview', {
      method: 'POST',
      body: JSON.stringify({ customerId, creditId, target }),
    });
    if (!pv.ok) { woMsg(esc(pv.data && pv.data.error || 'Chyba při výpočtu návrhu'), 'err'); return; }

    woPlan = pv.data;
    woRenderCheck(bal.data);
    woRenderPlan(pv.data);
    document.getElementById('w-empty').style.display = 'none';
    document.getElementById('w-result').style.display = '';
  } catch (e) { if (e.message !== 'unauth') woMsg('Chyba připojení k serveru', 'err'); }
  finally { btn.disabled = false; lbl.textContent = 'Načíst návrh'; }
}

function woRenderCheck(b) {
  const rows = [
    ['Součet košů', kcFmt(b.bucketSum)],
    ['Systémový dluh', kcFmt(b.debt)],
    ['Rozdíl', kcFmt(b.delta)],
  ].map(([k, v]) => `<div class="wcrow"><span>${k}</span><b>${v}</b></div>`).join('');

  const verdict = b.reconciled
    ? '<div class="wcrow ok"><span>Model dluhu souhlasí s CRM</span><b>✓</b></div>'
    : '<div class="wcrow bad"><span>Model dluhu se s CRM neshoduje</span><b>✗</b></div>';

  document.getElementById('w-check').innerHTML = rows + verdict;

  const diag = Object.keys(b.diagnostics || {}).map(col =>
    `<div class="dl"><span>${esc(col)}</span><span class="dv">${esc(b.diagnostics[col])}</span></div>`).join('');
  const out = Object.keys(b.outOfWaterfall || {});
  const outHtml = out.length
    ? `<div class="dn">Mimo vodopád: ${out.map(c => `${esc(c)} = ${kcFmt(b.outOfWaterfall[c])}`).join(', ')}</div>`
    : '';
  document.getElementById('w-diag').innerHTML = diag + outHtml
    + '<div class="dn">r_charge je naúčtovaná Cena — při odpisu se nemění. '
    + 'Zůstatek Ceny se bere z l_interest.</div>';
}

function woRenderPlan(p) {
  document.getElementById('w-plan-note').textContent =
    `${kcFmt(p.debtBefore)} → ${kcFmt(p.target)} · k odpisu ${kcFmt(p.amount)}`;

  const body = p.rows
    .filter(r => r.remaining.minor !== 0 || r.take)
    .map(r => `<tr>
      <td class="mono">${esc(r.bucket)}</td>
      <td class="mono" style="color:var(--gray);font-size:10.5px">${esc(r.column)}</td>
      <td class="num">${kcFmt(r.remaining)}</td>
      ${r.take ? `<td class="wtake">${kcFmt(r.take)}</td>` : '<td class="wdash">—</td>'}
      <td class="num">${kcFmt(r.rest)}</td>
    </tr>`).join('');

  document.getElementById('w-plan').innerHTML = `<table>
    <thead><tr>
      <th>Koš</th><th>Sloupec</th><th class="num">Zůstatek</th>
      <th class="num">K odpisu</th><th class="num">Zůstane</th>
    </tr></thead>
    <tbody>${body}
      <tr class="tot-row">
        <td colspan="2">Celkem</td>
        <td class="num">${kcFmt(p.capacity)}</td>
        <td class="num">${kcFmt(p.amount)}</td>
        <td class="num">${kcFmt(p.debtAfterExpected)}</td>
      </tr>
    </tbody></table>`;

  const finds = (p.findings || []).map(f => {
    const kind = f.severity === 'error' ? 'err' : 'warn';
    const icon = f.severity === 'error' ? '✗' : '!';
    return `<div class="wfind ${kind}"><span class="fi">${icon}</span>
      <span><code>${esc(f.code)}</code> — ${esc(f.message)}</span></div>`;
  });
  if (!finds.length) {
    finds.push('<div class="wfind good"><span class="fi">✓</span><span>Kontroly bez připomínek</span></div>');
  }
  document.getElementById('w-finds').innerHTML = finds.join('');

  document.getElementById('w-idem').textContent = 'key ' + String(p.idempotencyKey).slice(0, 16);

  const btn = document.getElementById('w-apply-btn');
  btn.disabled = !p.ok;
  btn.textContent = p.ok ? `Odepsat ${kcFmt(p.amount)} Kč` : 'Zablokováno kontrolami';
}

function woOpenConfirm() {
  if (!woPlan || !woPlan.ok) return;
  const p = woPlan;
  const taken = p.rows.filter(r => r.take);
  document.getElementById('w-modal-sub').textContent =
    `Klient ${esc(p.customerId)} · půjčka ${esc(p.creditId)}`;
  document.getElementById('w-modal-bd').innerHTML = `
    <div class="wml">
      ${taken.map(r => `<div class="ml"><span>${esc(r.bucket)}</span><span>${kcFmt(r.take)}</span></div>`).join('')}
      <div class="ml tot"><span>Celkem k odpisu</span><span>${kcFmt(p.amount)} Kč</span></div>
    </div>
    <div class="wml">
      <div class="ml"><span>Dluh nyní</span><span>${kcFmt(p.debtBefore)}</span></div>
      <div class="ml"><span>Dluh po odpisu</span><span>${kcFmt(p.target)}</span></div>
    </div>
    <p style="font-size:11.5px;color:var(--text-s)">Zapisuje se do CRM pod uživatelem
      <strong>${esc(currentUser || '')}</strong>. Po zápisu se zůstatek načte znovu a porovná s cílem.</p>`;
  document.getElementById('w-modal').classList.add('show');
}

function woCloseConfirm() {
  document.getElementById('w-modal').classList.remove('show');
}

async function woApply() {
  if (!woPlan) return;
  const btn = document.getElementById('w-confirm-btn');
  const lbl = document.getElementById('w-confirm-lbl');
  btn.disabled = true; lbl.innerHTML = '<span class="wspin"></span>';

  try {
    const r = await api('/api/writeoff/apply', {
      method: 'POST',
      body: JSON.stringify({
        customerId: woPlan.customerId,
        creditId: woPlan.creditId,
        target: String(woPlan.target.minor / 100),
        idempotencyKey: woPlan.idempotencyKey,
      }),
    });

    woCloseConfirm();

    // 409 s novým planem = zůstatky se změnily nebo kontroly zablokovaly.
    // Překreslíme návrh, aby operátor viděl aktuální stav, ne ten svůj starý.
    if (r.data && r.data.plan) {
      woPlan = r.data.plan;
      woRenderPlan(r.data.plan);
    }

    if (!r.ok) {
      const extra = r.data && r.data.verification && !r.data.verification.ok
        ? ` Dluh po zápisu: ${kcFmt(r.data.verification.debtAfter)} místo ${kcFmt(r.data.verification.expectedDebt)}.`
        : '';
      woMsg('<strong>' + esc(r.data && r.data.error || 'Odpis se nepodařilo provést') + '</strong>'
        + (r.data && r.data.message ? ' ' + esc(r.data.message) : '') + extra, 'err');
      return;
    }

    if (r.data.status === 'already_applied') {
      woMsg('Tento odpis už byl proveden. ' + esc(r.data.message || ''), 'warn');
      return;
    }

    woMsg(`<strong>Odepsáno.</strong> writeoffId ${esc(r.data.writeoffId || '—')} · `
      + `dluh je nyní ${kcFmt(r.data.verification ? r.data.verification.debtAfter : woPlan.target)} Kč.`, 'ok');
    document.getElementById('w-apply-btn').disabled = true;
    document.getElementById('w-apply-btn').textContent = 'Odepsáno';
  } catch (e) { if (e.message !== 'unauth') woMsg('Chyba připojení k serveru', 'err'); }
  finally { btn.disabled = false; lbl.textContent = 'Odepsat'; }
}

document.getElementById('w-modal').addEventListener('click', function (e) {
  if (e.target === this) woCloseConfirm();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') woCloseConfirm();
});

// ── Uživatelé ─────────────────────────────────────────────────────────────
const ROLE_LABEL = {
  admin: 'vše + správa uživatelů',
  cc: 'odpis',
  mail: 'pouze čtení',
};

function uMsg(text, kind) {
  const el = document.getElementById('u-msg');
  if (!text) { el.style.display = 'none'; return; }
  el.style.display = ''; el.textContent = text;
  const ok = kind === 'ok';
  el.style.background = ok ? 'var(--green-l)' : 'var(--red-l)';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  el.style.borderColor = ok ? '#97C459' : '#F09595';
}

async function uLoad() {
  uMsg('');
  try {
    const r = await api('/api/users');
    if (!r.ok) { uMsg(r.data && r.data.error || 'Chyba při načítání uživatelů'); return; }
    const roles = r.data.roles;
    document.getElementById('u-table').innerHTML = `<table>
      <thead><tr>
        <th>Uživatel</th><th>Role</th><th>Oprávnění</th>
        <th>Přehled</th><th>Odpis</th><th>Správa</th><th>Vytvořen</th>
      </tr></thead>
      <tbody>${r.data.users.map(u => `<tr>
        <td><strong>${esc(u.username)}</strong>${u.username === r.data.me ? ' <span style="color:var(--gray);font-size:10px">(vy)</span>' : ''}</td>
        <td>
          <select class="rolesel" data-action="set-role" data-user-id="${esc(u.id)}" data-username="${esc(u.username)}">
            ${roles.map(role => `<option value="${esc(role)}"${role === u.role ? ' selected' : ''}>${esc(role)}</option>`).join('')}
          </select>
          ${u.roleMissing ? '<div style="font-size:10px;color:var(--amber)">v users.json chybí role</div>' : ''}
        </td>
        <td style="color:var(--text-s);font-size:11px">${esc(ROLE_LABEL[u.role] || '')}</td>
        <td>${u.caps.indexOf('prehled') !== -1 ? '✓' : '<span style="color:#B6BCC6">—</span>'}</td>
        <td>${u.caps.indexOf('writeoff') !== -1 ? '✓' : '<span style="color:#B6BCC6">—</span>'}</td>
        <td>${u.caps.indexOf('users') !== -1 ? '✓' : '<span style="color:#B6BCC6">—</span>'}</td>
        <td class="mono" style="font-size:10.5px;color:var(--gray)">${esc(u.createdAt ? String(u.createdAt).slice(0, 10) : '—')}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) { if (e.message !== 'unauth') uMsg('Chyba připojení k serveru'); }
}

async function uSetRole(id, username, sel) {
  const role = sel.value;
  sel.disabled = true;
  try {
    const r = await api(`/api/users/${encodeURIComponent(id)}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    if (!r.ok) {
      uMsg(r.data && r.data.error || 'Roli se nepodařilo změnit');
      await uLoad();
      return;
    }
    uMsg(`Role uživatele ${username} je nyní ${role}.`, 'ok');
    await uLoad();
    // Změnil-li admin roli sám sobě, musí se překreslit i jeho vlastní záložky.
    if (username === currentUser) await refreshMe();
  } catch (e) { if (e.message !== 'unauth') uMsg('Chyba připojení k serveru'); }
  finally { sel.disabled = false; }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
// Po reloadu stránky máme v sessionStorage jen token. /auth/me ho zároveň
// ověří a řekne, co smíme — takže neplatný token vede na login, ne na
// prázdné záložky.
async function refreshMe() {
  const res = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401) { handleUnauth(); return false; }
  if (!res.ok) return false;
  const me = await res.json();
  currentUser = me.username;
  currentRole = me.role;
  caps = me.caps || [];
  sessionStorage.setItem('cg_user', currentUser);
  document.getElementById('topbar-user').textContent = currentUser;
  applyCaps();
  return true;
}

async function boot() {
  checkAuth();
  if (token) {
    try { await refreshMe(); } catch { handleUnauth(); }
  }
}

boot();

const ACTIONS = {
  'do-pdf-one': () => doPDF(1), 'do-pdf-two': () => doPDF(2), 'close-pdf': () => closePdfModal(),
  login: () => doLogin(), search: () => hledat(), logout: () => doLogout(),
  'view-one': () => setView(1), 'view-two': () => setView(2), 'toggle-paid': () => togAllUhrazeno(),
  'toggle-edit': () => togEdit(), 'toggle-copy': () => togCopy(), 'toggle-save-menu': () => togSaveMenu(),
  'export-pdf': () => { expPDF(); closeSaveMenu(); }, 'download-excel': () => { downloadExcel(); closeSaveMenu(); },
  'copy-all': () => copyAll(), 'copy-selected': () => copySelected(), reset: () => resetAll(),
  'wo-load-credits': () => woLoadCredits(), 'wo-preview': () => woPreview(), 'wo-reset': () => woReset(),
  'wo-open-confirm': () => woOpenConfirm(), 'wo-close-confirm': () => woCloseConfirm(), 'wo-apply': () => woApply(),
  'wo-pick-credit': el => woPickCredit(el.dataset.creditId, el),
  sort: el => sortBy(el.dataset.key), 'toggle-column': (el, event) => togCol(el.dataset.key, event.target.checked),
  'toggle-column-group': (el, event) => { const [v, u] = el.dataset.key.replace('__g', '').split('|'); hcols[v] = !event.target.checked; hcols[u] = !event.target.checked; render(); },
  'toggle-selected-row': (el, event) => { if (el.matches('input')) event.stopPropagation(); togSelRow(Number(el.dataset.row)); },
  'toggle-row': (el, event) => togRow(Number(el.dataset.row), event.target.checked),
  'toggle-chain': (el, event) => togChain(el.dataset.origin, event.target.checked),
  'stop-row-click': (el, event) => event.stopPropagation(),
  'edit-value': (el, event) => editV(Number(el.dataset.row), el.dataset.key, event.target),
  'show-tab': el => showTab(el.dataset.tab),
  'set-role': (el, event) => uSetRole(el.dataset.userId, el.dataset.username, event.target),
};

const ACTION_EVENTS = {
  'toggle-column': 'change', 'toggle-column-group': 'change',
  'toggle-row': 'change', 'toggle-chain': 'change', 'edit-value': 'change', 'set-role': 'change',
};
document.addEventListener('click', event => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  if (ACTION_EVENTS[el.dataset.action] && ACTION_EVENTS[el.dataset.action] !== 'click') return;
  ACTIONS[el.dataset.action]?.(el, event);
});
for (const eventName of ['change', 'input']) {
  document.addEventListener(eventName, event => {
    const el = event.target.closest('[data-action]');
    if (!el || ACTION_EVENTS[el.dataset.action] !== eventName) return;
    ACTIONS[el.dataset.action]?.(el, event);
  });
}
