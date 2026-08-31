/* ============================================================
   INVENTÁRIO FORTAL — agora com banco compartilhado (Supabase)
   -----------------------------------------------------------
   Todos os celulares que abrirem o link enxergam o mesmo
   inventário em tempo real. A base de produtos (catálogo)
   continua sendo um arquivo local (data/products.json) — só o
   que muda durante o uso (inventários, contagens, correções)
   fica no banco compartilhado.
   ============================================================ */

const sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.key);

/* ---------------- SESSÃO / LOGIN ---------------- */

let currentProfile = null; // { id, nome, role }

async function ensureAuth() {
  try {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    return session;
  } catch (err) {
    console.error('Falha no login anônimo:', err);
    return null;
  }
}

async function loadProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data;
}

async function criarProfile(nome, role) {
  let { data: { session } } = await sb.auth.getSession();
  if (!session) session = await ensureAuth();
  if (!session) throw new Error('Não foi possível autenticar. Verifique se o "Anonymous Sign-Ins" está ativado no Supabase (Authentication → Sign In / Providers).');
  const { data, error } = await sb.from('profiles')
    .upsert({ id: session.user.id, nome, role })
    .select().single();
  if (error) throw new Error('Não foi possível salvar o perfil: ' + error.message);
  return data;
}

/* ---------------- CATÁLOGO LOCAL (não muda com frequência) ---------------- */

const MASTER = { KEY: 'if_master_products' };
MASTER.get = () => JSON.parse(localStorage.getItem(MASTER.KEY) || '[]');
MASTER.set = (list) => localStorage.setItem(MASTER.KEY, JSON.stringify(list));
async function ensureMasterLoaded() {
  if (MASTER.get().length === 0) {
    const res = await fetch('data/products.json');
    MASTER.set(await res.json());
  }
}

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function deviceId() {
  let d = localStorage.getItem('if_device_id');
  if (!d) { d = uid(); localStorage.setItem('if_device_id', d); }
  return d;
}

/* ---------------- CAMADA DE DADOS (Supabase) ---------------- */

let inventoriesCache = [];

async function refreshInventories() {
  const { data: invs, error } = await sb.from('inventories').select('*').order('created_at');
  if (error) { console.error(error); return; }
  const ids = invs.map(i => i.id);
  const [{ data: prods }, { data: entries }, { data: corrections }] = await Promise.all([
    ids.length ? sb.from('inventory_products').select('*').in('inventory_id', ids) : { data: [] },
    ids.length ? sb.from('count_entries').select('*').in('inventory_id', ids) : { data: [] },
    ids.length ? sb.from('corrections').select('*').in('inventory_id', ids) : { data: [] },
  ]);

  inventoriesCache = invs.map(inv => ({
    id: inv.id,
    numero: inv.numero,
    status: inv.status,
    roundOpen: inv.round_open,
    roundClosed: inv.round_closed,
    createdAt: inv.created_at,
    createdBy: inv.created_by,
    products: (prods || []).filter(p => p.inventory_id === inv.id).map(p => ({
      codigo: p.codigo, referencia: p.referencia, descricao: p.descricao,
      unidade: p.unidade, codigoBarras: p.codigo_barras, temFoto: temFotoLocal(p.codigo),
    })),
    entries: (entries || []).filter(e => e.inventory_id === inv.id).map(e => ({
      id: e.id, codigo: e.codigo, round: e.round, quantity: +e.quantity,
      userName: e.user_nome, deviceId: e.device_id, timestamp: e.created_at,
    })),
    corrections: (corrections || []).filter(c => c.inventory_id === inv.id).map(c => ({
      id: c.id, codigo: c.codigo, oldTotal: c.old_total == null ? null : +c.old_total,
      newTotal: +c.new_total, reason: c.reason, userName: c.user_nome, timestamp: c.created_at,
    })),
  }));
  render();
}

function temFotoLocal(codigo) {
  const p = MASTER.get().find(m => m.codigo === codigo);
  return !!(p && p.temFoto);
}

async function criarInventarioSupabase(numero, produtos) {
  const { data: inv, error } = await sb.from('inventories')
    .insert({ numero, created_by: currentProfile.id })
    .select().single();
  if (error) { showToast('Erro ao criar inventário: ' + error.message, true); return; }

  const rows = produtos.map(p => ({
    inventory_id: inv.id, codigo: p.codigo, referencia: p.referencia,
    descricao: p.descricao, unidade: p.unidade, codigo_barras: p.codigoBarras,
  }));
  const { error: e2 } = await sb.from('inventory_products').insert(rows);
  if (e2) { showToast('Erro ao importar produtos: ' + e2.message, true); return; }
  await refreshInventories();
}

