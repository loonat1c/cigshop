firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let PRODUCTS = [];          // кэш ассортимента [{id,name,packSize,packPrice,stickPrice,costPrice,archived}]
let TODAY_ID = dateId(new Date());  // реальная сегодняшняя дата
let ACTIVE_DAY = TODAY_ID;          // день, который сейчас показан на экране (может быть архивный)
let ACTIVE_CONTEXT = 'today';       // 'today' | 'archive'
let ACTIVE_DOC = null;              // данные ACTIVE_DAY из Firestore
let PURCHASES = [];                 // закупки ACTIVE_DAY

// ---------- УТИЛИТЫ ----------
function dateId(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function dateLabel(id){
  const [y,m,d]=id.split('-');
  return `${d}.${m}.${y}`;
}
function money(n){
  return (Math.round(n*100)/100).toLocaleString('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2});
}
function sticks(packs, loose, packSize){
  return (Number(packs)||0)*packSize + (Number(loose)||0);
}
function activeProducts(){ return PRODUCTS.filter(p=>!p.archived); }
function productById(id){ return PRODUCTS.find(p=>p.id===id); }

// ---------- AUTH ----------
document.getElementById('loginForm').addEventListener('submit', e=>{
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent='';
  auth.signInWithEmailAndPassword(email, pass).catch(err=>{
    errEl.textContent = 'Не удалось войти: проверь почту и пароль';
  });
});
document.getElementById('logoutBtn').addEventListener('click', ()=> auth.signOut());

auth.onAuthStateChanged(user=>{
  if(user){
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    boot();
  } else {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
  }
});

async function boot(){
  document.getElementById('topDate').textContent = dateLabel(TODAY_ID);
  await loadProducts();
  await loadToday();
}

// ---------- НАВИГАЦИЯ ----------
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
    document.getElementById('view-'+view).classList.remove('hidden');
    if(view==='today') loadToday();          // сброс на реальный сегодняшний день
    if(view==='products') renderProducts();
    if(view==='archive') renderArchiveList();
  });
});

// ---------- МОДАЛКА ----------
const modalOverlay = document.getElementById('modalOverlay');
const modalBody = document.getElementById('modalBody');
document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e=>{ if(e.target===modalOverlay) closeModal(); });
function openModal(title, html){
  document.getElementById('modalTitle').textContent = title;
  modalBody.innerHTML = html;
  modalOverlay.classList.remove('hidden');
}
function closeModal(){ modalOverlay.classList.add('hidden'); modalBody.innerHTML=''; }

// =================================================================
// АССОРТИМЕНТ
// =================================================================
async function loadProducts(){
  const snap = await db.collection('products').orderBy('order','asc').get();
  PRODUCTS = snap.docs.map(d=>({id:d.id, ...d.data()}));
}

function renderProducts(){
  const el = document.getElementById('productsList');
  if(!activeProducts().length){
    el.innerHTML = `<div class="card">Ассортимент пуст. Добавь первый товар кнопкой «+ Товар».</div>`;
    return;
  }
  el.innerHTML = activeProducts().map(p=>`
    <div class="product-row">
      <div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="meta">пачка ${p.packSize} шт · ${money(p.packPrice)} / пачка · ${money(p.stickPrice)} / шт</div>
      </div>
      <button class="edit" data-id="${p.id}">Изм.</button>
    </div>
  `).join('');
  el.querySelectorAll('.edit').forEach(b=>b.addEventListener('click', ()=>openProductForm(b.dataset.id)));
}

document.getElementById('addProductBtn').addEventListener('click', ()=>openProductForm(null));

