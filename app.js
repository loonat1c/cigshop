let auth, db;
try{
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
}catch(e){
  console.error('Firebase init error', e);
  document.getElementById('loginError').textContent = 'Ошибка инициализации Firebase: ' + (e.message||e);
}

let PRODUCTS = [];          // кэш ассортимента [{id,name,packSize,packPrice,stickPrice,costPrice,archived}]
let TODAY_ID = dateId(new Date());  // реальная сегодняшняя дата
let ACTIVE_DAY = TODAY_ID;          // день, который сейчас показан на экране (может быть архивный или незакрытый с прошлой даты)
let ACTIVE_CONTEXT = 'today';       // 'today' | 'archive'
let ACTIVE_DOC = null;              // данные ACTIVE_DAY из Firestore
let PURCHASES = [];                 // закупки ACTIVE_DAY
let EXPENSES = [];                  // расходы (не связанные с сигаретами) ACTIVE_DAY

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

// нормализация закупки: новая форма — {items:[{productId,packs,cost,sell}], totalPaid,...}
// старая форма (одна позиция) — {productId, packs, loose, paidAmount}
function purchaseItems(pu){
  if(pu.items) return pu.items;
  return [{ productId: pu.productId, packs: pu.packs||0, looseLegacy: pu.loose||0 }];
}
function purchasePaid(pu){
  return Number(pu.totalPaid!==undefined ? pu.totalPaid : pu.paidAmount) || 0;
}
function itemCost(it){
  // цена закупки за пачку. у самых старых записей поле называлось "price" — трактуем его как закупочную
  return it.cost!==undefined ? Number(it.cost)||0 : Number(it.price)||0;
}
function itemSell(it){
  // цена продажи за пачку — берём сохранённую на момент закупки, иначе текущую цену товара
  return it.sell!==undefined ? Number(it.sell)||0 : (productById(it.productId)?.packPrice||0);
}
function purchasedSticksForProduct(pid){
  const p = productById(pid);
  if(!p) return 0;
  return PURCHASES.reduce((s,pu)=> s + purchaseItems(pu)
    .filter(it=>it.productId===pid)
    .reduce((s2,it)=> s2 + (Number(it.packs)||0)*p.packSize + (Number(it.looseLegacy)||0), 0), 0);
}

// товары, которые реально в деле сегодня: были на утро или что-то докупили.
// товары с 0/0 на утро и без докупки не засоряют экран дня (но остаются в ассортименте).
function dayProducts(){
  if(!ACTIVE_DOC || !ACTIVE_DOC.morning) return activeProducts();
  return activeProducts().filter(p=>{
    const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
    const morningHas = (Number(m.packs)||0) > 0 || (Number(m.loose)||0) > 0;
    return morningHas || purchasedSticksForProduct(p.id) > 0;
  });
}

// подсказка цены за штуку на основе уже введённых товаров: считаем средний коэффициент
// наценки (цена/шт ÷ цена пачки/размер пачки) по существующему ассортименту и применяем его
function suggestStickPrice(packPrice, packSize){
  const refs = activeProducts().filter(p=>p.packPrice>0 && p.packSize>0 && p.stickPrice>0);
  if(refs.length){
    const ratios = refs.map(p => p.stickPrice / (p.packPrice/p.packSize));
    const avgRatio = ratios.reduce((a,b)=>a+b,0) / ratios.length;
    const raw = (packPrice/packSize) * avgRatio;
    return Math.max(1, Math.round(raw/100)*100);
  }
  return Math.ceil(packPrice/packSize);
}

// ---------- AUTH ----------
document.getElementById('loginForm').addEventListener('submit', e=>{
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent='';
  auth.signInWithEmailAndPassword(email, pass).catch(err=>{
    console.error('Login error', err.code, err.message);
    errEl.textContent = `Не удалось войти (${err.code}): ${err.message}`;
  });
});
document.getElementById('logoutBtn').addEventListener('click', ()=> auth.signOut());

auth.onAuthStateChanged(user=>{
  if(user){
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    boot().catch(e=>{
      console.error('boot error', e);
      document.getElementById('todayContent').innerHTML = `<div class="card">Ошибка запуска: ${escapeHtml(e.message||String(e))}. Проверь правила доступа Firestore (Rules) и что в firebase-config.js указан правильный проект.</div>`;
    });
  } else {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
  }
});