async function registrarLancamentoSupabase(inventoryId, codigo, round, quantity) {
  const { error } = await sb.from('count_entries').insert({
    inventory_id: inventoryId, codigo, round, quantity,
    user_id: currentProfile.id, user_nome: currentProfile.nome, device_id: deviceId(),
  });
  if (error) { showToast('Erro ao registrar: ' + error.message, true); return false; }
  await refreshInventories();
  return true;
}

async function salvarCorrecaoSupabase(inventoryId, codigo, oldTotal, newTotal, reason) {
  const { error } = await sb.from('corrections').insert({
    inventory_id: inventoryId, codigo, old_total: oldTotal, new_total: newTotal,
    reason, user_id: currentProfile.id, user_nome: currentProfile.nome,
  });
  if (error) { showToast('Erro ao salvar correção: ' + error.message, true); return; }
  await refreshInventories();
}

async function atualizarEtapaSupabase(inventoryId, patch) {
  const { error } = await sb.from('inventories').update(patch).eq('id', inventoryId);
  if (error) { showToast('Erro: ' + error.message, true); return; }
  await refreshInventories();
}

function assinarTempoReal() {
  sb.channel('inventario-fortal-mudancas')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventories' }, refreshInventories)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_products' }, refreshInventories)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'count_entries' }, refreshInventories)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corrections' }, refreshInventories)
    .subscribe();
}

/* ---------------- REGRAS DE NEGÓCIO ---------------- */

function roundTotal(inv, codigo, round) {
  return inv.entries.filter(e => e.codigo === codigo && e.round === round).reduce((s, e) => s + e.quantity, 0);
}

function productStatus(inv, codigo) {
  const t1 = roundTotal(inv, codigo, 1);
  const t2 = roundTotal(inv, codigo, 2);
  const t3 = roundTotal(inv, codigo, 3);
  const c1 = inv.entries.some(e => e.codigo === codigo && e.round === 1);
  const c2 = inv.entries.some(e => e.codigo === codigo && e.round === 2);
  const c3 = inv.entries.some(e => e.codigo === codigo && e.round === 3);
  const correction = [...inv.corrections].reverse().find(c => c.codigo === codigo);

  let status = 'AGUARDANDO 1ª';
  let final = null;

  if (!c1) {
    status = 'AGUARDANDO 1ª';
  } else if (!inv.roundClosed[1] || !c2) {
    status = inv.roundClosed[1] ? 'AGUARDANDO 2ª' : 'EM CONTAGEM (1ª)';
  } else if (!inv.roundClosed[2]) {
    status = 'EM CONTAGEM (2ª)';
  } else if (t1 === t2) {
    status = 'FINALIZADO'; final = t1;
  } else if (!c3) {
    status = 'AGUARDANDO 3ª';
  } else if (!inv.roundClosed[3]) {
    status = 'EM CONTAGEM (3ª)';
  } else {
    status = 'FINALIZADO'; final = t3;
  }

  if (correction) final = correction.newTotal;

  return { t1, t2, t3, final, status, divergente: c1 && c2 && inv.roundClosed[2] && t1 !== t2 };
}

function inventoryProgress(inv, round) {
  const total = inv.products.length;
  if (total === 0) return 0;
  const counted = inv.products.filter(p => inv.entries.some(e => e.codigo === p.codigo && e.round === round)).length;
  return Math.round((counted / total) * 100);
}

function divergentProducts(inv) {
  return inv.products.filter(p => productStatus(inv, p.codigo).divergente);
}

/* ---------------- PARSER DO RELATÓRIO WINTHOR (rotina 1147) ---------------- */