function openProductForm(id){
  const p = id ? productById(id) : null;
  openModal(p?'Изменить товар':'Новый товар', `
    <div class="field"><label>Название</label><input id="pf-name" value="${p?escapeHtml(p.name):''}" placeholder="Marlboro Red"></div>
    <div class="field-row">
      <div class="field"><label>Штук в пачке</label><input id="pf-size" type="number" value="${p?p.packSize:20}"></div>
      <div class="field"><label>Цена за пачку</label><input id="pf-packprice" type="number" value="${p?p.packPrice:''}"></div>
    </div>
    <div class="field"><label>Цена за 1 шт (вразвес)</label><input id="pf-stickprice" type="number" value="${p?p.stickPrice:''}" placeholder="можно дороже, чем пачка/шт"></div>
    <div class="field"><label>Закупочная цена за пачку (необязательно, для прибыли)</label><input id="pf-cost" type="number" value="${p&&p.costPrice?p.costPrice:''}"></div>
    <button id="pf-save" class="btn btn-primary btn-block">Сохранить</button>
    ${p?'<button id="pf-archive" class="btn btn-outline btn-block" style="margin-top:8px;">Убрать из ассортимента</button>':''}
  `);
  document.getElementById('pf-packprice').addEventListener('change', ()=>{
    const sf=document.getElementById('pf-stickprice');
    if(!sf.value){
      const size=Number(document.getElementById('pf-size').value)||1;
      const pp=Number(document.getElementById('pf-packprice').value)||0;
      sf.value = Math.ceil(pp/size);
    }
  });
  document.getElementById('pf-save').addEventListener('click', async ()=>{
    const data = {
      name: document.getElementById('pf-name').value.trim(),
      packSize: Number(document.getElementById('pf-size').value)||20,
      packPrice: Number(document.getElementById('pf-packprice').value)||0,
      stickPrice: Number(document.getElementById('pf-stickprice').value)||0,
      costPrice: Number(document.getElementById('pf-cost').value)||0,
      archived: false,
      order: p ? p.order : Date.now()
    };
    if(!data.name){ alert('Введи название'); return; }
    if(p) await db.collection('products').doc(p.id).update(data);
    else await db.collection('products').add(data);
    await loadProducts();
    renderProducts();
    closeModal();
    loadActiveDay();
  });
  if(p){
    document.getElementById('pf-archive').addEventListener('click', async ()=>{
      if(!confirm('Убрать товар из активного ассортимента? Прошлые дни это не затронет.')) return;
      await db.collection('products').doc(p.id).update({archived:true});
      await loadProducts();
      renderProducts();
      closeModal();
    });
  }
}

// =================================================================
// РАБОЧИЙ ДЕНЬ (общая логика — и для "Сегодня", и для правки архивных дней)
// =================================================================
function activeContainer(){
  return document.getElementById(ACTIVE_CONTEXT==='today' ? 'todayContent' : 'archiveDetail');
}

async function loadToday(){
  ACTIVE_DAY = TODAY_ID;
  ACTIVE_CONTEXT = 'today';
  await loadActiveDay();
}

async function loadActiveDay(){
  const el = activeContainer();
  el.innerHTML = `<div class="loader">Загрузка…</div>`;
  try{
    const doc = await db.collection('days').doc(ACTIVE_DAY).get();
    ACTIVE_DOC = doc.exists ? doc.data() : null;
    if(ACTIVE_DOC && ACTIVE_DOC.morning && !ACTIVE_DOC.closed){
      const psnap = await db.collection('days').doc(ACTIVE_DAY).collection('purchases').orderBy('time','asc').get();
      PURCHASES = psnap.docs.map(d=>({id:d.id, ...d.data()}));
    } else {
      PURCHASES = [];
    }
    await renderDayWorkflow();
  }catch(e){
    console.error('loadActiveDay error', e);
    el.innerHTML = `<div class="card">Не удалось загрузить день: ${escapeHtml(e.message||String(e))}</div>`;
  }
}

