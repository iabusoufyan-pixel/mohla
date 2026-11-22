(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const CSRF=document.querySelector('meta[name=csrf]').content;
  const ROLE=document.body.dataset.role;
  const ADMIN=ROLE==='admin';
  const fmt=n=>(Math.round((+n||0)*100)/100).toLocaleString('en-US');
  const setStatus=(t,err)=>{const s=$('status');s.textContent=t;s.classList.toggle('err',!!err)};
  const MIN_CLIENTS=20, PRESETS=[10,20,30];

  let S={rate:14,partners:[],clients:{}};   // server state
  let current=null, tab=null, extra=0, loaded=false, scopeRoute=undefined;

  /* ---------- api ---------- */
  async function api(method,url,body){
    const opt={method,headers:{'X-CSRF':CSRF},credentials:'same-origin'};
    if(body instanceof FormData) opt.body=body;
    else if(body!==undefined){opt.headers['Content-Type']='application/json';opt.body=JSON.stringify(body)}
    const r=await fetch(url,opt);
    if(r.status===401){location.href='/login';throw new Error('login')}
    let j=null;try{j=await r.json()}catch(e){}
    if(!r.ok) throw new Error((j&&j.error)||'تعذّر الحفظ، حاول مرة أخرى');
    return j;
  }
  async function load(){
    try{
      const j=await api('GET','/api/state');
      S={rate:j.rate,partners:j.partners,clients:j.clients||{}};sortPartners();
      if(!loaded){loaded=true;setStatus('البيانات محدّثة')}
      route();
    }catch(e){if(e.message!=='login')setStatus('تعذّر تحميل البيانات، تأكد من الاتصال',true)}
  }
  const queue=new Map();
  function run(key,fn){
    const p=(queue.get(key)||Promise.resolve()).catch(()=>{}).then(fn)
      .then(r=>{setStatus('تم الحفظ');return r},e=>{setStatus(e.message,true);throw e});
    queue.set(key,p);setStatus('جارٍ الحفظ…');return p;
  }

  /* ---------- helpers ---------- */
  function sortPartners(){S.partners.sort((a,b)=>(+b.capital||0)-(+a.capital||0)||(a.order||0)-(b.order||0)||a.id-b.id)}
  const partner=id=>S.partners.find(p=>String(p.id)===String(id));
  const clientsOf=id=>S.clients[String(id)]||[];
  const clientAt=(id,slot)=>clientsOf(id).find(c=>c.slot===slot);
  function stats(id){
    let taken=0,due=0,paid=0,n=0;
    for(const c of clientsOf(id)){if(c.name||c.taken||c.due)n++;taken+=+c.taken||0;due+=+c.due||0;if(c.paid)paid+=+c.due||0}
    const cap=+(partner(id)||{}).capital||0;
    return {cap,spent:taken,left:cap-taken,due,profit:due-taken,paid,n};
  }
  function waLink(phone){
    let d=String(phone||'').replace(/\D/g,'');if(!d) return '';
    if(d.startsWith('00')) d=d.slice(2);
    if(d.startsWith('05')) d='966'+d.slice(1); else if(d.startsWith('5')&&d.length===9) d='966'+d;
    return 'https://wa.me/'+d;
  }
  function field(cls,type,val,ph,onSave){
    const i=document.createElement('input');i.type=type;i.className=cls;i.value=val??'';if(ph&&ADMIN)i.placeholder=ph;
    if(type==='number'){i.inputMode='decimal';i.step='any';i.min='0'}
    if(!ADMIN){i.readOnly=true;i.tabIndex=-1}
    i.addEventListener('change',()=>onSave(type==='number'?(i.value===''?null:+i.value):i.value.trim()));
    return i;
  }
  function setVal(i,v){if(document.activeElement!==i) i.value=v??''}
  const td=x=>{const c=document.createElement('td');if(x)c.append(x);return c};
  function showTiles(t){
    $('s-cap').textContent=fmt(t.cap);$('s-spent').textContent=fmt(t.spent);$('s-left').textContent=fmt(t.left);
    $('s-due').textContent=fmt(t.due);$('s-profit').textContent=fmt(t.profit);$('s-paid').textContent=fmt(t.paid);
    $('s-left').style.color=t.left<0?'var(--bad)':'';
    $('hb').innerHTML='';$('hb').append(fmt(t.left));const c=document.createElement('span');c.className='cur';c.textContent='ريال';$('hb').append(c);
    $('hb').classList.toggle('neg',t.left<0);$('sum-pill').textContent=t.n+' عميل';
  }
  function armed(btn,label,confirmLabel,fn){
    let on=false;
    btn.addEventListener('click',()=>{
      if(!on){on=true;btn.textContent=confirmLabel;setTimeout(()=>{if(on){on=false;btn.textContent=label}},3500);return}
      on=false;btn.textContent=label;fn();
    });
  }

  /* ---------- home: partners ---------- */
  function renderHome(){
    const tb=$('partners');tb.replaceChildren();
    if(!S.partners.length){const tr=document.createElement('tr');const c=td();c.colSpan=10;c.className='empty';c.textContent='لا يوجد شركاء بعد. اضغط «إضافة شريك».';tr.append(c);tb.append(tr)}
    S.partners.forEach((p,k)=>{
      const tr=document.createElement('tr');
      const up=(f,v)=>{p[f]=v;if(f==='capital')sortPartners();run('p'+p.id,()=>api('PUT','/api/partner/'+p.id,{[f]:v}));refresh()};
      const idx=td();idx.className='idx';idx.textContent=k+1;
      const t=stats(p.id);
      const cell=(v,cls)=>{const c=td();c.className='num calc'+(cls?' '+cls:'');c.textContent=v;return c};
      const acct=td();const ab=document.createElement('div');ab.className='acct';
      if(p.account){const u=document.createElement('span');u.className='u';u.textContent=p.account;ab.append(u)}
      const mk=document.createElement('button');mk.type='button';mk.className='open';mk.textContent=p.account?'كلمة مرور جديدة':'إنشاء دخول';
      mk.addEventListener('click',()=>openAcct(p));ab.append(mk);
      if(p.account){const rm=document.createElement('button');rm.type='button';rm.className='del';rm.style.fontSize='12px';rm.textContent='إيقاف';
        armed(rm,'إيقاف','تأكيد؟',()=>run('a'+p.id,()=>api('DELETE','/api/partner/'+p.id+'/account')).then(load));ab.append(rm)}
      acct.append(ab);
      const open=document.createElement('a');open.className='btn open';open.href='#p'+p.id;open.textContent='فتح صفحته';
      const del=document.createElement('button');del.type='button';del.className='del';del.setAttribute('aria-label','حذف الشريك');del.textContent='✕';
      armed(del,'✕','تأكيد حذف الشريك وعملائه',()=>run('p'+p.id,()=>api('DELETE','/api/partner/'+p.id)).then(load));
      const act=td();const ai=document.createElement('div');ai.style.cssText='display:flex;gap:6px;align-items:center';ai.append(open,del);act.append(ai);
      tr.append(idx,td(field('w-name','text',p.name,'اسم الشريك',v=>up('name',v))),td(field('w-money','number',p.capital,'0',v=>up('capital',v))),
        cell(fmt(t.spent)),cell(fmt(t.left),t.left<0?'neg':''),cell(t.n),cell(fmt(t.due)),cell(fmt(t.profit)),acct,act);
      tb.append(tr);
    });
    const all={cap:0,spent:0,left:0,due:0,profit:0,paid:0,n:0};
    for(const p of S.partners){const t=stats(p.id);for(const k in all) all[k]+=t[k]}
    $('p-cap').textContent=fmt(all.cap);$('p-spent').textContent=fmt(all.spent);$('p-left').textContent=fmt(all.left);
    $('p-n').textContent=all.n;$('p-due').textContent=fmt(all.due);$('p-profit').textContent=fmt(all.profit);
    showTiles(all);
  }
  $('add-partner').addEventListener('click',()=>run('new',()=>api('POST','/api/partner',{name:''})).then(load));

  /* ---------- partner page: clients ---------- */
  let cRows=new Map();
  function slotCount(id){
    const m=Math.max(0,...clientsOf(id).map(c=>c.slot));
    return Math.max(MIN_CLIENTS,m)+extra;
  }
  let pendingSlot=null;
  $('file').addEventListener('change',async e=>{
    const f=e.target.files[0];e.target.value='';if(!f||pendingSlot==null) return;
    const slot=pendingSlot,pid=current;pendingSlot=null;
    const fd=new FormData();fd.append('file',f);
    setStatus('جارٍ رفع السند…');
    try{const c=await run('c'+pid+'-'+slot,()=>api('POST','/api/client/'+pid+'/'+slot+'/bond',fd));putClient(pid,c);refresh()}catch(e){}
  });
  function putClient(pid,c){
    const list=S.clients[String(pid)]||(S.clients[String(pid)]=[]);
    const i=list.findIndex(x=>x.slot===c.slot);if(i>=0)list[i]=c;else list.push(c);
  }
  function bondCell(slot,d){
    const wrap=document.createElement('div');wrap.className='bond';
    if(d&&d.bond){
      const src='/bond/'+d.bond;
      if((d.bondType||'').includes('pdf')){const a=document.createElement('a');a.className='pdf';a.href=src;a.target='_blank';a.rel='noopener';a.textContent='PDF';wrap.append(a)}
      else{const img=document.createElement('img');img.src=src;img.alt='صورة السند';img.loading='lazy';img.addEventListener('click',()=>openLight(src));wrap.append(img)}
    }
    if(ADMIN){const b=document.createElement('button');b.type='button';b.textContent=d&&d.bond?'تغيير':'رفع السند';
      b.addEventListener('click',()=>{pendingSlot=slot;$('file').click()});wrap.append(b)}
    else if(!(d&&d.bond)) wrap.append(Object.assign(document.createElement('span'),{className:'note',textContent:'—'}));
    return wrap;
  }
  function renderPartner(){
    const pid=current;const p=partner(pid);if(!p) return;
    $('title').firstChild.textContent=(p.name||(ADMIN?'شريك':'صفحتي'))+' ';
    $('subtitle').textContent=ADMIN?'صفحة الشريك وعملاؤه':'رأس مالك وعملاؤك في مهلة';
    setVal($('cap-input'),p.capital);$('cap-input').disabled=!ADMIN;
    $('add-client').hidden=!ADMIN;
    $('rate-chip2').textContent=ADMIN?'نسبة الربح '+S.rate+'٪':'';
    $('clients-note').hidden=!ADMIN;
    const tb=$('clients');
    const slots=ADMIN?Array.from({length:slotCount(pid)},(_,i)=>i+1):clientsOf(pid).filter(c=>c.name||c.taken||c.due).map(c=>c.slot);
    const want=new Set(slots);
    for(const [s,r] of cRows) if(!want.has(s)){r.tr.remove();cRows.delete(s)}
    if(!slots.length&&!tb.querySelector('.empty')){const tr=document.createElement('tr');const c=td();c.colSpan=9;c.className='empty';c.textContent='لا يوجد عملاء مسجّلون بعد.';tr.append(c);tb.replaceChildren(tr)}
    if(slots.length){const e=tb.querySelector('.empty');if(e)e.parentElement.remove()}
    slots.forEach((slot,k)=>{
      const d=clientAt(pid,slot)||{};let r=cRows.get(slot);
      if(!r){
        const tr=document.createElement('tr');
        const up=(f,v)=>{
          const c={...(clientAt(pid,slot)||{slot}),[f]:v};
          if(f==='taken'){c.rate=v==null?null:S.rate;c.due=v==null?null:Math.round(v*(1+S.rate/100)*100)/100}
          putClient(pid,c);updateRow(slot);refresh();
          run('c'+pid+'-'+slot,()=>api('PUT','/api/client/'+pid+'/'+slot,{[f]:v})).then(x=>{putClient(pid,x);updateRow(slot)}).catch(()=>{});
        };
        r={tr,name:field('w-name','text',d.name,'اسم العميل',v=>up('name',v)),nid:field('w-id','text',d.nid,'رقم الهوية',v=>up('nid',v)),
           bond:document.createElement('td'),taken:field('w-money','number',d.taken,'0',v=>up('taken',v)),due:field('w-money auto','number',d.due,'تلقائي',()=>{}),
           profit:document.createElement('td'),phone:field('w-phone','tel',d.phone,'05xxxxxxxx',v=>up('phone',v)),wa:document.createElement('a'),paid:document.createElement('input'),idx:td()};
        r.due.readOnly=true;r.due.tabIndex=-1;r.due.title='يُحسب تلقائيًا من المأخوذ ونسبة الربح';
        r.nid.inputMode='numeric';r.nid.style.direction='ltr';r.nid.style.textAlign='right';
        r.phone.style.direction='ltr';r.phone.style.textAlign='right';r.profit.className='num calc';
        r.wa.className='btn wa';r.wa.target='_blank';r.wa.rel='noopener';r.wa.textContent='واتساب';r.wa.title='فتح محادثة العميل في واتساب';
        r.paid.type='checkbox';r.paid.className='paid';r.paid.setAttribute('aria-label','تم السداد');r.paid.disabled=!ADMIN;r.paid.addEventListener('change',()=>up('paid',r.paid.checked));
        r.idx.className='idx';
        const ph=document.createElement('div');ph.className='phone';ph.append(r.phone,r.wa);
        const paidTd=td(r.paid);paidTd.className='keep';
        tr.append(r.idx,td(r.name),td(r.nid),r.bond,td(r.taken),td(r.due),r.profit,td(ph),paidTd);
        cRows.set(slot,r);
      }
      if(tb.children[k]!==r.tr) tb.insertBefore(r.tr,tb.children[k]||null);
      r.idx.textContent=ADMIN?slot:k+1;
      setVal(r.name,d.name);setVal(r.nid,d.nid);setVal(r.taken,d.taken);setVal(r.due,d.due);setVal(r.phone,d.phone);r.paid.checked=!!d.paid;
      const bk=(d.bond||'')+'';if(r.bond.dataset.k!==bk){r.bond.dataset.k=bk;r.bond.replaceChildren(bondCell(slot,d))}
      updateRow(slot);
    });
    showTiles(stats(pid));
    let taken=0,due=0,paid=0;for(const c of clientsOf(pid)){taken+=+c.taken||0;due+=+c.due||0;if(c.paid)paid+=+c.due||0}
    $('c-taken').textContent=fmt(taken);$('c-due').textContent=fmt(due);$('c-profit').textContent=fmt(due-taken);$('c-paid').textContent=fmt(paid);
  }
  function updateRow(slot){
    const r=cRows.get(slot);if(!r) return;const d=clientAt(current,slot)||{};
    const has=d.taken!=null&&d.due!=null;const p=(+d.due||0)-(+d.taken||0);
    setVal(r.due,d.due);
    r.profit.textContent=has?fmt(p):'';r.profit.classList.toggle('pos',has&&p>0);r.profit.classList.toggle('neg',has&&p<0);
    const link=waLink(d.phone);
    if(link){r.wa.href=link;r.wa.removeAttribute('aria-disabled')}else{r.wa.removeAttribute('href');r.wa.setAttribute('aria-disabled','true')}
    r.tr.classList.toggle('is-paid',!!d.paid);
  }
  $('cap-input').addEventListener('change',()=>{
    const p=partner(current);if(!p||!ADMIN) return;const v=$('cap-input').value===''?null:+$('cap-input').value;
    p.capital=v;sortPartners();run('p'+p.id,()=>api('PUT','/api/partner/'+p.id,{capital:v}));refresh();
  });
  $('add-client').addEventListener('click',()=>{extra++;renderPartner();const r=cRows.get(slotCount(current));if(r)setTimeout(()=>r.name.focus(),0)});

  /* ---------- rate ---------- */
  function drawPresets(box,active,onPick,extraV){
    const vals=PRESETS.concat(extraV!=null&&!PRESETS.includes(extraV)?[extraV]:[]);
    box.replaceChildren(...vals.map(v=>{const b=document.createElement('button');b.type='button';b.textContent=v+'٪';
      b.setAttribute('aria-pressed',String(+active===v));b.addEventListener('click',()=>onPick(v));return b}));
  }
  function setRate(v){S.rate=v;run('rate',()=>api('PUT','/api/rate',{rate:v}));refresh()}
  $('rate-input').addEventListener('change',()=>{const v=$('rate-input').value;if(v===''||!(+v>=0)){setVal($('rate-input'),S.rate);return}setRate(+v)});
  armed($('apply-rate'),'تعميم النسبة','تأكيد إعادة الحساب',()=>{
    const pid=$('apply-scope').value;const who=pid?((partner(pid)||{}).name||'الشريك'):'كل الشركاء';
    run('apply',()=>api('POST','/api/rate/apply',pid?{partner_id:+pid}:{})).then(j=>{setStatus('تم تعميم '+j.rate+'٪ على '+j.changed+' عميل عند '+who);load()}).catch(()=>{});
  });
  function fillSelect(sel,withAll,keep){
    const v=sel.value;
    const opts=[];if(withAll)opts.push(['','كل الشركاء']);
    for(const p of S.partners) opts.push([String(p.id),p.name||'شريك بدون اسم']);
    const key=opts.map(o=>o.join(':')).join('|');
    if(sel.dataset.k!==key){sel.dataset.k=key;sel.replaceChildren(...opts.map(([val,l])=>{const o=document.createElement('option');o.value=val;o.textContent=l;return o}))}
    const want=keep!=null?String(keep):v;
    if(opts.some(o=>o[0]===want)) sel.value=want;
  }

  /* ---------- new client ---------- */
  function newCalc(){
    const t=$('n-taken').value===''?null:+$('n-taken').value;
    const d=t==null?0:Math.round(t*(1+S.rate/100)*100)/100;
    $('n-due').textContent=fmt(d);$('n-profit').textContent=fmt(t==null?0:d-t);$('n-rate').textContent='نسبة الربح '+S.rate+'٪';
  }
  function renderNew(){fillSelect($('n-partner'),false,$('n-partner').dataset.pref||null);delete $('n-partner').dataset.pref;newCalc()}
  $('n-taken').addEventListener('input',newCalc);
  $('new-form').addEventListener('submit',async e=>{
    e.preventDefault();$('n-err').textContent='';
    const pid=$('n-partner').value;const name=$('n-name').value.trim();
    if(!pid){$('n-err').textContent='اختر الشريك';return}
    if(!name){$('n-err').textContent='اكتب اسم العميل';$('n-name').focus();return}
    const t=$('n-taken').value===''?null:+$('n-taken').value;
    const btn=$('n-save');btn.disabled=true;
    try{
      const c=await run('new-'+pid,()=>api('POST','/api/client/'+pid,{name,nid:$('n-nid').value,phone:$('n-phone').value,taken:t}));
      const f=$('n-bond').files[0];
      if(f){const fd=new FormData();fd.append('file',f);try{await run('c'+pid+'-'+c.slot,()=>api('POST','/api/client/'+pid+'/'+c.slot+'/bond',fd))}catch(err){$('n-err').textContent='حُفظ العميل لكن تعذّر رفع السند: '+err.message}}
      const pn=(partner(pid)||{}).name||'الشريك';
      const txt=$('n-done-txt');txt.replaceChildren();
      txt.append('أُضيف «'+name+'» إلى عملاء '+pn+(t!=null?' بمبلغ '+fmt(t)+'، والمطلوب '+fmt(c.due)+' ريال':'')+'. ');
      const a=document.createElement('a');a.href='#p'+pid;a.textContent='فتح صفحة '+pn;a.style.color='var(--accent)';a.style.fontWeight='700';txt.append(a);
      $('n-done').hidden=false;
      for(const id of ['n-name','n-nid','n-phone','n-taken']) $(id).value='';$('n-bond').value='';newCalc();
      await load();
    }catch(err){$('n-err').textContent=err.message}
    btn.disabled=false;
  });

  /* ---------- pay ---------- */
  function renderPay(){
    const list=$('pay-list');const items=[];let due=0,paid=0,cnt=0,done=0;
    if(ADMIN&&!current){
      for(const p of S.partners){
        let d=0,pd=0,n=0,k=0;
        for(const c of clientsOf(p.id)){if(!(+c.due))continue;n++;d+=+c.due;if(c.paid){k++;pd+=+c.due}}
        due+=d;paid+=pd;cnt+=n;done+=k;
        items.push({name:p.name||'شريك',side:fmt(pd)+' / '+fmt(d),sub:'سدّد '+k+' من '+n+' عملاء',ratio:d?pd/d:0,href:'#p'+p.id});
      }
    }else{
      const rows=clientsOf(current).filter(c=>+c.due).sort((a,b)=>(!!a.paid)-(!!b.paid)||a.slot-b.slot);
      for(const c of rows){cnt++;due+=+c.due;if(c.paid){done++;paid+=+c.due}items.push({name:c.name||'عميل',side:fmt(c.due),paid:!!c.paid,wa:c.paid?'':waLink(c.phone)})}
    }
    $('pay-bar').style.width=(due?Math.round(paid/due*100):0)+'%';
    $('pay-txt').textContent='سدّد '+done+' من '+cnt;$('pay-left').textContent='المتبقي '+fmt(due-paid)+' ريال';
    $('pay-pill').textContent=fmt(paid)+' من '+fmt(due);
    list.replaceChildren();
    if(!items.length){list.append(Object.assign(document.createElement('p'),{className:'empty',textContent:'لا توجد مبالغ مطلوبة بعد.'}));return}
    for(const it of items){
      const el=document.createElement('div');el.className='pitem';
      const n=document.createElement(it.href?'a':'span');n.className='n';n.textContent=it.name;if(it.href){n.href=it.href;n.style.color='var(--accent)';n.style.textDecoration='none'}
      const side=document.createElement('span');side.className='side';
      const v=document.createElement('span');const vn=document.createElement('span');vn.className='num';vn.textContent=it.side;v.append(vn,' ريال');side.append(v);
      if('paid' in it){const pl=document.createElement('span');pl.className='pill'+(it.paid?' ok':'');pl.textContent=it.paid?'مسدَّد':'متبقٍّ';side.append(pl)}
      if(it.wa){const a=document.createElement('a');a.className='btn wa';a.href=it.wa;a.target='_blank';a.rel='noopener';a.textContent='واتساب';side.append(a)}
      el.append(n,side);
      if(it.sub){const sb=document.createElement('span');sb.className='sub';sb.textContent=it.sub;const m=document.createElement('span');m.className='mini';const i=document.createElement('i');i.style.width=Math.round(it.ratio*100)+'%';m.append(i);el.append(sb,m)}
      list.append(el);
    }
  }

  /* ---------- tabs / routing ---------- */
  function tabsFor(){
    if(ADMIN&&!current) return [['summary','الملخص'],['partners','الشركاء'],['new','عميل جديد'],['pay','السداد']];
    if(ADMIN) return [['summary','الملخص'],['clients','العملاء'],['new','عميل جديد'],['pay','السداد']];
    return [['summary','الملخص'],['clients','العملاء'],['pay','السداد']];
  }
  function applyTabs(){
    const list=tabsFor();if(!list.some(t=>t[0]===tab)) tab=list[1][0];
    const box=$('tabs');const key=list.map(t=>t[0]).join();
    if(box.dataset.k!==key){box.dataset.k=key;box.replaceChildren(...list.map(([k,l])=>{const b=document.createElement('button');b.type='button';b.className='tab';b.setAttribute('role','tab');b.dataset.tab=k;b.textContent=l;b.addEventListener('click',()=>{tab=k;if(k==='new'){$('n-done').hidden=true;if(current)$('n-partner').dataset.pref=current}refresh()});return b}))}
    for(const b of box.children) b.setAttribute('aria-selected',String(b.dataset.tab===tab));
    $('v-summary').hidden=tab!=='summary';$('v-home').hidden=tab!=='partners';$('v-partner').hidden=tab!=='clients';$('v-pay').hidden=tab!=='pay';$('v-new').hidden=tab!=='new';
  }
  function refresh(){
    applyTabs();
    if(current) renderPartner(); else renderHome();
    $('sum-title').textContent=current?'كشف حساب '+((partner(current)||{}).name||''):'كشف حساب مهلة';
    $('rate-card').hidden=!ADMIN;$('import-card').hidden=!(ADMIN&&!current&&!S.partners.length);
    if(ADMIN){fillSelect($('apply-scope'),true,scopeRoute!==current?(scopeRoute=current,current||''):null);renderNew();setVal($('rate-input'),S.rate);$('rate-chip').textContent='الحالية '+S.rate+'٪';drawPresets($('presets'),S.rate,setRate,null)}
    renderPay();calcRate();
  }
  function route(){
    let next=null;
    if(ADMIN){const m=location.hash.match(/^#p(\d+)$/);next=m&&partner(m[1])?m[1]:null}
    else next=S.partners[0]?String(S.partners[0].id):null;
    if(next!==current){current=next;tab=null;extra=0;cRows=new Map();$('clients').replaceChildren();window.scrollTo(0,0)}
    $('crumbs').hidden=!(ADMIN&&current);
    if(!current){$('title').firstChild.textContent='دفتر مهلة ';$('subtitle').textContent='رؤوس الأموال والعملاء'}
    if(!ADMIN&&!current){setStatus('لم يُربط حسابك بشريك بعد. تواصل مع صاحب الدفتر.',true)}
    refresh();
  }
  window.addEventListener('hashchange',route);

  /* ---------- partner account modal ---------- */
  let acctP=null;
  function openAcct(p){
    acctP=p;$('acct-h').textContent='دخول '+(p.name||'الشريك');$('acct-user').value=p.account||'';$('acct-err').textContent='';
    $('acct-form').hidden=false;$('acct-done').hidden=true;$('acct-modal').hidden=false;$('acct-user').focus();
  }
  $('acct-cancel').addEventListener('click',()=>{$('acct-modal').hidden=true});
  $('acct-close').addEventListener('click',()=>{$('acct-modal').hidden=true;load()});
  $('acct-save').addEventListener('click',async()=>{
    $('acct-err').textContent='';
    try{
      const j=await api('POST','/api/partner/'+acctP.id+'/account',{username:$('acct-user').value});
      const c=$('acct-cred');c.replaceChildren();
      const line=(k,v)=>{const d=document.createElement('div');d.append(k+': ');const b=document.createElement('b');b.textContent=v;d.append(b);c.append(d)};
      line('الرابط',location.origin);line('اسم المستخدم',j.username);line('كلمة المرور',j.password);
      $('acct-form').hidden=true;$('acct-done').hidden=false;
    }catch(e){$('acct-err').textContent=e.message}
  });
  $('acct-copy').addEventListener('click',()=>{
    const t=$('acct-cred').innerText;
    try{navigator.clipboard.writeText(t).then(()=>setStatus('تم النسخ'),()=>{})}catch(e){}
  });

  /* ---------- own password ---------- */
  $('pw-open').addEventListener('click',()=>{$('pw-old').value='';$('pw-new').value='';$('pw-err').textContent='';$('pw-modal').hidden=false;$('pw-old').focus()});
  $('pw-cancel').addEventListener('click',()=>{$('pw-modal').hidden=true});
  $('pw-save').addEventListener('click',async()=>{
    try{await api('POST','/api/password',{old:$('pw-old').value,new:$('pw-new').value});$('pw-modal').hidden=true;setStatus('تم تغيير كلمة المرور')}
    catch(e){$('pw-err').textContent=e.message}
  });

  /* ---------- import ---------- */
  $('import-btn').addEventListener('click',async()=>{
    const t=$('import-text').value.trim();if(!t) return;
    try{const j=await api('POST','/api/import',{data:t});setStatus('تم استيراد '+j.partners+' شريك');$('import-text').value='';load()}
    catch(e){setStatus(e.message,true)}
  });

  /* ---------- lightbox ---------- */
  function openLight(src){
    const box=document.createElement('div');box.className='light';box.setAttribute('role','dialog');box.setAttribute('aria-label','صورة السند');
    const img=document.createElement('img');img.src=src;img.alt='صورة السند';
    const b=document.createElement('button');b.type='button';b.textContent='إغلاق';
    const close=()=>{box.remove();document.removeEventListener('keydown',esc)};const esc=e=>{if(e.key==='Escape')close()};
    b.addEventListener('click',close);box.addEventListener('click',e=>{if(e.target===box)close()});
    document.addEventListener('keydown',esc);box.append(img,b);document.body.append(box);b.focus();
  }

  /* ---------- calculator ---------- */
  let qRate=null;
  function calcRate(){
    if(qRate==null){
      if(ADMIN) qRate=S.rate;
      else{const c=clientsOf(current).find(c=>c.rate!=null);qRate=c?c.rate:null}
    }
    drawPresets($('q-presets'),qRate,v=>{qRate=v;calcRate()},qRate);qcalc();
  }
  function qcalc(){
    const a=+$('q-amount').value||0;const rr=+qRate||0;const p=Math.round(a*rr)/100;
    $('q-profit').textContent=fmt(p)+' ('+rr+'٪)';$('q-total').textContent=fmt(a+p);
  }
  $('q-amount').addEventListener('input',qcalc);
  const KEYS=[['C','fn'],['⌫','fn'],['%','op'],['÷','op'],['7'],['8'],['9'],['×','op'],['4'],['5'],['6'],['−','op'],['1'],['2'],['3'],['+','op'],['0','wide'],['.'],['=','eq']];
  let expr='';
  function evalExpr(e){
    const t=e.replace(/×/g,'*').replace(/÷/g,'/').replace(/−/g,'-');
    const toks=t.match(/\d*\.?\d+%?|[-+*/]/g)||[];const vals=[],ops=[];const prec={'+':1,'-':1,'*':2,'/':2};
    const ap=()=>{const o=ops.pop(),b=vals.pop(),a=vals.pop();if(a==null||b==null) throw 0;vals.push(o==='+'?a+b:o==='-'?a-b:o==='*'?a*b:(b===0?NaN:a/b))};
    let expectNum=true,neg=false;
    for(const k of toks){
      if(k.length===1&&'+-*/'.includes(k)){if(expectNum&&k==='-'){neg=!neg;continue}if(expectNum) throw 0;while(ops.length&&prec[ops[ops.length-1]]>=prec[k]) ap();ops.push(k);expectNum=true}
      else{let v=parseFloat(k);if(k.endsWith('%'))v=v/100;if(neg){v=-v;neg=false}vals.push(v);expectNum=false}
    }
    while(ops.length) ap();if(vals.length!==1||!isFinite(vals[0])) throw 0;return Math.round(vals[0]*1e10)/1e10;
  }
  function show(){$('c-ex').textContent='';$('c-out').textContent=expr||'0'}
  function press(k){
    if(k==='C'){expr='';return show()}
    if(k==='⌫'){expr=expr.slice(0,-1);return show()}
    if(k==='='){try{const v=evalExpr(expr);$('c-ex').textContent=expr+' =';expr=String(v);$('c-out').textContent=v.toLocaleString('en-US',{maximumFractionDigits:10})}catch(e){$('c-out').textContent='خطأ'}return}
    if('÷×−+'.includes(k)&&expr&&'÷×−+'.includes(expr.slice(-1))) expr=expr.slice(0,-1);
    if(k==='%'&&!/\d$/.test(expr)) return;
    expr+=k;show();
  }
  for(const [k,c] of KEYS){const b=document.createElement('button');b.type='button';b.textContent=k;if(c)b.className=c;b.setAttribute('aria-label',k);b.addEventListener('click',()=>press(k));$('keys').append(b)}
  const calcEl=$('calc'),fab=$('calc-open');
  function toggleCalc(open){calcEl.hidden=!open;fab.setAttribute('aria-expanded',String(open));if(open){calcRate();$('q-amount').focus()}}
  fab.addEventListener('click',()=>toggleCalc(calcEl.hidden));
  $('calc-close').addEventListener('click',()=>{toggleCalc(false);fab.focus()});
  document.addEventListener('keydown',e=>{
    if(calcEl.hidden||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
    const map={'*':'×','/':'÷','-':'−','+':'+','Enter':'=','=':'=','Backspace':'⌫','Escape':'C','%':'%','.':'.'};
    if(/^\d$/.test(e.key)){press(e.key);e.preventDefault()}else if(map[e.key]){press(map[e.key]);e.preventDefault()}
  });

  /* ---------- start + refresh ---------- */
  load();
  setInterval(()=>{
    if(document.hidden) return;
    const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')) return;
    if(!$('acct-modal').hidden||!$('pw-modal').hidden) return;
    load();
  },30000);
})();