async function boot(){
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
    if(view==='today') loadToday();
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
  const snap = await db.collection('products').get();
  PRODUCTS = snap.docs.map(d=>({id:d.id, ...d.data()}))
    .sort((a,b)=> (a.name||'').localeCompare(b.name||'', 'ru'));
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
    <div class="field"><label>Цена за 1 шт (вразвес)</label><input id="pf-stickprice" type="number" value="${p?p.stickPrice:''}" placeholder="подставится автоматически"></div>
    <div class="field"><label>Закупочная цена за пачку (необязательно, для прибыли)</label><input id="pf-cost" type="number" value="${p&&p.costPrice?p.costPrice:''}"></div>
    <button id="pf-save" class="btn btn-primary btn-block">Сохранить</button>
    ${p?'<button id="pf-archive" class="btn btn-outline btn-block" style="margin-top:8px;">Убрать из ассортимента</button>':''}
  `);
  function resuggest(){
    const sf=document.getElementById('pf-stickprice');
    if(!sf.value){
      const size=Number(document.getElementById('pf-size').value)||1;
      const pp=Number(document.getElementById('pf-packprice').value)||0;
      if(pp>0) sf.value = suggestStickPrice(pp, size);
    }
  }
  document.getElementById('pf-packprice').addEventListener('change', resuggest);
  document.getElementById('pf-size').addEventListener('change', resuggest);
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
  ACTIVE_CONTEXT = 'today';
  ACTIVE_DAY = TODAY_ID;
  // если есть незакрытый день с прошлой даты (не успели закрыть до полуночи) — продолжаем именно его,
  // а не начинаем новый пустой сегодняшний день
  try{
    const snap = await db.collection('days').where('closed','==',false).get();
    const openDays = snap.docs.filter(d=> d.data().morning);
    if(openDays.length){
      openDays.sort((a,b)=> b.id.localeCompare(a.id));
      ACTIVE_DAY = openDays[0].id;
    }
  }catch(e){
    console.error('find open day error', e);
  }
  document.getElementById('topDate').textContent = dateLabel(ACTIVE_DAY);
  await loadActiveDay();
}

async function loadActiveDay(){
  const el = activeContainer();
  el.innerHTML = `<div class="loader">Загрузка…</div>`;
  try{
    const doc = await db.collection('days').doc(ACTIVE_DAY).get();
    ACTIVE_DOC = doc.exists ? doc.data() : null;
    if(ACTIVE_DOC && ACTIVE_DOC.morning && !ACTIVE_DOC.closed){
      const dayRef = db.collection('days').doc(ACTIVE_DAY);
      const [psnap, esnap] = await Promise.all([
        dayRef.collection('purchases').orderBy('time','asc').get(),
        dayRef.collection('expenses').orderBy('time','asc').get()
      ]);
      PURCHASES = psnap.docs.map(d=>({id:d.id, ...d.data()}));
      EXPENSES = esnap.docs.map(d=>({id:d.id, ...d.data()}));
    } else {
      PURCHASES = [];
      EXPENSES = [];
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
  const staleBanner = (isToday && ACTIVE_DAY !== TODAY_ID)
    ? `<div class="card" style="border-color:var(--gold);"><b>Незакрытый день за ${dateLabel(ACTIVE_DAY)}</b><div style="margin-top:4px;color:var(--muted);font-size:13px;">Сегодня уже ${dateLabel(TODAY_ID)}. Закрой этот день, когда будет удобно — новый сегодняшний день откроется отдельно, ничего не сотрётся.</div></div>`
    : '';

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
    el.innerHTML = backBtn + staleBanner + `
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
  const dp = dayProducts();
  const running = computeRunningTotals();
  el.innerHTML = backBtn + staleBanner + `
    <div class="stat-row">
      <div class="stat"><div class="label">В деле сегодня</div><div class="value">${dp.length}</div></div>
      <div class="stat"><div class="label">Закупок</div><div class="value">${PURCHASES.length}</div></div>
      <div class="stat"><div class="label">Расходов</div><div class="value">${EXPENSES.length}</div></div>
    </div>
    <div class="receipt">
      <div class="r-title">Промежуточный итог</div>
      <div class="r-line"><span class="r-name">Ассортимент (по цене продажи)</span><span class="r-num">${money(running.assortmentValue)}</span></div>
      <div class="r-line"><span class="r-name">Закуплено из кассы</span><span class="r-num">−${money(running.totalPurchaseCash)}</span></div>
      <div class="r-line"><span class="r-name">Расходы</span><span class="r-num">−${money(running.totalExpenses)}</span></div>
    </div>
    <div style="height:12px;"></div>
    <details class="card">
      <summary>Ассортимент дня (${dp.length})</summary>
      <div style="margin-top:10px;">${renderDayAssortmentReceipt(dp)}</div>
    </details>
    <button id="editMorningBtn" class="btn btn-outline btn-block" style="margin-top:8px;">Изменить утренний остаток</button>
    <div class="field-row" style="margin-top:10px;">
      <button id="addPurchaseBtn" class="btn btn-outline" style="flex:1;">+ Закупка</button>
      <button id="addExpenseBtn" class="btn btn-outline" style="flex:1;">+ Расход</button>
    </div>
    <div id="purchaseListWrap" style="margin-top:4px;">
      ${PURCHASES.length? `<div class="receipt"><div class="r-title">Закупки за день</div>${PURCHASES.map((pu,idx)=> purchaseBatchHtml(pu) + (idx<PURCHASES.length-1?'<hr>':'')).join('')}</div>` : ''}
      ${EXPENSES.length? `<div class="card" style="margin-top:12px;"><div style="font-weight:600;margin-bottom:6px;font-size:13px;">Расходы за день</div>${EXPENSES.map(ex=>`
        <div class="purchase-row"><span>${escapeHtml(ex.note||'Расход')}</span><span>${money(ex.amount)}</span></div>
      `).join('')}</div>` : ''}
    </div>
    <button id="closeDayBtn" class="btn btn-primary btn-block" style="margin-top:14px;">Закрыть день (вечерний подсчёт)</button>
    <button id="clearDayBtn" class="btn btn-danger btn-block" style="margin-top:8px;">Очистить день полностью</button>
  `;
  bindBackBtn();
  document.getElementById('editMorningBtn').addEventListener('click', renderMorningEditForm);
  document.getElementById('addPurchaseBtn').addEventListener('click', ()=>openPurchaseForm());
  document.getElementById('addExpenseBtn').addEventListener('click', openExpenseForm);
  document.getElementById('closeDayBtn').addEventListener('click', renderEveningForm);
  document.getElementById('clearDayBtn').addEventListener('click', clearDay);
  document.querySelectorAll('.edit-purchase').forEach(b=>b.addEventListener('click', ()=>openPurchaseForm(b.dataset.id)));
  document.querySelectorAll('.delete-purchase').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Удалить эту закупку из учёта дня?')) return;
    await db.collection('days').doc(ACTIVE_DAY).collection('purchases').doc(b.dataset.id).delete();
    await loadActiveDay();
  }));
}