async function renderDayWorkflow(){
  const el = activeContainer();
  const statusEl = document.getElementById('topStatus');
  const isToday = ACTIVE_CONTEXT === 'today';
  const backBtn = !isToday ? `<button id="backToArchiveBtn" class="btn btn-outline btn-sm" style="margin-bottom:12px;">← Ко всем дням</button>` : '';

  function bindBackBtn(){
    const b = document.getElementById('backToArchiveBtn');
    if(b) b.addEventListener('click', renderArchiveList);
  }

  if(!activeProducts().length){
    el.innerHTML = backBtn + `<div class="card">Сначала добавь товары во вкладке «Ассортимент» — потом можно будет открыть день.</div>`;
    if(isToday) statusEl.textContent='Касса';
    bindBackBtn();
    return;
  }

  // День закрыт — чек + действия (изменить / очистить)
  if(ACTIVE_DOC && ACTIVE_DOC.closed){
    if(isToday) statusEl.textContent='День закрыт';
    el.innerHTML = backBtn + renderReceipt(ACTIVE_DOC.summary, ACTIVE_DAY) + `
      <div class="card">
        <button id="reopenDayBtn" class="btn btn-outline btn-block">Изменить день (переоткрыть)</button>
        <button id="clearDayBtn" class="btn btn-danger btn-block" style="margin-top:8px;">Очистить день полностью</button>
      </div>
    `;
    bindBackBtn();
    document.getElementById('reopenDayBtn').addEventListener('click', reopenDay);
    document.getElementById('clearDayBtn').addEventListener('click', clearDay);
    return;
  }

  // Утренний остаток ещё не внесён — форма открытия дня
  if(!ACTIVE_DOC || !ACTIVE_DOC.morning){
    if(isToday) statusEl.textContent='Открыть день';
    const prevMorning = isToday ? await suggestMorning() : {};
    el.innerHTML = backBtn + `
      <div class="card">Внеси утренний остаток по каждому товару — сколько целых пачек и отдельных сигарет на месте сейчас.</div>
      <div id="morningForm" class="count-table">
        ${activeProducts().map(p=>countItemHtml(p,'m',prevMorning[p.id])).join('')}
      </div>
      <button id="saveMorningBtn" class="btn btn-accent btn-block" style="margin-top:14px;">${isToday?'Открыть день':'Сохранить и открыть день'}</button>
    `;
    bindBackBtn();
    document.getElementById('saveMorningBtn').addEventListener('click', saveMorning);
    return;
  }

  // День открыт — рабочий дашборд
  if(isToday) statusEl.textContent='День открыт';
  el.innerHTML = backBtn + `
    <div class="stat-row">
      <div class="stat"><div class="label">Товаров учтено</div><div class="value">${activeProducts().length}</div></div>
      <div class="stat"><div class="label">Закупок за день</div><div class="value">${PURCHASES.length}</div></div>
    </div>
    <details class="card">
      <summary>Ассортимент и что отмечено (${activeProducts().length})</summary>
      <div class="list" style="margin-top:10px;">
        ${activeProducts().map(p=>{
          const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
          const purchasedSticks = PURCHASES.filter(pu=>pu.productId===p.id).reduce((s,pu)=>s+sticks(pu.packs,pu.loose,p.packSize),0);
          const purchasedPacks = Math.floor(purchasedSticks/p.packSize);
          const purchasedLoose = purchasedSticks % p.packSize;
          return `
            <div class="product-row">
              <div>
                <div class="name">${escapeHtml(p.name)}</div>
                <div class="meta">утро: ${m.packs} пач. + ${m.loose} шт${purchasedSticks?` · докуплено: ${purchasedPacks} пач. + ${purchasedLoose} шт`:''} · цена: ${money(p.stickPrice)}/шт</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </details>
    <button id="addPurchaseBtn" class="btn btn-outline btn-block">+ Внести закупку</button>
    <div id="purchaseListWrap" style="margin-top:14px;">
      ${PURCHASES.length? `<div class="card"><div style="font-weight:600;margin-bottom:6px;font-size:13px;">Закупки за день</div>${PURCHASES.map(pu=>`
        <div class="purchase-row"><span>${escapeHtml(productById(pu.productId)?.name||'—')}</span><span>${pu.packs} пач. + ${pu.loose} шт</span></div>
      `).join('')}</div>` : ''}
    </div>
    <button id="closeDayBtn" class="btn btn-primary btn-block" style="margin-top:18px;">Закрыть день (вечерний подсчёт)</button>
    <button id="clearDayBtn" class="btn btn-danger btn-block" style="margin-top:8px;">Очистить день полностью</button>
  `;
  bindBackBtn();
  document.getElementById('addPurchaseBtn').addEventListener('click', openPurchaseForm);
  document.getElementById('closeDayBtn').addEventListener('click', renderEveningForm);
  document.getElementById('clearDayBtn').addEventListener('click', clearDay);
}

function countItemHtml(p, prefix, prefill){
  const packs = prefill?prefill.packs:0, loose = prefill?prefill.loose:0;
  return `
    <div class="count-item" data-pid="${p.id}">
      <div class="pname">${escapeHtml(p.name)} <span style="color:var(--muted);font-weight:400;">(пачка = ${p.packSize} шт)</span></div>
      <div class="inputs">
        <input type="number" min="0" class="${prefix}-packs" value="${packs}">
        <span class="unit">пачек</span>
        <input type="number" min="0" class="${prefix}-loose" value="${loose}">
        <span class="unit">шт</span>
      </div>
    </div>
  `;
}

async function suggestMorning(){
  // подтягиваем вечерний остаток предыдущего закрытого дня как основу утреннего
  // (сортируем на клиенте, чтобы не требовался составной индекс Firestore)
  try{
    const snap = await db.collection('days').where('closed','==',true).get();
    if(snap.empty) return {};
    const docs = snap.docs.sort((a,b)=> b.id.localeCompare(a.id));
    return docs[0].data().evening || {};
  }catch(e){
    console.error('suggestMorning error', e);
    return {};
  }
}

async function saveMorning(){
  const data = {};
  activeProducts().forEach(p=>{
    const item = document.querySelector(`.count-item[data-pid="${p.id}"]`);
    data[p.id] = { packs:Number(item.querySelector('.m-packs').value)||0, loose:Number(item.querySelector('.m-loose').value)||0 };
  });
  await db.collection('days').doc(ACTIVE_DAY).set({
    morning:data, morningSavedAt:firebase.firestore.FieldValue.serverTimestamp(), closed:false
  }, {merge:true});
  await loadActiveDay();
}

function openPurchaseForm(){
  openModal('Внести закупку', `
    <div class="field"><label>Товар</label>
      <select id="pu-product">${activeProducts().map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
    </div>
    <div class="field-row">
      <div class="field"><label>Пачек</label><input id="pu-packs" type="number" min="0" value="0"></div>
      <div class="field"><label>Штук (россыпь)</label><input id="pu-loose" type="number" min="0" value="0"></div>
    </div>
    <div class="field"><label>Заметка (необязательно)</label><input id="pu-note" placeholder="напр. довезли с оптовой базы"></div>
    <button id="pu-save" class="btn btn-primary btn-block">Добавить</button>
  `);
  document.getElementById('pu-save').addEventListener('click', async ()=>{
    const entry = {
      productId: document.getElementById('pu-product').value,
      packs: Number(document.getElementById('pu-packs').value)||0,
      loose: Number(document.getElementById('pu-loose').value)||0,
      note: document.getElementById('pu-note').value.trim(),
      time: firebase.firestore.FieldValue.serverTimestamp()
    };
    if(entry.packs===0 && entry.loose===0){ alert('Укажи количество'); return; }
    await db.collection('days').doc(ACTIVE_DAY).collection('purchases').add(entry);
    closeModal();
    await loadActiveDay();
  });
}

function renderEveningForm(){
  const isToday = ACTIVE_CONTEXT === 'today';
  if(isToday) document.getElementById('topStatus').textContent='Вечерний подсчёт';
  const el = activeContainer();
  const prevEvening = ACTIVE_DOC && ACTIVE_DOC.evening ? ACTIVE_DOC.evening : {};
  el.innerHTML = `
    <div class="card">Посчитай, сколько пачек и отдельных сигарет осталось по каждому товару прямо сейчас.</div>
    <div id="eveningForm" class="count-table">
      ${activeProducts().map(p=>countItemHtml(p,'e',prevEvening[p.id])).join('')}
    </div>
    <button id="calcSummaryBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Посчитать итог дня</button>
  `;
  document.getElementById('calcSummaryBtn').addEventListener('click', showDaySummaryPreview);
}

function computeSummary(evening){
  const perProduct = {};
  let totalExpected = 0, totalProfit = 0, anomalies=[];
  activeProducts().forEach(p=>{
    const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
    const purchasedSticks = PURCHASES.filter(pu=>pu.productId===p.id)
      .reduce((s,pu)=>s+sticks(pu.packs,pu.loose,p.packSize),0);
    const morningSticks = sticks(m.packs,m.loose,p.packSize);
    const eveningSticks = sticks(evening[p.id].packs, evening[p.id].loose, p.packSize);
    const available = morningSticks + purchasedSticks;
    let sold = available - eveningSticks;
    if(sold < 0){ anomalies.push(p.name); }
    const soldClamped = Math.max(0,sold);
    const revenue = soldClamped * p.stickPrice;
    const cost = p.costPrice ? soldClamped * (p.costPrice/p.packSize) : 0;
    totalExpected += revenue;
    totalProfit += (revenue-cost);
    // цена фиксируется на момент закрытия дня — если позже цену товара изменят,
    // в архиве всё равно останется та, что была в этот день
    perProduct[p.id] = { name:p.name, morningSticks, purchasedSticks, eveningSticks, sold, revenue, pricePerStick:p.stickPrice };
  });
  return { perProduct, totalExpected, totalProfit, anomalies };
}

function showDaySummaryPreview(){
  const evening = {};
  activeProducts().forEach(p=>{
    const item = document.querySelector(`.count-item[data-pid="${p.id}"]`);
    evening[p.id] = { packs:Number(item.querySelector('.e-packs').value)||0, loose:Number(item.querySelector('.e-loose').value)||0 };
  });
  const summary = computeSummary(evening);
  const el = activeContainer();
  const prevCash = (ACTIVE_DOC && ACTIVE_DOC.summary && ACTIVE_DOC.summary.actualCash!==undefined) ? ACTIVE_DOC.summary.actualCash : '';
  el.innerHTML = `
    ${summary.anomalies.length?`<div class="card" style="border-color:var(--danger);color:var(--danger);">Внимание: у ${summary.anomalies.join(', ')} остаток вечером больше, чем должно быть в наличии. Перепроверь подсчёт или закупки.</div>`:''}
    <div class="card">
      <div style="font-weight:600;margin-bottom:8px;">Ожидаемая выручка: <span style="font-family:var(--font-mono);">${money(summary.totalExpected)}</span></div>
      <div class="field"><label>Сколько наличных фактически на руках</label><input id="actualCash" type="number" placeholder="0" value="${prevCash}"></div>
      <button id="confirmCloseBtn" class="btn btn-primary btn-block">Подтвердить и закрыть день</button>
      <button id="backToEveningBtn" class="btn btn-outline btn-block" style="margin-top:8px;">Назад, исправить подсчёт</button>
    </div>
  `;
  document.getElementById('backToEveningBtn').addEventListener('click', renderEveningForm);
  document.getElementById('confirmCloseBtn').addEventListener('click', async ()=>{
    const actualCash = Number(document.getElementById('actualCash').value)||0;
    const diff = actualCash - summary.totalExpected;
    const fullSummary = { ...summary, actualCash, diff };
    await db.collection('days').doc(ACTIVE_DAY).set({
      evening, closed:true, closedAt:firebase.firestore.FieldValue.serverTimestamp(), summary:fullSummary
    }, {merge:true});
    await loadActiveDay();
  });
}

function renderReceipt(summary, dayId){
  const diffClass = Math.abs(summary.diff) < 0.01 ? 'ok' : (summary.diff < 0 ? 'bad':'ok');
  return `
    <div class="receipt">
      <div class="r-title">Касса</div>
      <div class="r-date">${dateLabel(dayId)}</div>
      ${Object.values(summary.perProduct).map(pp=>`
        <div class="r-line"><span class="r-name">${escapeHtml(pp.name)} × ${Math.max(0,pp.sold)} по ${money(pp.pricePerStick||0)}</span><span class="r-num">${money(pp.revenue)}</span></div>
      `).join('')}
      <hr>
      <div class="r-total"><span>Ожидалось</span><span>${money(summary.totalExpected)}</span></div>
      <div class="r-total"><span>На руках</span><span>${money(summary.actualCash)}</span></div>
      ${summary.totalProfit?`<div class="r-line"><span class="r-name">Прибыль (оценка)</span><span class="r-num">${money(summary.totalProfit)}</span></div>`:''}
      <div class="r-diff ${diffClass}">
        ${Math.abs(summary.diff)<0.01 ? 'Сходится' : (summary.diff<0 ? `Недостача: ${money(Math.abs(summary.diff))}` : `Излишек: ${money(summary.diff)}`)}
      </div>
    </div>
  `;
}

// ---------- переоткрыть / очистить день ----------
async function reopenDay(){
  if(!confirm(`Переоткрыть день ${dateLabel(ACTIVE_DAY)}? Можно будет добавить закупки и заново сделать вечерний подсчёт.`)) return;
  await db.collection('days').doc(ACTIVE_DAY).set({ closed:false }, {merge:true});
  await loadActiveDay();
}

async function clearDay(){
  if(!confirm(`Полностью очистить день ${dateLabel(ACTIVE_DAY)}? Все данные за этот день (остатки, закупки, итог) удалятся без возможности восстановить.`)) return;
  const dayRef = db.collection('days').doc(ACTIVE_DAY);
  const psnap = await dayRef.collection('purchases').get();
  const batch = db.batch();
  psnap.docs.forEach(d=>batch.delete(d.ref));
  batch.delete(dayRef);
  await batch.commit();
  if(ACTIVE_CONTEXT==='archive'){
    renderArchiveList();
  } else {
    await loadActiveDay();
  }
}

// =================================================================
// АРХИВ
// =================================================================
async function renderArchiveList(){
  ACTIVE_CONTEXT = 'today'; // на случай если правили архивный день — сбрасываем контекст
  document.getElementById('archiveDetail').classList.add('hidden');
  document.getElementById('archiveDetail').innerHTML='';
  const listEl = document.getElementById('archiveList');
  listEl.classList.remove('hidden');
  listEl.innerHTML = `<div class="loader">Загрузка…</div>`;
  let snap;
  try{
    // без orderBy на сервере — не требует составного индекса Firestore
    snap = await db.collection('days').where('closed','==',true).get();
  }catch(e){
    console.error('archive load error', e);
    listEl.innerHTML = `<div class="card">Не удалось загрузить архив: ${escapeHtml(e.message||String(e))}</div>`;
    return;
  }
  if(snap.empty){ listEl.innerHTML = `<div class="card">Пока нет закрытых дней.</div>`; return; }
  const docs = snap.docs.sort((a,b)=> b.id.localeCompare(a.id)).slice(0,60);
  listEl.innerHTML = docs.map(d=>{
    const s = d.data().summary;
    const cls = Math.abs(s.diff)<0.01?'ok':(s.diff<0?'bad':'ok');
    const label = Math.abs(s.diff)<0.01?'сходится':(s.diff<0?`−${money(Math.abs(s.diff))}`:`+${money(s.diff)}`);
    return `<div class="archive-row" data-id="${d.id}"><span class="adate">${dateLabel(d.id)}</span><span class="adiff ${cls}">${label}</span></div>`;
  }).join('');
  listEl.querySelectorAll('.archive-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      ACTIVE_DAY = row.dataset.id;
      ACTIVE_CONTEXT = 'archive';
      listEl.classList.add('hidden');
      document.getElementById('archiveDetail').classList.remove('hidden');
      loadActiveDay();
    });
  });
}

// ---------- ХЕЛПЕР ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