function parseWinthorReport(texto) {
  const master = MASTER.get();
  const linhas = texto.split('\n');
  const encontrados = new Map();
  let numeroInventario = null;

  const mInv = texto.match(/Invent[áa]rio\s*\n?\s*(\d+)/i);
  if (mInv) numeroInventario = mInv[1];

  const linePattern = /(\d+)\s+([A-Za-zÀ-ÿ0-9./"'\-]+)\s*-\s*(.+?)\s+UN\b/;
  for (const linha of linhas) {
    const m = linha.match(linePattern);
    if (!m) continue;
    const codigo = m[1];
    const referencia = m[2].trim();
    const master_p = master.find(p => p.codigo === codigo && p.referencia === referencia);
    if (master_p) encontrados.set(codigo, master_p);
  }
  return { numeroInventario, produtos: Array.from(encontrados.values()) };
}

/* ---------------- ESTADO DA UI ---------------- */

const state = {
  tab: 'inventarios',
  currentInventoryId: null,
  currentRound: 1,
  produtoEncontrado: null,
  qtd: 1,
  gerenciarTab: 'resumo',
  novoInventarioTexto: '',
  novoInventarioPreview: null,
};

function currentInventory() { return inventoriesCache.find(i => i.id === state.currentInventoryId) || null; }

/* ---------------- RENDER ---------------- */

const app = document.getElementById('app');

function render() {
  if (!currentProfile) { app.innerHTML = viewLogin(); bindLogin(); return; }

  let body = '';
  if (state.tab === 'inventarios') body = viewInventarios();
  else if (state.tab === 'inventariar') body = viewInventariar();
  else if (state.tab === 'relatorios') body = viewRelatorios();
  else if (state.tab === 'perfil') body = viewPerfil();

  app.innerHTML = body;
  bindGlobal();
}

/* ---- LOGIN ---- */
function viewLogin() {
  return `
  <div style="display:flex;flex-direction:column;justify-content:center;min-height:100vh;padding:32px;background:var(--azul-escuro);">
    <div style="text-align:center;color:#fff;margin-bottom:36px;">
      <div style="font-size:34px;">🧱</div>
      <h1 style="font-size:22px;margin:10px 0 2px;">INVENTÁRIO<br/>FORTAL ALUMÍNIO</h1>
      <div style="color:#AFC3E0;font-size:13px;">Controle de estoque</div>
    </div>
    <div class="card">
      <div class="field"><label>Seu nome</label><input id="login-nome" placeholder="Ex: João Silva" /></div>
      <div class="field">
        <label>Perfil</label>
        <select id="login-role">
          <option value="inventariar">Inventariar</option>
          <option value="gerenciar">Gerenciar</option>
        </select>
      </div>
      <button class="btn btn-primary" id="btn-entrar">ENTRAR</button>
      <div style="font-size:11px;color:var(--texto-suave);text-align:center;margin-top:10px;">
        Conectado ao banco compartilhado — todos os celulares veem o mesmo inventário.
      </div>
    </div>
  </div>`;
}
function bindLogin() {
  document.getElementById('btn-entrar').onclick = async () => {
    const nome = document.getElementById('login-nome').value.trim() || 'Usuário';
    const role = document.getElementById('login-role').value;
    const btn = document.getElementById('btn-entrar');
    btn.disabled = true; btn.textContent = 'ENTRANDO...';
    try {
      currentProfile = await criarProfile(nome, role);
      await refreshInventories();
      state.tab = 'inventarios';
      render();
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'ENTRAR';
      showToast(err.message || 'Não foi possível entrar. Tente novamente.', true);
    }
  };
}

/* ---- TABBAR ---- */
function tabbar() {
  const tabs = [
    { id: 'inventarios', ic: '📋', label: 'Inventários' },
    { id: 'inventariar', ic: '📷', label: 'Inventariar' },
    { id: 'relatorios', ic: '📊', label: 'Relatórios' },
    { id: 'perfil', ic: '👤', label: 'Perfil' },
  ];
  return `<div class="tabbar">${tabs.map(t => `
    <button data-tab="${t.id}" class="${state.tab === t.id ? 'active' : ''}">
      <span class="ic">${t.ic}</span>${t.label}
    </button>`).join('')}</div>`;
}

/* ---- INVENTÁRIOS ---- */
function viewInventarios() {
  if (state.currentInventoryId && currentInventory()) return viewGerenciarInventario(currentInventory());

  const filterTab = state._invFilter || 'andamento';
  const showList = inventoriesCache.filter(i => filterTab === 'andamento' ? i.status === 'em_andamento' : i.status === 'finalizado');

  return `
  <div class="topbar"><div><h1>Inventários</h1><div class="sub">${currentProfile.nome} · ${currentProfile.role === 'gerenciar' ? 'Gerenciar' : 'Inventariar'}</div></div></div>
  <div class="content">
    <div class="tabs-inline">
      <button data-invfilter="andamento" class="${filterTab==='andamento'?'active':''}">EM ANDAMENTO</button>
      <button data-invfilter="finalizados" class="${filterTab==='finalizados'?'active':''}">FINALIZADOS</button>
    </div>
    ${showList.length === 0 ? emptyState('📦', 'Nenhum inventário aqui ainda') : showList.map(cardInventario).join('')}
  </div>
  ${currentProfile.role === 'gerenciar' ? `<button class="fab" id="fab-novo">+</button>` : ''}
  ${modalNovoInventario()}
  ${tabbar()}`;
}

function cardInventario(inv) {
  const p1 = inventoryProgress(inv, 1);
  const badge = inv.status === 'finalizado' ? `<span class="badge badge-sucesso">FINALIZADO</span>` : `<span class="badge badge-andamento">EM ANDAMENTO</span>`;
  return `<div class="card" data-open-inv="${inv.id}">
    <div style="display:flex;justify-content:space-between;align-items:start;"><h3>Inventário ${inv.numero}</h3>${badge}</div>
    <div class="meta">${inv.products.length} produtos · ${p1}% da 1ª contagem</div>
  </div>`;
}

function emptyState(ic, texto) { return `<div class="empty-state"><div class="ic">${ic}</div>${texto}</div>`; }

function modalNovoInventario() {
  if (!state._novoOpen) return '';
  const preview = state.novoInventarioPreview;
  return `
  <div style="position:fixed;inset:0;background:rgba(11,37,69,0.55);z-index:40;display:flex;align-items:flex-end;">
    <div style="background:var(--fundo);width:100%;max-height:88vh;overflow:auto;border-radius:20px 20px 0 0;padding:20px;">
      <h3 style="margin-top:0;">Novo inventário</h3>
      <div class="field">
        <label>Cole aqui o texto do relatório da rotina 1147 (WinThor)</label>
        <textarea id="txt-winthor" rows="6" style="width:100%;padding:12px;border-radius:10px;border:1.5px solid var(--borda);font-family:monospace;font-size:12px;">${state.novoInventarioTexto}</textarea>
      </div>
      <button class="btn btn-outline" id="btn-processar" style="margin-bottom:12px;">PROCESSAR PDF</button>
      ${preview ? `
        <div class="card">
          <h3>Inventário nº ${preview.numeroInventario || '(não identificado)'}</h3>
          <div class="meta">Produtos identificados: ${preview.produtos.length}</div>
          <table class="report" style="margin-top:10px;">
            <tr><th>Cód.</th><th>Referência</th><th>Descrição</th></tr>
            ${preview.produtos.map(p => `<tr><td>${p.codigo}</td><td>${p.referencia}</td><td>${p.descricao}</td></tr>`).join('')}
          </table>
        </div>
        <button class="btn btn-success" id="btn-confirmar-inv" ${preview.produtos.length===0?'disabled':''}>CONFIRMAR E CRIAR INVENTÁRIO</button>
      ` : ''}
      <button class="btn btn-ghost" id="btn-cancelar-novo">CANCELAR</button>
    </div>
  </div>`;
}

/* ---- GERENCIAR INVENTÁRIO ---- */
function viewGerenciarInventario(inv) {
  const tabs = ['resumo', 'produtos', 'equipe'];
  const p1 = inventoryProgress(inv, 1), p2 = inventoryProgress(inv, 2), p3 = inventoryProgress(inv, 3);
  const finalizados = inv.products.filter(p => productStatus(inv, p.codigo).status === 'FINALIZADO').length;
  const div = divergentProducts(inv);

  let body = '';
  if (state.gerenciarTab === 'resumo') {
    body = `
    <div class="progress-row"><div class="label-row"><span>1ª CONTAGEM</span><span>${p1}%</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p1}%"></div></div></div>
    <div class="progress-row"><div class="label-row"><span>2ª CONTAGEM</span><span>${p2}%</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p2}%"></div></div></div>
    <div class="progress-row"><div class="label-row"><span>3ª CONTAGEM${div.length?` (${div.length} produtos)`:''}</span><span>${p3}%</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p3}%"></div></div></div>
    <div class="progress-row"><div class="label-row"><span>FINALIZADO</span><span>${Math.round(finalizados/inv.products.length*100)||0}%</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${Math.round(finalizados/inv.products.length*100)||0}%;background:var(--verde);"></div></div></div>
    ${div.length ? `<div class="card"><h3>⚠️ Divergências</h3><div class="meta">${div.length} produto(s) aguardando 3ª contagem</div></div>` : ''}
    <div class="card">
      <h3>Controle de etapas</h3>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
        ${!inv.roundClosed[1] ? `<button class="btn btn-outline btn-sm" data-encerrar="1">ENCERRAR 1ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[1] && !inv.roundOpen[2] && !inv.roundClosed[2] ? `<button class="btn btn-outline btn-sm" data-abrir="2">INICIAR 2ª CONTAGEM</button>` : ''}
        ${inv.roundOpen[2] && !inv.roundClosed[2] ? `<button class="btn btn-outline btn-sm" data-encerrar="2">ENCERRAR 2ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[2] && div.length > 0 && !inv.roundOpen[3] && !inv.roundClosed[3] ? `<button class="btn btn-outline btn-sm" data-abrir="3">INICIAR 3ª CONTAGEM</button>` : ''}
        ${inv.roundOpen[3] && !inv.roundClosed[3] ? `<button class="btn btn-outline btn-sm" data-encerrar="3">ENCERRAR 3ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[2] && (div.length === 0 || inv.roundClosed[3]) && inv.status !== 'finalizado' ? `<button class="btn btn-success btn-sm" data-finalizar="1">FINALIZAR INVENTÁRIO</button>` : ''}
      </div>
    </div>
    <button class="btn btn-ghost" id="btn-export-csv">EXCEL DOS LANÇAMENTOS ATUAIS (CSV)</button>`;
  } else if (state.gerenciarTab === 'produtos') {
    body = `<table class="report"><tr><th>Cód</th><th>Ref</th><th>1ª</th><th>2ª</th><th>3ª</th><th>Final</th><th>Status</th></tr>
      ${inv.products.map(p => {
        const s = productStatus(inv, p.codigo);
        return `<tr data-corrigir="${p.codigo}"><td>${p.codigo}</td><td>${p.referencia}</td><td>${s.t1||'-'}</td><td>${s.t2||'-'}</td><td>${s.t3||'-'}</td><td><b>${s.final ?? '-'}</b></td><td>${statusBadge(s.status)}</td></tr>`;
      }).join('')}</table>`;
  } else if (state.gerenciarTab === 'equipe') {
    const porUsuario = {};
    inv.entries.forEach(e => { porUsuario[e.userName] = (porUsuario[e.userName]||0) + 1; });
    body = Object.keys(porUsuario).length === 0 ? emptyState('👥','Nenhum lançamento ainda') :
      Object.entries(porUsuario).map(([nome, qtd]) => `<div class="card"><h3>${nome}</h3><div class="meta">${qtd} lançamento(s)</div></div>`).join('');
  }

  return `
  <div class="topbar">
    <button class="icon-btn" id="btn-voltar-inv">←</button>
    <div><h1>Inventário ${inv.numero}</h1><div class="sub">${inv.products.length} produtos</div></div>
    <div style="width:36px;"></div>
  </div>
  <div class="content">
    <div class="tabs-inline">${tabs.map(t => `<button data-gtab="${t}" class="${state.gerenciarTab===t?'active':''}">${t.toUpperCase()}</button>`).join('')}</div>
    ${body}
  </div>
  ${modalCorrecao(inv)}
  ${tabbar()}`;
}

function statusBadge(status) {
  if (status === 'FINALIZADO') return `<span class="badge badge-sucesso">FINALIZADO</span>`;
  if (status === 'AGUARDANDO 3ª') return `<span class="badge badge-alerta">AGUARDANDO 3ª</span>`;
  return `<span class="badge badge-andamento">${status}</span>`;
}

function modalCorrecao(inv) {
  if (!state._corrigirCodigo) return '';
  const p = inv.products.find(p => p.codigo === state._corrigirCodigo);
  const s = productStatus(inv, p.codigo);
  return `
  <div style="position:fixed;inset:0;background:rgba(11,37,69,0.55);z-index:40;display:flex;align-items:center;justify-content:center;">
    <div class="card" style="width:88%;max-width:380px;">
      <h3>Corrigir — ${p.referencia}</h3>
      <div class="meta" style="margin-bottom:14px;">Total atual: <b>${s.final ?? s.t1 ?? 0}</b></div>
      <div class="field"><label>Novo total</label><input id="corr-novo-total" type="number" value="${s.final ?? s.t1 ?? 0}" /></div>
      <div class="field"><label>Motivo da correção</label><input id="corr-motivo" placeholder="Ex: erro de digitação" /></div>
      <button class="btn btn-primary" id="btn-salvar-correcao">SALVAR CORREÇÃO</button>
      <button class="btn btn-ghost" id="btn-fechar-correcao">CANCELAR</button>
    </div>
  </div>`;
}

/* ---- INVENTARIAR ---- */
function viewInventariar() {
  const inventarios = inventoriesCache.filter(i => i.status === 'em_andamento');

  if (!state.currentInventoryId) {
    return `
    <div class="topbar"><h1>Inventariar</h1></div>
    <div class="content">
      <p class="meta" style="margin-bottom:10px;">Selecione o inventário:</p>
      ${inventarios.length === 0 ? emptyState('📦','Nenhum inventário em andamento') :
        inventarios.map(inv => `<div class="card" data-select-count-inv="${inv.id}"><h3>Inventário ${inv.numero}</h3><div class="meta">${inv.products.length} produtos</div></div>`).join('')}
    </div>
    ${tabbar()}`;
  }

  const inv = currentInventory();
  if (!inv) { state.currentInventoryId = null; return viewInventariar(); }

  const p = state.produtoEncontrado;

  return `
  <div class="topbar">
    <button class="icon-btn" id="btn-sair-contagem">←</button>
    <div><h1>INVENTARIAR – INV. ${inv.numero}</h1><div class="sub">${currentProfile.nome}</div></div>
    <div style="width:36px;"></div>
  </div>
  <div class="content">
    <div class="tabs-inline">
      ${[1,2,3].map(r => `<button data-round="${r}" class="${state.currentRound===r?'active':''}" ${inv.roundOpen[r] || (r===1 && !inv.roundClosed[1]) ? '' : 'disabled'}>${r}ª CONTAGEM</button>`).join('')}
    </div>
    ${!p ? `
      <div class="scan-box" id="btn-abrir-camera"><div class="camera-ic">📷</div><b>TOCAR PARA ESCANEAR</b><p>ou digite o código abaixo</p></div>
      <div id="qr-reader" style="display:none;"></div>
      <div class="field"><label>CÓDIGO OU CÓDIGO DE BARRAS</label><input id="input-codigo" placeholder="Ex: 3 ou 200000000003" autofocus /></div>
      <button class="btn btn-primary" id="btn-buscar-produto">BUSCAR</button>
    ` : `
      <div class="card">
        <div class="produto-encontrado">
          ${p.temFoto ? `<img src="assets/products/${p.codigo}.png" />` : `<div class="no-photo">SEM FOTO</div>`}
          <div><div class="meta">${p.codigo} — ${p.referencia}</div><h3>${p.descricao}</h3></div>
        </div>
      </div>
      <div class="qtd-control">
        <button id="qtd-menos">−</button><input id="qtd-input" type="number" value="${state.qtd}" /><button id="qtd-mais">+</button>
      </div>
      <button class="btn btn-success" id="btn-registrar">REGISTRAR</button>
      <button class="btn btn-ghost" id="btn-cancelar-produto">CANCELAR</button>
    `}
  </div>
  ${tabbar()}`;
}

/* ---- RELATÓRIOS ---- */
function viewRelatorios() {
  return `
  <div class="topbar"><h1>Relatórios</h1></div>
  <div class="content">
    ${inventoriesCache.length === 0 ? emptyState('📊','Nenhum inventário ainda') : inventoriesCache.map(inv => {
      const div = divergentProducts(inv);
      return `<div class="card"><h3>Inventário ${inv.numero}</h3><div class="meta">${inv.entries.length} lançamentos · ${div.length} divergência(s)</div>
        <button class="btn btn-outline btn-sm" style="margin-top:10px;" data-export-final="${inv.id}">EXPORTAR EXCEL FINAL (CSV)</button></div>`;
    }).join('')}
  </div>
  ${tabbar()}`;
}

/* ---- PERFIL ---- */
function viewPerfil() {
  return `
  <div class="topbar"><h1>Perfil</h1></div>
  <div class="content">
    <div class="card"><h3>${currentProfile.nome}</h3><div class="meta">Perfil: ${currentProfile.role === 'gerenciar' ? 'Gerenciar' : 'Inventariar'}</div></div>
    <button class="btn btn-outline" id="btn-sair">SAIR</button>
  </div>
  ${tabbar()}`;
}

/* ---------------- EVENTOS ---------------- */

function bindGlobal() {
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab; state.currentInventoryId = null; state.produtoEncontrado = null; render();
  });

  const sair = document.getElementById('btn-sair');
  if (sair) sair.onclick = async () => { await sb.auth.signOut(); currentProfile = null; render(); };

  document.querySelectorAll('[data-invfilter]').forEach(b => b.onclick = () => { state._invFilter = b.dataset.invfilter; render(); });
  document.querySelectorAll('[data-open-inv]').forEach(b => b.onclick = () => {
    if (currentProfile.role !== 'gerenciar') return;
    state.currentInventoryId = b.dataset.openInv; state.gerenciarTab = 'resumo'; render();
  });
  const btnVoltar = document.getElementById('btn-voltar-inv');
  if (btnVoltar) btnVoltar.onclick = () => { state.currentInventoryId = null; render(); };
  document.querySelectorAll('[data-gtab]').forEach(b => b.onclick = () => { state.gerenciarTab = b.dataset.gtab; render(); });

  const fabNovo = document.getElementById('fab-novo');
  if (fabNovo) fabNovo.onclick = () => { state._novoOpen = true; state.novoInventarioPreview = null; render(); };
  const btnCancelarNovo = document.getElementById('btn-cancelar-novo');
  if (btnCancelarNovo) btnCancelarNovo.onclick = () => { state._novoOpen = false; render(); };
  const btnProcessar = document.getElementById('btn-processar');
  if (btnProcessar) btnProcessar.onclick = () => {
    const texto = document.getElementById('txt-winthor').value;
    state.novoInventarioTexto = texto;
    state.novoInventarioPreview = parseWinthorReport(texto);
    render();
  };
  const btnConfirmarInv = document.getElementById('btn-confirmar-inv');
  if (btnConfirmarInv) btnConfirmarInv.onclick = async () => {
    const preview = state.novoInventarioPreview;
    const numero = preview.numeroInventario || String(Date.now()).slice(-4);
    btnConfirmarInv.disabled = true; btnConfirmarInv.textContent = 'CRIANDO...';
    await criarInventarioSupabase(numero, preview.produtos);
    state._novoOpen = false; state.novoInventarioTexto = ''; state.novoInventarioPreview = null;
    render();
  };

  document.querySelectorAll('[data-encerrar]').forEach(b => b.onclick = () => {
    const r = +b.dataset.encerrar;
    const inv = currentInventory();
    atualizarEtapaSupabase(inv.id, { round_open: { ...inv.roundOpen, [r]: false }, round_closed: { ...inv.roundClosed, [r]: true } });
  });
  document.querySelectorAll('[data-abrir]').forEach(b => b.onclick = () => {
    const r = +b.dataset.abrir;
    const inv = currentInventory();
    atualizarEtapaSupabase(inv.id, { round_open: { ...inv.roundOpen, [r]: true } });
  });
  document.querySelectorAll('[data-finalizar]').forEach(b => b.onclick = () => {
    const inv = currentInventory();
    atualizarEtapaSupabase(inv.id, { status: 'finalizado' });
  });
  const btnExportCsv = document.getElementById('btn-export-csv');
  if (btnExportCsv) btnExportCsv.onclick = () => exportLancamentosCsv(currentInventory());
  document.querySelectorAll('[data-export-final]').forEach(b => b.onclick = () => {
    exportFinalCsv(inventoriesCache.find(i => i.id === b.dataset.exportFinal));
  });

  document.querySelectorAll('[data-corrigir]').forEach(tr => tr.onclick = () => {
    if (currentProfile.role !== 'gerenciar') return;
    state._corrigirCodigo = tr.dataset.corrigir; render();
  });
  const btnFecharCorr = document.getElementById('btn-fechar-correcao');
  if (btnFecharCorr) btnFecharCorr.onclick = () => { state._corrigirCodigo = null; render(); };
  const btnSalvarCorr = document.getElementById('btn-salvar-correcao');
  if (btnSalvarCorr) btnSalvarCorr.onclick = async () => {
    const novoTotal = +document.getElementById('corr-novo-total').value;
    const motivo = document.getElementById('corr-motivo').value.trim();
    if (!motivo) { alert('Informe o motivo da correção.'); return; }
    const inv = currentInventory();
    const s = productStatus(inv, state._corrigirCodigo);
    await salvarCorrecaoSupabase(inv.id, state._corrigirCodigo, s.final ?? s.t1 ?? 0, novoTotal, motivo);
    state._corrigirCodigo = null;
    render();
  };

  document.querySelectorAll('[data-select-count-inv]').forEach(c => c.onclick = () => {
    state.currentInventoryId = c.dataset.selectCountInv; state.currentRound = 1; state.produtoEncontrado = null; render();
  });
  const btnSair = document.getElementById('btn-sair-contagem');
  if (btnSair) btnSair.onclick = () => { state.currentInventoryId = null; state.produtoEncontrado = null; render(); };
  document.querySelectorAll('[data-round]').forEach(b => b.onclick = () => {
    if (b.disabled) return;
    state.currentRound = +b.dataset.round; state.produtoEncontrado = null; render();
  });

  const inputCodigo = document.getElementById('input-codigo');
  const btnBuscar = document.getElementById('btn-buscar-produto');
  const buscar = () => { const val = (inputCodigo?.value || '').trim(); if (val) buscarProduto(val); };
  if (btnBuscar) btnBuscar.onclick = buscar;
  if (inputCodigo) inputCodigo.addEventListener('keydown', e => { if (e.key === 'Enter') buscar(); });

  const btnAbrirCamera = document.getElementById('btn-abrir-camera');
  if (btnAbrirCamera) btnAbrirCamera.onclick = iniciarScanner;

  document.getElementById('qtd-menos')?.addEventListener('click', () => { state.qtd = Math.max(1, state.qtd - 1); render(); });
  document.getElementById('qtd-mais')?.addEventListener('click', () => { state.qtd = state.qtd + 1; render(); });
  document.getElementById('qtd-input')?.addEventListener('change', e => { state.qtd = Math.max(1, +e.target.value || 1); });
  document.getElementById('btn-cancelar-produto')?.addEventListener('click', () => { state.produtoEncontrado = null; state.qtd = 1; render(); });
  document.getElementById('btn-registrar')?.addEventListener('click', registrarLancamento);
}

function buscarProduto(valor) {
  const inv = currentInventory();
  if (!inv) return;
  let codigo = valor;
  if (/^\d{12}$/.test(valor) && valor.startsWith('20')) codigo = String(parseInt(valor.slice(2), 10));
  const produto = inv.products.find(p => p.codigo === codigo);
  if (!produto) { showToast('Este produto não pertence a este inventário.', true); return; }
  if (state.currentRound === 3 && !divergentProducts(inv).some(p => p.codigo === codigo)) {
    showToast('Este produto não está aguardando 3ª contagem.', true); return;
  }
  state.produtoEncontrado = produto; state.qtd = 1; render();
}

async function registrarLancamento() {
  const inv = currentInventory();
  const p = state.produtoEncontrado;
  if (!inv || !p) return;
  const ok = await registrarLancamentoSupabase(inv.id, p.codigo, state.currentRound, state.qtd);
  if (!ok) return;
  state.produtoEncontrado = null; state.qtd = 1; render();
  showToast('Lançamento registrado com sucesso.');
  setTimeout(() => document.getElementById('input-codigo')?.focus(), 50);
}

function showToast(msg, erro) {
  const el = document.createElement('div');
  el.className = 'toast' + (erro ? ' erro' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function iniciarScanner() {
  const box = document.getElementById('qr-reader');
  box.style.display = 'block';
  const scanner = new Html5Qrcode('qr-reader');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 220, formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128] },
    (decodedText) => { scanner.stop().then(() => { box.style.display = 'none'; buscarProduto(decodedText); }); },
    () => {}
  ).catch(() => showToast('Não foi possível acessar a câmera. Digite o código manualmente.', true));
}

/* ---------------- EXPORTAÇÃO CSV ---------------- */

function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportLancamentosCsv(inv) {
  if (!inv) return;
  const rows = [['CODPROD','DESCRICAO','QUANTIDADE','NUMINVENTARIO','CONTAGEM']];
  inv.entries.forEach(e => {
    const p = inv.products.find(p => p.codigo === e.codigo);
    rows.push([e.codigo, p?.descricao || '', e.quantity, inv.numero, e.round]);
  });
  downloadCsv(`inventario_${inv.numero}_lancamentos.csv`, rows);
}

function exportFinalCsv(inv) {
  if (!inv) return;
  const rows = [['CODPROD','DESCRICAO','QUANTIDADE','NUMINVENTARIO']];
  inv.products.forEach(p => {
    const s = productStatus(inv, p.codigo);
    rows.push([p.codigo, p.descricao, s.final ?? '', inv.numero]);
  });
  downloadCsv(`inventario_${inv.numero}_final.csv`, rows);
}

/* ---------------- INICIALIZAÇÃO ---------------- */

(async function start() {
  await ensureMasterLoaded();
  await ensureAuth();
  const { data: { session } } = await sb.auth.getSession();
  if (session) currentProfile = await loadProfile(session.user.id);
  if (currentProfile) await refreshInventories();
  assinarTempoReal();
  render();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(()=>{}));
}