// структурированная строка закупки: название, кол-во, закупочная и цена продажи, итог по закупке, правка/удаление
function purchaseBatchHtml(pu){
  const items = purchaseItems(pu);
  const paid = purchasePaid(pu);
  const rows = items.map(it=>{
    const p = productById(it.productId);
    const cost = itemCost(it), sell = itemSell(it);
    return `
      <div class="r-line"><span class="r-name">${escapeHtml(p?p.name:'—')} × ${it.packs||0} пач.${it.looseLegacy?` + ${it.looseLegacy} шт`:''}</span><span class="r-num">${money(cost*(it.packs||0))}</span></div>
      <div class="r-line r-sub"><span>закуп ${money(cost)}/пач · продажа ${money(sell)}/пач</span><span></span></div>
    `;
  }).join('');
  return `
    <div>
      ${rows}
      <div class="r-total" style="margin-top:2px;"><span>Итого закупки</span><span>${money(paid)}${pu.paidFromCash===false?' (не из кассы)':''}</span></div>
      ${pu.note?`<div class="r-sub" style="margin-top:2px;">${escapeHtml(pu.note)}</div>`:''}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-outline btn-sm edit-purchase" data-id="${pu.id}" style="flex:1;">Изменить</button>
        <button class="btn btn-danger btn-sm delete-purchase" data-id="${pu.id}" style="flex:1;">Удалить</button>
      </div>
    </div>
  `;
}

function renderDayAssortmentReceipt(dp){
  return `
    <div class="receipt">
      <div class="r-title">Ассортимент дня</div>
      <div class="r-date">${dateLabel(ACTIVE_DAY)}</div>
      ${dp.map(p=>{
        const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
        const purchasedSticks = purchasedSticksForProduct(p.id);
        const purchasedPacks = Math.floor(purchasedSticks/p.packSize);
        const purchasedLoose = purchasedSticks % p.packSize;
        return `
          <div class="r-line"><span class="r-name">${escapeHtml(p.name)}</span><span class="r-num">${m.packs} пач. + ${m.loose} шт</span></div>
          <div class="r-line r-sub"><span>пачка ${money(p.packPrice)} · шт ${money(p.stickPrice)}${purchasedSticks?` · докуплено ${purchasedPacks} пач.${purchasedLoose?` + ${purchasedLoose} шт`:''}`:''}</span><span></span></div>
        `;
      }).join('')}
    </div>
  `;
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

function renderMorningEditForm(){
  const el = activeContainer();
  el.innerHTML = `
    <div class="card">Поправь утренний остаток, если что-то забыли отметить в начале дня — это не докупка, а исправление исходных цифр.</div>
    <div id="morningForm" class="count-table">
      ${activeProducts().map(p=>countItemHtml(p,'m',ACTIVE_DOC.morning[p.id])).join('')}
    </div>
    <button id="saveMorningBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Сохранить изменения</button>
    <button id="cancelMorningEditBtn" class="btn btn-outline btn-block" style="margin-top:8px;">Отмена</button>
  `;
  document.getElementById('saveMorningBtn').addEventListener('click', saveMorning);
  document.getElementById('cancelMorningEditBtn').addEventListener('click', renderDayWorkflow);
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

// ---------- ЗАКУПКА (несколько позиций сразу, только пачками, с закупочной и продажной ценой) ----------
function openPurchaseForm(existingId){
  const existing = existingId ? PURCHASES.find(pu=>pu.id===existingId) : null;
  const prods = activeProducts();
  if(!prods.length){ alert('Сначала добавь товары в ассортимент'); return; }

  function defaultsFor(p){
    return { productId: p.id, packs: 1, cost: (p.costPrice&&p.costPrice>0)?p.costPrice:(p.packPrice||0), sell: p.packPrice||0 };
  }

  let rows = existing
    ? purchaseItems(existing).map(it=>({ productId: it.productId, packs: it.packs||0, cost: itemCost(it), sell: itemSell(it) }))
    : [defaultsFor(prods[0])];
  let totalEdited = !!existing;
  let manualTotal = existing ? purchasePaid(existing) : 0;
  let paidFromCash = existing ? (existing.paidFromCash!==false) : true;
  let noteVal = existing ? (existing.note||'') : '';

  function calcTotal(){
    return rows.reduce((s,r)=> s + (Number(r.packs)||0) * (Number(r.cost)||0), 0);
  }

  function render(){
    const total = totalEdited ? manualTotal : calcTotal();
    document.getElementById('modalTitle').textContent = existing ? 'Изменить закупку' : 'Внести закупку';
    modalBody.innerHTML = `
      <div id="rowsWrap">${rows.map((r,i)=>`
        <div class="field-row" style="align-items:flex-end;">
          <div class="field" style="flex:2;">
            <label>Товар</label>
            <select class="row-product" data-idx="${i}">${activeProducts().map(p=>`<option value="${p.id}" ${p.id===r.productId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <div class="field" style="flex:1;">
            <label>Пачек</label>
            <input type="number" min="0" class="row-packs" data-idx="${i}" value="${r.packs}">
          </div>
          <div class="field" style="flex:1;">
            <label>Закуп/пач.</label>
            <input type="number" min="0" class="row-cost" data-idx="${i}" value="${r.cost}">
          </div>
          ${rows.length>1?`<button class="row-remove btn btn-outline btn-sm" data-idx="${i}" style="margin-bottom:12px;">✕</button>`:''}
        </div>
        <div style="font-size:11.5px;color:var(--muted);margin:-6px 0 12px 2px;">продажа: ${money(r.sell)}/пач.</div>
      `).join('')}</div>
      <button id="addRowBtn" class="btn btn-outline btn-sm" style="margin-bottom:14px;">+ Добавить позицию</button>
      <div class="field"><label>Итого заплачено (считается автоматически по закупочной цене, можно поправить)</label><input id="pu-total" type="number" min="0" value="${total}"></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin:2px 0 14px;">
        <input type="checkbox" id="pu-fromcash" ${paidFromCash?'checked':''} style="width:auto;"> Оплачено из кассы (учитывать при подсчёте налички)
      </label>
      <div class="field"><label>Заметка (необязательно)</label><input id="pu-note" value="${escapeHtml(noteVal)}" placeholder="напр. довезли с оптовой базы"></div>
      <button id="pu-save" class="btn btn-primary btn-block">${existing?'Сохранить изменения':'Добавить закупку'}</button>
    `;
    modalOverlay.classList.remove('hidden');
    wire();
  }

  function updateTotalField(){
    if(!totalEdited){
      const t = document.getElementById('pu-total');
      if(t) t.value = calcTotal();
    }
  }

  function wire(){
    modalBody.querySelectorAll('.row-product').forEach(sel=>sel.addEventListener('change', e=>{
      const i = Number(e.target.dataset.idx);
      const p = productById(e.target.value);
      rows[i] = defaultsFor(p);
      render();
    }));
    modalBody.querySelectorAll('.row-packs').forEach(inp=>inp.addEventListener('input', e=>{
      rows[Number(e.target.dataset.idx)].packs = e.target.value;
      updateTotalField();
    }));
    modalBody.querySelectorAll('.row-cost').forEach(inp=>inp.addEventListener('input', e=>{
      rows[Number(e.target.dataset.idx)].cost = e.target.value;
      updateTotalField();
    }));
    modalBody.querySelectorAll('.row-remove').forEach(btn=>btn.addEventListener('click', e=>{
      rows.splice(Number(e.target.dataset.idx),1);
      render();
    }));
    document.getElementById('addRowBtn').addEventListener('click', ()=>{
      rows.push(defaultsFor(activeProducts()[0]));
      render();
    });
    document.getElementById('pu-total').addEventListener('input', e=>{
      totalEdited = true;
      manualTotal = Number(e.target.value)||0;
    });
    document.getElementById('pu-fromcash').addEventListener('change', e=>{ paidFromCash = e.target.checked; });
    document.getElementById('pu-note').addEventListener('input', e=>{ noteVal = e.target.value; });
    document.getElementById('pu-save').addEventListener('click', async ()=>{
      const items = rows.filter(r=>Number(r.packs)>0).map(r=>({
        productId: r.productId, packs: Number(r.packs)||0, cost: Number(r.cost)||0, sell: Number(r.sell)||0
      }));
      if(!items.length){ alert('Добавь хотя бы одну позицию с количеством пачек'); return; }
      const totalPaid = Number(document.getElementById('pu-total').value)||0;
      const entry = {
        items,
        totalPaid,
        paidFromCash: document.getElementById('pu-fromcash').checked,
        note: document.getElementById('pu-note').value.trim()
      };
      if(existing){
        await db.collection('days').doc(ACTIVE_DAY).collection('purchases').doc(existing.id).update(entry);
      } else {
        entry.time = firebase.firestore.FieldValue.serverTimestamp();
        await db.collection('days').doc(ACTIVE_DAY).collection('purchases').add(entry);
      }
      closeModal();
      await loadActiveDay();
    });
  }

  openModal(existing?'Изменить закупку':'Внести закупку', '');
  render();
}

function openExpenseForm(){
  openModal('Внести расход', `
    <div class="field"><label>Сумма</label><input id="ex-amount" type="number" min="0" placeholder="0"></div>
    <div class="field"><label>На что (необязательно)</label><input id="ex-note" placeholder="напр. курьер, хозтовары"></div>
    <button id="ex-save" class="btn btn-primary btn-block">Добавить</button>
  `);
  document.getElementById('ex-save').addEventListener('click', async ()=>{
    const amount = Number(document.getElementById('ex-amount').value)||0;
    if(amount<=0){ alert('Укажи сумму'); return; }
    const entry = {
      amount,
      note: document.getElementById('ex-note').value.trim(),
      time: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('days').doc(ACTIVE_DAY).collection('expenses').add(entry);
    closeModal();
    await loadActiveDay();
  });
}

function renderEveningForm(){
  const isToday = ACTIVE_CONTEXT === 'today';
  if(isToday) document.getElementById('topStatus').textContent='Вечерний подсчёт';
  const el = activeContainer();
  const prevEvening = ACTIVE_DOC && ACTIVE_DOC.evening ? ACTIVE_DOC.evening : {};
  const dp = dayProducts();
  el.innerHTML = `
    <div class="card">Посчитай, сколько пачек и отдельных сигарет осталось по каждому товару прямо сейчас.</div>
    <div id="eveningForm" class="count-table">
      ${dp.map(p=>countItemHtml(p,'e',prevEvening[p.id])).join('')}
    </div>
    <button id="calcSummaryBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Посчитать итог дня</button>
  `;
  document.getElementById('calcSummaryBtn').addEventListener('click', showDaySummaryPreview);
}

// промежуточный итог за день — без вечернего подсчёта, обновляется сразу при любой закупке/расходе
function computeRunningTotals(){
  let assortmentValue = 0;
  dayProducts().forEach(p=>{
    const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
    const totalSticks = sticks(m.packs,m.loose,p.packSize) + purchasedSticksForProduct(p.id);
    assortmentValue += totalSticks * p.stickPrice;
  });
  const totalPurchaseCash = PURCHASES.reduce((s,pu)=> s + (pu.paidFromCash!==false ? purchasePaid(pu) : 0), 0);
  const totalExpenses = EXPENSES.reduce((s,ex)=> s + (Number(ex.amount)||0), 0);
  return { assortmentValue, totalPurchaseCash, totalExpenses };
}

function computeSummary(evening){
  const perProduct = {};
  let totalExpected = 0, totalProfit = 0, anomalies=[];
  dayProducts().forEach(p=>{
    const m = ACTIVE_DOC.morning[p.id] || {packs:0,loose:0};
    const purchasedSticks = purchasedSticksForProduct(p.id);
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

  // деньги, реально ушедшие из кассы за день — закупки (по фактически уплаченной сумме) и расходы
  const totalPurchaseCash = PURCHASES.reduce((s,pu)=> s + (pu.paidFromCash!==false ? purchasePaid(pu) : 0), 0);
  const totalExpenses = EXPENSES.reduce((s,ex)=> s + (Number(ex.amount)||0), 0);
  const netExpectedCash = totalExpected - totalPurchaseCash - totalExpenses;

  const purchaseLines = PURCHASES
    .filter(pu=> pu.paidFromCash!==false && purchasePaid(pu) > 0)
    .map(pu=>{
      const desc = purchaseItems(pu).map(it=> `${productById(it.productId)?.name||'—'} ×${it.packs||0}`).join(', ');
      return { name: desc, amount: purchasePaid(pu) };
    });
  const expenseLines = EXPENSES.map(ex=>({ note: ex.note || 'Расход', amount: Number(ex.amount)||0 }));

  return { perProduct, totalExpected, totalProfit, anomalies, totalPurchaseCash, totalExpenses, netExpectedCash, purchaseLines, expenseLines };
}

function showDaySummaryPreview(){
  const evening = {};
  dayProducts().forEach(p=>{
    const item = document.querySelector(`.count-item[data-pid="${p.id}"]`);
    evening[p.id] = { packs:Number(item.querySelector('.e-packs').value)||0, loose:Number(item.querySelector('.e-loose').value)||0 };
  });
  const summary = computeSummary(evening);
  const el = activeContainer();
  const prevCash = (ACTIVE_DOC && ACTIVE_DOC.summary && ACTIVE_DOC.summary.actualCash!==undefined) ? ACTIVE_DOC.summary.actualCash : '';
  el.innerHTML = `
    ${summary.anomalies.length?`<div class="card" style="border-color:var(--danger);color:var(--danger);">Внимание: у ${summary.anomalies.join(', ')} остаток вечером больше, чем должно быть в наличии. Перепроверь подсчёт или закупки.</div>`:''}
    <div class="card">
      <div style="font-weight:600;">Выручка: <span style="font-family:var(--font-mono);">${money(summary.totalExpected)}</span></div>
      ${summary.totalPurchaseCash?`<div style="margin-top:4px;">Списано на закупки: <span style="font-family:var(--font-mono);">−${money(summary.totalPurchaseCash)}</span></div>`:''}
      ${summary.totalExpenses?`<div style="margin-top:4px;">Расходы: <span style="font-family:var(--font-mono);">−${money(summary.totalExpenses)}</span></div>`:''}
      <div style="font-weight:600;margin-top:8px;">Должно быть в кассе: <span style="font-family:var(--font-mono);">${money(summary.netExpectedCash)}</span></div>
      <div class="field" style="margin-top:12px;"><label>Сколько наличных фактически на руках</label><input id="actualCash" type="number" placeholder="0" value="${prevCash}"></div>
      <button id="confirmCloseBtn" class="btn btn-primary btn-block">Подтвердить и закрыть день</button>
      <button id="backToEveningBtn" class="btn btn-outline btn-block" style="margin-top:8px;">Назад, исправить подсчёт</button>
    </div>
  `;
  document.getElementById('backToEveningBtn').addEventListener('click', renderEveningForm);
  document.getElementById('confirmCloseBtn').addEventListener('click', async ()=>{
    const actualCash = Number(document.getElementById('actualCash').value)||0;
    const diff = actualCash - summary.netExpectedCash;
    const fullSummary = { ...summary, actualCash, diff };
    await db.collection('days').doc(ACTIVE_DAY).set({
      evening, closed:true, closedAt:firebase.firestore.FieldValue.serverTimestamp(), summary:fullSummary
    }, {merge:true});
    await loadActiveDay();
  });
}

function renderReceipt(summary, dayId){
  const diffClass = Math.abs(summary.diff) < 0.01 ? 'ok' : (summary.diff < 0 ? 'bad':'ok');
  const netCash = summary.netExpectedCash!==undefined ? summary.netExpectedCash : summary.totalExpected;
  return `
    <div class="receipt">
      <div class="r-title">Касса</div>
      <div class="r-date">${dateLabel(dayId)}</div>
      ${Object.values(summary.perProduct).map(pp=>`
        <div class="r-line"><span class="r-name">${escapeHtml(pp.name)} × ${Math.max(0,pp.sold)} по ${money(pp.pricePerStick||0)}</span><span class="r-num">${money(pp.revenue)}</span></div>
      `).join('')}
      <hr>
      <div class="r-total"><span>Выручка</span><span>${money(summary.totalExpected)}</span></div>
      ${(summary.purchaseLines||[]).map(pl=>`
        <div class="r-line"><span class="r-name">Закупка: ${escapeHtml(pl.name)}</span><span class="r-num">−${money(pl.amount)}</span></div>
      `).join('')}
      ${(summary.expenseLines||[]).map(exl=>`
        <div class="r-line"><span class="r-name">Расход: ${escapeHtml(exl.note)}</span><span class="r-num">−${money(exl.amount)}</span></div>
      `).join('')}
      <hr>
      <div class="r-total"><span>Должно быть в кассе</span><span>${money(netCash)}</span></div>
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
  if(!confirm(`Переоткрыть день ${dateLabel(ACTIVE_DAY)}? Можно будет добавить закупки/расходы и заново сделать вечерний подсчёт.`)) return;
  await db.collection('days').doc(ACTIVE_DAY).set({ closed:false }, {merge:true});
  await loadActiveDay();
}

async function clearDay(){
  if(!confirm(`Полностью очистить день ${dateLabel(ACTIVE_DAY)}? Все данные за этот день (остатки, закупки, расходы, итог) удалятся без возможности восстановить.`)) return;
  const dayRef = db.collection('days').doc(ACTIVE_DAY);
  const [psnap, esnap] = await Promise.all([
    dayRef.collection('purchases').get(),
    dayRef.collection('expenses').get()
  ]);
  const batch = db.batch();
  psnap.docs.forEach(d=>batch.delete(d.ref));
  esnap.docs.forEach(d=>batch.delete(d.ref));
  batch.delete(dayRef);
  await batch.commit();
  if(ACTIVE_CONTEXT==='archive'){
    renderArchiveList();
  } else {
    await loadToday(); // заново определяем актуальный день (сегодня или другой незакрытый), а не остаёмся на удалённой дате
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
