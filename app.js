/* ============================================================
   INVENTÁRIO FORTAL — agora com banco compartilhado (Supabase)
   -----------------------------------------------------------
   Todos os celulares que abrirem o link enxergam o mesmo
   inventário em tempo real. A base de produtos (catálogo)
   continua sendo um arquivo local (data/products.json) — só o
   que muda durante o uso (inventários, contagens, correções)
   fica no banco compartilhado.
   ============================================================ */

let sb;
try {
  if (typeof window.supabase === 'undefined') throw new Error('Biblioteca do Supabase não carregou.');
  sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.key);
} catch (err) {
  document.getElementById('app').innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;background:#F5F5F7;">
      <div style="text-align:center;max-width:320px;">
        <div style="font-size:40px;margin-bottom:12px;">📡</div>
        <h2 style="color:#182642;font-size:18px;margin-bottom:8px;">Não foi possível carregar o app</h2>
        <p style="color:#626B7A;font-size:14px;margin-bottom:20px;">Verifique sua conexão com a internet e tente novamente.</p>
        <button onclick="location.reload()" style="padding:12px 24px;background:#1E5FA8;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:14px;">TENTAR DE NOVO</button>
      </div>
    </div>`;
  throw err;
}

/* ---------------- SESSÃO / LOGIN ---------------- */

let currentProfile = null; // { id, nome, role }

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/* Login por usuário e senha. O administrador (Gerenciar) cria os usuários na aba
   "Usuários". Por trás, o Supabase Auth usa um e-mail interno gerado a partir do
   nome de usuário (ninguém precisa ter e-mail de verdade). */
const EMAIL_DOMINIO = 'inventario.fortalaluminio.digital';
function normalizarUsuario(u) { return String(u || '').trim().toLowerCase(); }
function usuarioParaEmail(u) { return `${normalizarUsuario(u)}@${EMAIL_DOMINIO}`; }

async function loadProfile(userId) {
  const { data, error } = await withTimeout(
    sb.from('profiles').select('*').eq('id', userId).maybeSingle(),
    12000, 'Servidor demorando para responder. Tente novamente.'
  );
  if (error) {
    console.error('Erro ao ler perfil', error);
    throw new Error('Erro ao ler o perfil: ' + (error.message || error.code || 'desconhecido') +
      (error.code ? ' (' + error.code + ')' : ''));
  }
  return data;
}

async function entrarComSenha(usuario, senha) {
  const { data, error } = await withTimeout(
    sb.auth.signInWithPassword({ email: usuarioParaEmail(usuario), password: senha }),
    15000, 'Servidor demorando para responder. Tente novamente.'
  );
  if (error) {
    const msg = String(error.message || '');
    if (/banned/i.test(msg)) throw new Error('Acesso desativado. Fale com o administrador.');
    if (/invalid login|credentials/i.test(msg)) throw new Error('Usuário ou senha incorretos.');
    throw new Error('Não foi possível entrar: ' + msg);
  }
  const perfil = await loadProfile(data.user.id);
  if (!perfil || !perfil.ativo || !perfil.usuario) {
    await sb.auth.signOut();
    throw new Error('Este usuário não tem acesso ao inventário. Fale com o administrador.');
  }
  return perfil;
}

/* Equipe de contagem (dupla): o login é compartilhado, mas o app pede o nome do
   Apontador e do Contador. O nome gravado em cada lançamento é "Apontador / Contador". */
const DUPLA_KEY = 'if_dupla';
function lerDuplaSalva(userId) {
  try {
    const d = JSON.parse(localStorage.getItem(DUPLA_KEY) || 'null');
    return d && d.userId === userId ? d : null;
  } catch (e) { return null; }
}

function aplicarPerfil(perfil, restaurarDupla) {
  currentProfile = { ...perfil, nomeCadastro: perfil.nome };
  state._precisaDupla = false;
  if (perfil.role === 'inventariar') {
    const d = restaurarDupla ? lerDuplaSalva(perfil.id) : null;
    if (d) currentProfile.nome = `${d.apontador} / ${d.contador}`;
    else { localStorage.removeItem(DUPLA_KEY); state._precisaDupla = true; }
  } else {
    localStorage.removeItem(DUPLA_KEY);
  }
}

async function sairDoApp() {
  localStorage.removeItem(DUPLA_KEY);
  try { await sb.auth.signOut(); } catch (e) { /* segue mesmo offline */ }
  currentProfile = null;
  state._precisaDupla = false;
  state.tab = 'inventarios';
  state.currentInventoryId = null;
  render();
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

function getLastLocation() {
  return JSON.parse(localStorage.getItem('if_last_location') || '{"arvore":"","lado":""}');
}
function saveLastLocation(arvore, lado) {
  localStorage.setItem('if_last_location', JSON.stringify({ arvore, lado }));
}

function getLastQtyConfig() {
  return JSON.parse(localStorage.getItem('if_qty_config') || '{"modo":"simples"}');
}
function saveLastQtyConfig(modo) {
  localStorage.setItem('if_qty_config', JSON.stringify({ modo }));
}
function linhaVazia() { return { qtd: '', pecas: '' }; }
function calcularTotalVolumes() {
  return (state.volumeLinhas || []).reduce((soma, linha) => {
    const qtd = parseFloat(String(linha.qtd).replace(',', '.')) || 0;
    const temPecas = linha.pecas !== '' && linha.pecas != null;
    const pecas = temPecas ? (parseFloat(String(linha.pecas).replace(',', '.')) || 0) : null;
    return soma + (pecas !== null ? qtd * pecas : qtd);
  }, 0);
}

/* ---------------- CAMADA DE DADOS (Supabase) ---------------- */

let inventoriesCache = [];

async function buscarTudoPaginado(criarQuery, tamanhoPagina = 1000) {
  let tudo = [];
  let inicio = 0;
  while (true) {
    let data, error;
    let tentativas = 0;
    while (tentativas < 3) {
      ({ data, error } = await criarQuery().range(inicio, inicio + tamanhoPagina - 1));
      if (!error) break;
      tentativas++;
      console.error(`[paginacao] erro na tentativa ${tentativas}/3 (linhas ${inicio}+):`, error);
      if (tentativas < 3) await new Promise(r => setTimeout(r, 800 * tentativas));
    }
    if (error) {
      showToast('Falha ao carregar todos os dados — alguns produtos podem estar faltando. Atualize a página e tente de novo antes de gerar relatórios.', true, 9000);
      return tudo;
    }
    tudo = tudo.concat(data || []);
    if (!data || data.length < tamanhoPagina) break;
    inicio += tamanhoPagina;
  }
  return tudo;
}

let _produtosCache = null;

async function refreshInventories(opcoes = {}) {
  const completo = opcoes.completo !== false;
  _statusCacheVersion++;
  _statusCache.clear();
  const { data: invs, error } = await sb.from('inventories').select('*').order('created_at');
  if (error) { console.error(error); return; }
  const ids = invs.map(i => i.id);

  let prods;
  if (completo || !_produtosCache) {
    prods = ids.length ? await buscarTudoPaginado(() => sb.from('inventory_products').select('*').in('inventory_id', ids).order('inventory_id').order('codigo')) : [];
    _produtosCache = prods;
  } else {
    prods = _produtosCache;
  }
  const [entries, corrections] = await Promise.all([
    ids.length ? buscarTudoPaginado(() => sb.from('count_entries').select('*').in('inventory_id', ids).order('created_at').order('id')) : [],
    ids.length ? buscarTudoPaginado(() => sb.from('corrections').select('*').in('inventory_id', ids).order('created_at').order('id')) : [],
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
    entries: (entries || []).filter(e => e.inventory_id === inv.id).map(mapEntry),
    corrections: (corrections || []).filter(c => c.inventory_id === inv.id).map(c => ({
      id: c.id, codigo: c.codigo, round: c.round, oldTotal: c.old_total == null ? null : +c.old_total,
      newTotal: +c.new_total, reason: c.reason, userName: c.user_nome, timestamp: c.created_at,
    })),
  }));
  _statusCacheVersion++;
  if (opcoes.semTela && state.tab === 'inventariar') return; // não derruba a tela de contagem
  renderSeguro();
}

// Atualizações em segundo plano nunca redesenham a tela enquanto a pessoa está digitando
// (redesenhar fecha o teclado e apaga o que foi digitado). Fica pendente até sair do campo.
let _renderPendente = false;
function digitandoAgora() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
function renderSeguro() {
  if (digitandoAgora()) { _renderPendente = true; return; }
  _renderPendente = false;
  render();
}
document.addEventListener('focusout', () => {
  if (!_renderPendente) return;
  setTimeout(() => { if (_renderPendente && !digitandoAgora()) { _renderPendente = false; render(); } }, 500);
});

function mapEntry(e) {
  return {
    id: e.id, codigo: e.codigo, round: e.round, quantity: +e.quantity,
    arvore: e.arvore, lado: e.lado,
    detalheContagem: e.detalhe_contagem || null,
    qtdAvaria: e.qtd_avaria == null ? null : +e.qtd_avaria,
    userName: e.user_nome, deviceId: e.device_id, timestamp: e.created_at,
  };
}

function temFotoLocal(codigo) {
  const p = MASTER.get().find(m => m.codigo === codigo);
  return !!(p && p.temFoto);
}

async function criarInventarioSupabase(numero, produtosBrutos) {
  // 1) Um mesmo código repetido no PDF derrubava o lote inteiro. Tira os repetidos e avisa.
  const vistos = new Set();
  const produtos = [];
  let repetidos = 0;
  for (const p of produtosBrutos) {
    if (vistos.has(p.codigo)) { repetidos++; continue; }
    vistos.add(p.codigo);
    produtos.push(p);
  }
  console.log('[import] criando registro do inventário', numero, '| produtos:', produtos.length, '| repetidos ignorados:', repetidos);

  const { data: inv, error } = await sb.from('inventories')
    .insert({ numero, created_by: currentProfile.id })
    .select().single();
  if (error) { console.error('[import] erro ao criar inventories:', error); showToast('Erro ao criar inventário: ' + error.message, true, 8000); return false; }

  // Se algo falhar, apaga o inventário criado: nunca fica um inventário pela metade.
  const descartar = async () => { try { await sb.from('inventories').delete().eq('id', inv.id); } catch (e) { console.error(e); } };

  const rows = produtos.map(p => ({
    inventory_id: inv.id, codigo: p.codigo, referencia: p.referencia,
    descricao: p.descricao, unidade: p.unidade, codigo_barras: p.codigoBarras,
  }));

  const TAMANHO_LOTE = 300;
  const totalLotes = Math.ceil(rows.length / TAMANHO_LOTE);
  for (let i = 0; i < rows.length; i += TAMANHO_LOTE) {
    const lote = rows.slice(i, i + TAMANHO_LOTE);
    const numeroLote = Math.floor(i / TAMANHO_LOTE) + 1;
    let sucesso = false, ultimoErro = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        // upsert que ignora duplicado: repetir o lote depois de uma queda de conexão é seguro.
        const { error: e2 } = await sb.from('inventory_products')
          .upsert(lote, { onConflict: 'inventory_id,codigo', ignoreDuplicates: true });
        if (!e2) { sucesso = true; break; }
        ultimoErro = e2;
        console.error(`[import] erro no lote ${numeroLote}/${totalLotes}, tentativa ${tentativa}/3:`, e2);
      } catch (err) {
        ultimoErro = err;
        console.error(`[import] exceção no lote ${numeroLote}/${totalLotes}, tentativa ${tentativa}/3:`, err);
      }
      if (tentativa < 3) {
        showToast(`Instabilidade no lote ${numeroLote}/${totalLotes} — tentando de novo (${tentativa}/3)...`, true, 2000);
        await new Promise(r => setTimeout(r, 1000 * tentativa));
      }
    }
    if (!sucesso) {
      await descartar();
      showToast(`A importação falhou no lote ${numeroLote} de ${totalLotes} (${(ultimoErro && ultimoErro.message) || 'erro de conexão'}). Nada foi criado — tente importar de novo.`, true, 10000);
      await refreshInventories();
      return false;
    }
    if (rows.length > TAMANHO_LOTE) showToast(`Importando... ${Math.min(i + TAMANHO_LOTE, rows.length)} de ${rows.length}`, false, 1500);
  }

  // 3) Conferência final: confere no banco quantos itens entraram de verdade.
  const { count, error: eCount } = await sb.from('inventory_products')
    .select('*', { count: 'exact', head: true }).eq('inventory_id', inv.id);
  if (eCount || count !== produtos.length) {
    console.error('[import] conferência falhou:', count, 'de', produtos.length, eCount);
    await descartar();
    showToast(`Conferência falhou: entraram ${count ?? '?'} de ${produtos.length} produtos. O inventário foi descartado — importe de novo.`, true, 10000);
    await refreshInventories();
    return false;
  }
  await refreshInventories();
  showToast(`✓ Importação conferida: ${count} de ${produtos.length} produtos${repetidos ? ` (${repetidos} código(s) repetido(s) no PDF ignorado(s))` : ''}`, false, 6000);
  return true;
}

async function excluirLancamentoSupabase(entryId) {
  const { error } = await sb.from('count_entries').delete().eq('id', entryId);
  if (error) { showToast('Erro ao excluir: ' + error.message, true); return false; }
  await refreshInventories();
  return true;
}

async function excluirInventarioSupabase(inventoryId) {
  const { error } = await sb.from('inventories').delete().eq('id', inventoryId);
  if (error) { showToast('Erro ao excluir inventário: ' + error.message, true); return false; }
  await refreshInventories();
  return true;
}

async function excluirTodosLancamentosRodada(inventoryId, codigo, round) {
  const { error } = await sb.from('count_entries').delete()
    .eq('inventory_id', inventoryId).eq('codigo', codigo).eq('round', round);
  if (error) { showToast('Erro ao excluir: ' + error.message, true); return false; }
  await refreshInventories();
  return true;
}

function novoUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function registrarLancamentoSupabase(inventoryId, codigo, round, quantity, arvore, lado, detalheContagem, qtdAvaria) {
  // O número único é criado ANTES de enviar. Se a internet cair e o app tentar de novo,
  // o banco reconhece o mesmo lançamento (erro 23505) e não grava duas vezes.
  const row = {
    id: novoUuid(),
    inventory_id: inventoryId, codigo, round, quantity, arvore: arvore || null, lado: lado || null,
    detalhe_contagem: detalheContagem, qtd_avaria: qtdAvaria,
    user_id: currentProfile.id, user_nome: currentProfile.nome, device_id: deviceId(),
  };
  let erro = null;
  for (let t = 1; t <= 3; t++) {
    try {
      const { error } = await withTimeout(sb.from('count_entries').insert(row), 15000, 'Servidor demorando para responder.');
      if (!error || error.code === '23505') { erro = null; break; }
      erro = error;
      if (error.code) break; // erro de regra do banco (permissão, valor inválido): repetir não adianta
    } catch (e) { erro = e; }
    if (t < 3) await new Promise(r => setTimeout(r, 700 * t));
  }
  if (erro) {
    showToast('Não foi possível registrar agora (' + (erro.message || 'sem conexão') + '). Nada foi gravado. Confira a internet e toque em REGISTRAR de novo.', true, 6000);
    return false;
  }

  // Atualiza a tela na hora com o que acabou de gravar (sem baixar tudo de novo).
  const inv = inventoriesCache.find(i => i.id === inventoryId);
  if (inv && !inv.entries.some(e => e.id === row.id)) {
    inv.entries.push(mapEntry({ ...row, created_at: new Date().toISOString() }));
    _statusCacheVersion++;
  }
  return true;
}

async function salvarCorrecaoSupabase(inventoryId, codigo, round, oldTotal, newTotal, reason) {
  const { error } = await sb.from('corrections').insert({
    inventory_id: inventoryId, codigo, round, old_total: oldTotal, new_total: newTotal,
    reason, user_id: currentProfile.id, user_nome: currentProfile.nome,
  });
  if (error) { showToast('Erro ao salvar correção: ' + error.message, true); return; }
  await refreshInventories();
}

async function excluirCorrecaoSupabase(correctionId) {
  const { error } = await sb.from('corrections').delete().eq('id', correctionId);
  if (error) { showToast('Erro ao excluir correção: ' + error.message, true); return false; }
  await refreshInventories();
  return true;
}

async function atualizarEtapaSupabase(inventoryId, patch) {
  const { error } = await sb.from('inventories').update(patch).eq('id', inventoryId);
  if (error) { showToast('Erro: ' + error.message, true); return; }
  await refreshInventories();
}

let _refreshDebounceTimer = null;
function refreshInventoriesDebounced(completo = false) {
  clearTimeout(_refreshDebounceTimer);
  _refreshDebounceTimer = setTimeout(() => { refreshInventories({ completo, semTela: true }); }, 2000);
}

// Lançamento feito em OUTRO aparelho: entra direto na memória, sem baixar tudo de novo.
let _telaTimer = null;
function aplicarMudancaLancamento(payload) {
  if (payload.eventType === 'INSERT' && payload.new) {
    const inv = inventoriesCache.find(i => i.id === payload.new.inventory_id);
    if (!inv) return refreshInventoriesDebounced(false);
    if (!inv.entries.some(x => x.id === payload.new.id)) inv.entries.push(mapEntry(payload.new));
  } else if (payload.eventType === 'DELETE' && payload.old && payload.old.id) {
    for (const inv of inventoriesCache) {
      const i = inv.entries.findIndex(x => x.id === payload.old.id);
      if (i >= 0) inv.entries.splice(i, 1);
    }
  } else {
    return refreshInventoriesDebounced(false);
  }
  _statusCacheVersion++;
  // Só redesenha se a pessoa não estiver digitando/contando.
  if (state.tab !== 'inventariar') {
    clearTimeout(_telaTimer);
    _telaTimer = setTimeout(() => renderSeguro(), 600);
  }
}

// Conferência de segurança: ao voltar para o app e a cada 5 min, confere tudo em segundo plano.
function iniciarSincronizacaoSegura() {
  if (window._syncSeguraAtiva) return;
  window._syncSeguraAtiva = true;
  const sincronizar = () => { if (currentProfile && document.visibilityState === 'visible') refreshInventories({ completo: false, semTela: true }); };
  document.addEventListener('visibilitychange', sincronizar);
  setInterval(sincronizar, 5 * 60 * 1000);
}

let _canalTempoReal = null;
function assinarTempoReal() {
  if (_canalTempoReal) { try { sb.removeChannel(_canalTempoReal); } catch (e) {} _canalTempoReal = null; }
  _canalTempoReal = sb.channel('inventario-fortal-mudancas')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventories' }, () => refreshInventoriesDebounced(true))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_products' }, () => refreshInventoriesDebounced(true))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'count_entries' }, aplicarMudancaLancamento)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corrections' }, () => refreshInventoriesDebounced(false))
    .subscribe();
}

/* ---------------- REGRAS DE NEGÓCIO ---------------- */

function formatNumeroBR(n) {
  if (n === '' || n === null || n === undefined) return '';
  const num = typeof n === 'number' ? n : parseFloat(n);
  if (isNaN(num)) return n;
  return String(num).replace('.', ',');
}

function formatarDetalhe(detalhe) {
  if (!detalhe || !detalhe.length) return '-';
  return detalhe.map(l => l.pecas != null ? `${formatNumeroBR(l.qtd)}×${formatNumeroBR(l.pecas)}` : `${formatNumeroBR(l.qtd)}`).join(' + ');
}

function melhorQuantidade(inv, codigo) {
  const s = productStatus(inv, codigo);
  if (s.final != null) return s.final;
  if (roundHasData(inv, codigo, 3)) return s.t3;
  if (roundHasData(inv, codigo, 2)) return s.t2;
  return s.t1;
}

function roundTotal(inv, codigo, round) {
  const entradas = inv.entries.filter(e => e.codigo === codigo && e.round === round);
  if (round === 3) {
    // 3ª contagem é soberana: o lançamento mais recente vale como valor
    // final dessa contagem, não soma com tentativas anteriores.
    if (entradas.length === 0) return 0;
    const maisRecente = entradas.reduce((a, b) => new Date(a.timestamp) > new Date(b.timestamp) ? a : b);
    return maisRecente.quantity;
  }
  return entradas.reduce((s, e) => s + e.quantity, 0);
}

function effectiveRoundTotal(inv, codigo, round) {
  const raw = roundTotal(inv, codigo, round);
  const corr = [...inv.corrections].reverse().find(c => c.codigo === codigo && c.round === round);
  return corr ? corr.newTotal : raw;
}

function roundHasData(inv, codigo, round) {
  return inv.entries.some(e => e.codigo === codigo && e.round === round) ||
         inv.corrections.some(c => c.codigo === codigo && c.round === round);
}

let _statusCacheVersion = 0;
let _statusCache = new Map();

function productStatus(inv, codigo) {
  const chave = _statusCacheVersion + '|' + inv.id + '|' + codigo;
  const emCache = _statusCache.get(chave);
  if (emCache) return emCache;
  const resultado = calcularProductStatus(inv, codigo);
  _statusCache.set(chave, resultado);
  return resultado;
}

function calcularProductStatus(inv, codigo) {
  const t1 = effectiveRoundTotal(inv, codigo, 1);
  const t2 = effectiveRoundTotal(inv, codigo, 2);
  let t3 = effectiveRoundTotal(inv, codigo, 3);
  const c1 = roundHasData(inv, codigo, 1);
  const c2 = roundHasData(inv, codigo, 2);
  const c3 = roundHasData(inv, codigo, 3);

  let status = 'AGUARDANDO 1ª';
  let final = null;

  if (!inv.roundClosed[1]) {
    // 1ª contagem ainda rolando — nada de errado em não ter dado ainda.
    status = c1 ? 'EM CONTAGEM (1ª)' : 'AGUARDANDO 1ª';
  } else if (!inv.roundClosed[2]) {
    // 1ª já fechada; 2ª ainda rolando.
    status = c2 ? 'EM CONTAGEM (2ª)' : 'AGUARDANDO 2ª';
  } else {
    // As duas primeiras contagens já fecharam: aqui não pode sobrar produto
    // "esperando" pra sempre — se faltou uma delas, ou elas não batem,
    // sempre exige 3ª contagem (recontagem definitiva). Mas só faz sentido
    // exigir 3ª se pelo menos uma das duas primeiras realmente aconteceu —
    // se nenhuma delas foi feita, não tem o que comparar na 3ª ainda.
    const algumaContagemExiste = c1 || c2;
    const precisaTerceira = algumaContagemExiste && (!c1 || !c2 || t1 !== t2);
    if (!algumaContagemExiste) {
      status = 'NÃO CONTADO';
    } else if (!precisaTerceira) {
      status = 'FINALIZADO'; final = t1; t3 = t1;
    } else if (!c3) {
      status = 'AGUARDANDO 3ª';
    } else if (!inv.roundClosed[3]) {
      status = 'EM CONTAGEM (3ª)';
    } else {
      const referencias = [];
      if (c1) referencias.push(t1);
      if (c2) referencias.push(t2);
      const bateComAlguma = referencias.length === 0 || referencias.includes(t3);
      if (!bateComAlguma) {
        status = 'DIVERGÊNCIA CRÍTICA';
      } else {
        status = 'FINALIZADO'; final = t3;
      }
    }
  }

  return {
    t1, t2, t3, final, status,
    divergente: inv.roundClosed[1] && inv.roundClosed[2] && (c1 || c2) && (!c1 || !c2 || t1 !== t2),
    alertaCritico: status === 'DIVERGÊNCIA CRÍTICA',
  };
}

function inventoryProgress(inv, round) {
  if (round === 3) {
    const divergentes = divergentProducts(inv);
    if (divergentes.length === 0) return inv.roundClosed[2] ? 100 : 0;
    const contados = divergentes.filter(p => roundHasData(inv, p.codigo, 3)).length;
    return Math.round((contados / divergentes.length) * 100);
  }
  const total = inv.products.length;
  if (total === 0) return 0;
  const counted = inv.products.filter(p => inv.entries.some(e => e.codigo === p.codigo && e.round === round)).length;
  return Math.round((counted / total) * 100);
}

function divergentProducts(inv) {
  return inv.products.filter(p => productStatus(inv, p.codigo).divergente);
}

function rodadaHabilitada(inv, r) {
  return inv.roundOpen[r] || (r === 1 && !inv.roundClosed[1]);
}

function rodadaAbertaAtual(inv) {
  for (const r of [1, 2, 3]) {
    if (rodadaHabilitada(inv, r)) return r;
  }
  return 1;
}

function produtosDivergenciaCritica(inv) {
  return inv.products.filter(p => productStatus(inv, p.codigo).alertaCritico);
}

/* ---------------- LEITURA DO PDF (WinThor rotina 1147) ---------------- */

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

async function extractTextFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Agrupa por linha (Y) e ordena cada linha por X — o pdf.js entrega os
    // itens na ordem do fluxo interno do PDF, que nem sempre é da esquerda
    // pra direita, então sem isso as colunas saem embaralhadas.
    const grupos = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4], y = item.transform[5];
      let g = grupos.find(g => Math.abs(g.y - y) <= 2);
      if (!g) { g = { y, itens: [] }; grupos.push(g); }
      g.itens.push({ x, str: item.str, width: item.width || 0 });
    }
    grupos.sort((a, b) => b.y - a.y);
    for (const g of grupos) {
      g.itens.sort((a, b) => a.x - b.x);
      let linha = '', lastXEnd = null;
      for (const it of g.itens) {
        if (lastXEnd !== null) {
          const gap = it.x - lastXEnd;
          if (gap > 6) linha += '   ';
          else if (gap > 0.5) linha += ' ';
        }
        linha += it.str;
        lastXEnd = it.x + it.width;
      }
      fullText += linha + '\n';
    }
  }
  return fullText;
}

/* ---------------- PARSER DO RELATÓRIO WINTHOR (rotina 1147) ---------------- */

function parseWinthorReport(texto) {
  const master = MASTER.get();
  const porCodigo = new Map(master.map(p => [p.codigo, p]));
  const linhas = texto.split('\n');
  const encontrados = new Map();
  let numeroInventario = null;

  const mInvNovo = texto.match(/Filial\s+Invent[áa]rio\s+Montador\s+invent[áa]rio\s*\n\s*\d+\s+(\d+)/i);
  if (mInvNovo) {
    numeroInventario = mInvNovo[1];
  } else {
    const mInv = texto.match(/Invent[áa]rio\s*\n?\s*(\d+)/i);
    if (mInv) numeroInventario = mInv[1];
  }

  // Formato "Divergência estoque x contagem" e afins: colunas alinhadas —
  // um número de código seguido da descrição, depois embalagem/UN/estoque.
  // O número de colunas antes do código varia (Mod/Rua/Num/Apt nem sempre
  // vêm todos preenchidos), então captura o ÚLTIMO número da sequência
  // inicial como o código.
  const padraoColunas = /^\s*(?:\d+\s+)+(\d+)\s+(.+?)\s{2,}\S+\s+[A-Z0-9]{1,3}\s+[\d.,]+/;
  // Formato antigo "Relatório de inventário rotativo simples": código +
  // referência - descrição, seguido de UN.
  const padraoAntigo = /(\d+)\s+([A-Za-zÀ-ÿ0-9./"'\-]+)\s*-\s*(.+?)\s+UN\b/;

  // Formato do relatório 1147 "simples": Módulo Rua Número Apto Código Descrição Embalagem Un.
  // A descrição pode NÃO ter o " - " (ex.: "ADESIVO FIXA ESPELHO 400GR"). Antes essas linhas eram
  // descartadas em silêncio — por isso só entravam uma parte dos produtos.
  const padraoLinhaRelatorio = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+(.+)\s+[A-Z]{1,3}(?:\s+[\d.,]+)*\s*$/;
  const padraoInicioLinha = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\S/;
  let candidatas = 0;
  const ignoradas = [];

  for (const linha of linhas) {
    let codigo = null, textoProduto = null;
    const ehCandidata = padraoInicioLinha.test(linha);
    if (ehCandidata) candidatas++;

    const m0 = linha.match(padraoLinhaRelatorio);
    if (m0) {
      codigo = m0[1];
      // tira a embalagem que vem no fim (UND, 1UND, UN...), colada ou não na descrição
      textoProduto = m0[2].trim().replace(/(\s+|(?<=[A-Za-zÀ-ÿ)]))\d*(UND?|CX|PCT?|KG|MT|PAR|JG|KIT|RL|BR)$/i, '').trim();
    }
    const m1 = codigo ? null : linha.match(padraoColunas);
    if (codigo) {
      // já reconhecida pelo formato do relatório 1147
    } else if (m1) {
      codigo = m1[1];
      textoProduto = m1[2].trim();
    } else {
      const m2 = linha.match(padraoAntigo);
      if (m2) {
        codigo = m2[1];
        textoProduto = `${m2[2].trim()} - ${m2[3].trim()}`;
      }
    }
    if (!codigo && ehCandidata) ignoradas.push(linha.trim());
    if (!codigo || encontrados.has(codigo)) continue;

    const masterProd = porCodigo.get(codigo);
    if (masterProd) {
      encontrados.set(codigo, { ...masterProd, foraDaBase: false });
    } else if (textoProduto) {
      // Produto ainda não cadastrado na base mestre do app — usa a
      // descrição direto do relatório, mas sinaliza pra conferência.
      let referencia = textoProduto, descricao = '';
      const partes = textoProduto.split(' - ');
      if (partes.length > 1) { referencia = partes[0].trim(); descricao = partes.slice(1).join(' - ').trim(); }
      else { descricao = textoProduto; referencia = codigo; }
      encontrados.set(codigo, {
        codigo, referencia, descricao, unidade: '',
        codigoBarras: '20' + String(codigo).padStart(10, '0'),
        temFoto: false, foraDaBase: true,
      });
    }
  }
  return { numeroInventario, produtos: Array.from(encontrados.values()), candidatas, ignoradas };
}

/* ---------------- ESTADO DA UI ---------------- */

const state = {
  tab: 'inventarios',
  currentInventoryId: null,
  currentRound: 1,
  produtoEncontrado: null,
  qtd: 0,
  qtdModo: 'simples',
  qtdAvaria: '',
  volumeLinhas: [],
  _volumesExpandida: true,
  _popupAberto: null,
  usuariosLista: [],
  _usuarioPopup: null,   // null | 'novo' | id do usuário
  _usuarioAcao: null,    // null | 'senha' | 'perfil' | 'ativo'
  _precisaDupla: false,
  arvore: '',
  lado: '',
  gerenciarTab: 'resumo',
  produtosSearch: '',
  produtosStatusFiltro: '',
  _confirmarExclusaoInv: false,
  _validar3a: false,
  _validarSubstituirRound: null,
  novoInventarioTexto: '',
  novoInventarioPreview: null,
};

function currentInventory() { return inventoriesCache.find(i => i.id === state.currentInventoryId) || null; }

/* ---------------- RENDER ---------------- */

const ICONES = {"scan-line": "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\"/><path d=\"M17 3h2a2 2 0 0 1 2 2v2\"/><path d=\"M21 17v2a2 2 0 0 1-2 2h-2\"/><path d=\"M7 21H5a2 2 0 0 1-2-2v-2\"/><path d=\"M7 12h10\"/>", "map-pin": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/></g>", "triangle-alert": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01\"/>", "rotate-cw": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/></g>", "pencil": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4\"/>", "package": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73zm1 .27V12\"/><path d=\"M3.29 7L12 12l8.71-5M7.5 4.27l9 5.15\"/></g>", "camera": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\"/><circle cx=\"12\" cy=\"13\" r=\"3\"/></g>", "circle-check": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m16 9l-5.5 5.5L8 12\"/></g>", "clipboard-list": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2m4 7h4m-4 5h4m-8-5h.01M8 16h.01\"/></g>", "chart-column": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 3v16a2 2 0 0 0 2 2h16m-3-4V9m-5 8V5M8 17v-3\"/>", "key-round": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\"/><circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/></g>", "user": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></g>", "x": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M18 6L6 18M6 6l12 12\"/>", "eye": "<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"><path d=\"M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></g>"};
function ICON(nome, tam = 24, extra = '') {
  return `<svg class="ico" viewBox="0 0 24 24" width="${tam}" height="${tam}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONES[nome] || ''}</svg>`;
}

function brandIcon() {
  return `<img src="assets/brand/icone-f-branco-transp.png" class="brand-ic" />`;
}

const app = document.getElementById('app');

function render() {
  if (!currentProfile) { app.innerHTML = viewLogin(); bindLogin(); return; }
  if (state._precisaDupla) { app.innerHTML = viewDupla(); bindDupla(); return; }

  let body = '';
  if (state.tab === 'inventarios') body = viewInventarios();
  else if (state.tab === 'inventariar') body = viewInventariar();
  else if (state.tab === 'relatorios' && currentProfile.role === 'gerenciar') body = viewRelatorios();
  else if (state.tab === 'usuarios' && currentProfile.role === 'gerenciar') body = viewUsuarios();
  else if (state.tab === 'perfil') body = viewPerfil();
  else body = viewInventarios();

  app.innerHTML = body;
  bindGlobal();
  bindUsuarios();
  bindPerfilSom();
}

function bindPerfilSom() {
  document.querySelectorAll('[data-tema]').forEach(b => b.onclick = () => { TEMA.pref = b.dataset.tema; TEMA.aplicar(); render(); });
  const chk = document.getElementById('chk-som');
  if (!chk) return;
  chk.onchange = () => { SOM.ligado = chk.checked; };
  document.getElementById('rng-vol').oninput = e => { SOM.volume = parseFloat(e.target.value); };
  document.getElementById('btn-testar-som').onclick = () => { destravarSom(); tocarSom('ok'); setTimeout(() => tocarSom('atencao'), 700); setTimeout(() => tocarSom('erro'), 1700); };
}

/* ---- LOGIN ---- */
function telaFundoLogin(conteudoCard) {
  return `
  <div style="display:flex;flex-direction:column;justify-content:center;min-height:100vh;padding:32px;background:var(--azul-escuro);position:relative;overflow:hidden;">
    <img src="assets/brand/marca-dagua-f.png" style="position:absolute;top:-60px;right:-90px;width:320px;opacity:0.07;pointer-events:none;" />
    <img src="assets/brand/marca-dagua-f.png" style="position:absolute;bottom:-100px;left:-110px;width:280px;opacity:0.05;pointer-events:none;transform:scaleX(-1);" />
    <div style="text-align:center;margin-bottom:36px;position:relative;">
      <img src="assets/brand/lockup-login-transp.png" alt="Fortal Alumínio" style="width:100%;max-width:290px;margin:0 auto 10px;display:block;" />
      <div style="color:#AFC3E0;font-size:13px;">Controle de estoque</div>
    </div>
    <div class="card" style="position:relative;z-index:1;">${conteudoCard}</div>
  </div>`;
}

function viewLogin() {
  return telaFundoLogin(`
      <div class="field">
        <label>Usuário</label>
        <input id="login-usuario" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Seu usuário" />
      </div>
      <div class="field" style="position:relative;">
        <label>Senha</label>
        <input id="login-senha" type="password" autocomplete="current-password" placeholder="Sua senha" style="padding-right:48px;" />
        <button type="button" id="btn-ver-senha" aria-label="Mostrar senha" style="position:absolute;right:6px;top:30px;width:40px;height:44px;background:none;border:none;font-size:18px;opacity:.55;">👁</button>
      </div>
      <button class="btn btn-primary" id="btn-entrar">ENTRAR</button>
      <div style="font-size:11px;color:var(--texto-suave);text-align:center;margin-top:12px;">
        Acesso restrito. Peça seu usuário e senha ao administrador.
      </div>`);
}

async function concluirEntrada() {
  await refreshInventories();
  assinarTempoReal();
  state.tab = 'inventarios';
  render();
}

function bindLogin() {
  const campoSenha = document.getElementById('login-senha');
  const campoUsuario = document.getElementById('login-usuario');
  document.getElementById('btn-ver-senha').onclick = () => {
    campoSenha.type = campoSenha.type === 'password' ? 'text' : 'password';
  };
  const entrar = async () => {
    const usuario = campoUsuario.value;
    const senha = campoSenha.value;
    if (!normalizarUsuario(usuario) || !senha) { showToast('Informe o usuário e a senha.', true); return; }
    const btn = document.getElementById('btn-entrar');
    btn.disabled = true; btn.textContent = 'ENTRANDO...';
    try {
      const perfil = await entrarComSenha(usuario, senha);
      aplicarPerfil(perfil, false);
      if (state._precisaDupla) { render(); return; }
      await concluirEntrada();
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'ENTRAR';
      showToast(err.message || 'Não foi possível entrar. Tente novamente.', true);
    }
  };
  document.getElementById('btn-entrar').onclick = entrar;
  [campoUsuario, campoSenha].forEach(c => c.addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); }));
}

/* Etapa da equipe de contagem (só para o perfil Inventariar) */
function viewDupla() {
  return telaFundoLogin(`
      <h3 style="margin:0 0 4px;font-size:17px;">Quem está contando agora?</h3>
      <div class="meta" style="margin-bottom:16px;">Acesso: <b>@${currentProfile.usuario}</b> (equipe de contagem)</div>
      <div class="field"><label>Apontador</label><input id="login-apontador" placeholder="Nome de quem aponta" autocomplete="off" /></div>
      <div class="field"><label>Contador</label><input id="login-contador" placeholder="Nome de quem conta" autocomplete="off" /></div>
      <button class="btn btn-primary" id="btn-continuar-dupla">CONTINUAR</button>
      <button class="btn btn-ghost" id="btn-sair-dupla" style="margin-top:6px;font-size:14px;">Sair</button>`);
}
function bindDupla() {
  document.getElementById('btn-sair-dupla').onclick = sairDoApp;
  document.getElementById('btn-continuar-dupla').onclick = async () => {
    const apontador = document.getElementById('login-apontador').value.trim();
    const contador = document.getElementById('login-contador').value.trim();
    if (!apontador || !contador) { showToast('Informe o nome do apontador e do contador.', true); return; }
    localStorage.setItem(DUPLA_KEY, JSON.stringify({ userId: currentProfile.id, apontador, contador }));
    currentProfile.nome = `${apontador} / ${contador}`;
    state._precisaDupla = false;
    const btn = document.getElementById('btn-continuar-dupla');
    btn.disabled = true; btn.textContent = 'ENTRANDO...';
    try { await concluirEntrada(); }
    catch (err) { btn.disabled = false; btn.textContent = 'CONTINUAR'; showToast(err.message || 'Erro ao entrar.', true); }
  };
}

/* ---- TABBAR ---- */
function tabbar() {
  const tabs = [
    { id: 'inventarios', ic: ICON('clipboard-list', 24), label: 'Inventários' },
    { id: 'inventariar', ic: ICON('scan-line', 24), label: 'Contagem' },
    ...(currentProfile.role === 'gerenciar' ? [{ id: 'relatorios', ic: ICON('chart-column', 24), label: 'Relatórios' }, { id: 'usuarios', ic: ICON('key-round', 24), label: 'Usuários' }] : []),
    { id: 'perfil', ic: ICON('user', 24), label: 'Perfil' },
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
  <div class="topbar"><div class="titles">${brandIcon()}<div><h1>Inventários</h1><div class="sub">${currentProfile.nome} · ${currentProfile.role === 'gerenciar' ? 'Gerenciar' : 'Inventariar'}</div></div></div></div>
  <div class="content">
    <div class="tabs-inline">
      <button data-invfilter="andamento" class="${filterTab==='andamento'?'active':''}">EM ANDAMENTO</button>
      <button data-invfilter="finalizados" class="${filterTab==='finalizados'?'active':''}">FINALIZADOS</button>
    </div>
    ${showList.length === 0 ? emptyState(ICON('package', 44), 'Nenhum inventário aqui ainda') : showList.map(cardInventario).join('')}
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
        <label>Selecione o arquivo PDF do relatório da rotina 1147 (WinThor)</label>
        <input type="file" id="file-winthor" accept="application/pdf" />
      </div>
      <div style="text-align:center;color:var(--texto-suave);font-size:12px;margin:10px 0;">— ou —</div>
      <div class="field">
        <label>Cole aqui o texto do relatório</label>
        <textarea id="txt-winthor" rows="5" style="width:100%;padding:12px;border-radius:10px;border:1.5px solid var(--borda);font-family:monospace;font-size:12px;">${state.novoInventarioTexto}</textarea>
      </div>
      <button class="btn btn-outline" id="btn-processar" style="margin-bottom:12px;">PROCESSAR TEXTO COLADO</button>
      ${preview ? `
        <div class="card">
          <h3>Inventário nº ${preview.numeroInventario || '(não identificado)'}</h3>
          <div class="meta">Produtos identificados: ${preview.produtos.length}${preview.candidatas ? ` · linhas de produto no PDF: ${preview.candidatas}` : ''}</div>
          ${preview.ignoradas && preview.ignoradas.length ? `
            <div class="meta" style="color:var(--vermelho);margin-top:6px;font-weight:600;">
              ⚠ ${preview.ignoradas.length} linha(s) do PDF NÃO foram reconhecidas e ficariam de fora. Não confirme — avise o TI.
              <div style="font-weight:400;font-size:11px;margin-top:4px;">${preview.ignoradas.slice(0, 5).map(esc).join('<br>')}</div>
            </div>` : ''}
          ${preview.produtos.some(p => p.foraDaBase) ? `
            <div class="meta" style="color:var(--laranja);margin-top:6px;">
              ⚠ ${preview.produtos.filter(p => p.foraDaBase).length} produto(s) não estão na base mestre do app —
              a descrição foi lida direto do PDF. Confira antes de confirmar.
            </div>
          ` : ''}
          <table class="report" style="margin-top:10px;">
            <tr><th>Cód.</th><th>Referência</th><th>Descrição</th><th></th></tr>
            ${preview.produtos.map(p => `<tr><td>${p.codigo}</td><td>${p.referencia}</td><td>${p.descricao}</td><td>${p.foraDaBase ? '<span class="badge badge-alerta">NOVO</span>' : ''}</td></tr>`).join('')}
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
  const divCritica = produtosDivergenciaCritica(inv);
  const contadosR1 = inv.products.filter(p => roundHasData(inv, p.codigo, 1)).length;
  const contadosR2 = inv.products.filter(p => roundHasData(inv, p.codigo, 2)).length;
  const contadosR3 = div.filter(p => roundHasData(inv, p.codigo, 3)).length;

  let body = '';
  if (state.gerenciarTab === 'resumo') {
    const pctGeral = Math.round(finalizados/inv.products.length*100) || 0;
    body = `
    <div class="card" style="text-align:center;background:var(--azul-escuro);border:none;position:relative;overflow:hidden;">
      <img src="assets/brand/marca-dagua-f.png" style="position:absolute;top:-20px;right:-30px;width:110px;opacity:0.08;pointer-events:none;" />
      <div style="color:#AFC3E0;font-size:12px;font-weight:600;letter-spacing:0.03em;position:relative;">BALANÇO CONCLUÍDO</div>
      <div style="color:var(--lima);font-size:44px;font-weight:800;line-height:1.1;position:relative;">${pctGeral}%</div>
      <div style="color:#AFC3E0;font-size:12px;position:relative;">${finalizados} de ${inv.products.length} produtos finalizados</div>
    </div>
    <div class="progress-row"><div class="label-row"><span>1ª CONTAGEM</span><span>${p1}% · ${contadosR1} de ${inv.products.length}</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p1}%"></div></div></div>
    <div class="progress-row"><div class="label-row"><span>2ª CONTAGEM</span><span>${p2}% · ${contadosR2} de ${inv.products.length}</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p2}%"></div></div></div>
    <div class="progress-row"><div class="label-row"><span>3ª CONTAGEM</span><span>${p3}% · ${contadosR3} de ${div.length}</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${p3}%"></div></div></div>
    ${divCritica.length ? `<div class="card" style="background:var(--vermelho-bg);border-color:var(--vermelho);"><h3 style="color:var(--vermelho);">⚠ Divergência crítica</h3><div class="meta" style="color:var(--vermelho);">${divCritica.length} produto(s) onde a 3ª contagem não bateu nem com a 1ª nem com a 2ª — revise manualmente na aba Produtos.</div></div>` : ''}
    ${div.length ? `<div class="card"><h3>⚠️ Divergências</h3><div class="meta">${div.length} produto(s) aguardando 3ª contagem</div></div>` : ''}
    <div class="card">
      <h3>Controle de etapas</h3>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
        ${!inv.roundClosed[1] ? `<button class="btn btn-outline btn-sm" data-encerrar="1">ENCERRAR 1ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[1] && !inv.roundOpen[2] && !inv.roundClosed[2] ? `<button class="btn btn-outline btn-sm" data-abrir="2">INICIAR 2ª CONTAGEM</button>` : ''}
        ${inv.roundOpen[2] && !inv.roundClosed[2] ? `<button class="btn btn-outline btn-sm" data-encerrar="2">ENCERRAR 2ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[2] && div.length > 0 && !inv.roundOpen[3] && !inv.roundClosed[3] ? `<button class="btn btn-outline btn-sm" data-abrir="3">INICIAR 3ª CONTAGEM</button>` : ''}
        ${inv.roundOpen[3] && !inv.roundClosed[3] ? `<button class="btn btn-outline btn-sm" data-encerrar="3">ENCERRAR 3ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[2] && (div.length === 0 || inv.roundClosed[3]) && divCritica.length === 0 && inv.status !== 'finalizado' ? `<button class="btn btn-success btn-sm" data-finalizar="1">FINALIZAR INVENTÁRIO</button>` : ''}
        ${inv.roundClosed[3] && divCritica.length > 0 ? `<div class="meta" style="color:var(--vermelho);">Corrija as divergências críticas antes de finalizar.</div>` : ''}
      </div>
      <div class="meta" style="font-weight:600;margin:14px 0 8px;">Reabrir uma contagem</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${inv.roundClosed[1] ? `<button class="btn btn-outline btn-sm" style="border-color:var(--laranja);color:var(--laranja);" data-reabrir="1">REABRIR 1ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[2] ? `<button class="btn btn-outline btn-sm" style="border-color:var(--laranja);color:var(--laranja);" data-reabrir="2">REABRIR 2ª CONTAGEM</button>` : ''}
        ${inv.roundClosed[3] ? `<button class="btn btn-outline btn-sm" style="border-color:var(--laranja);color:var(--laranja);" data-reabrir="3">REABRIR 3ª CONTAGEM</button>` : ''}
        ${!inv.roundClosed[1] && !inv.roundClosed[2] && !inv.roundClosed[3] ? `<div class="meta">Nenhuma contagem encerrada ainda.</div>` : ''}
      </div>
    </div>
    <button class="btn btn-primary" id="btn-export-xlsx" style="margin-bottom:8px;">RELATÓRIO COMPLETO (EXCEL — RESUMO + DETALHAMENTO)</button>
    <button class="btn btn-outline" id="btn-atualizar-dados" style="margin-bottom:14px;">🔄 ATUALIZAR DADOS (antes de gerar relatórios)</button>
    <button class="btn btn-ghost" id="btn-export-acompanhamento" style="margin-bottom:8px;">RELATÓRIO DE ACOMPANHAMENTO (1 LINHA POR PRODUTO, COM LOCALIZAÇÃO E QUEM CONTOU)</button>
    <button class="btn btn-ghost" id="btn-export-csv" style="margin-bottom:12px;">EXCEL DOS LANÇAMENTOS ATUAIS (CSV — detalhado, uma linha por leitura)</button>
    <div class="meta" style="font-weight:600;margin-bottom:8px;">Baixar só uma contagem</div>
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn btn-outline btn-sm" data-export-round="1" style="flex:1;">1ª CONTAGEM</button>
      <button class="btn btn-outline btn-sm" data-export-round="2" style="flex:1;">2ª CONTAGEM</button>
      <button class="btn btn-outline btn-sm" data-export-round="3" style="flex:1;">3ª CONTAGEM</button>
    </div>
    <div class="meta" style="font-weight:600;margin-bottom:8px;">Arquivo pra importar no WinThor (rotina 1147)</div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-outline btn-sm" data-export-txt="1" style="flex:1;">1ª CONTAGEM</button>
      <button class="btn btn-outline btn-sm" data-export-txt="2" style="flex:1;">2ª CONTAGEM</button>
      <button class="btn btn-outline btn-sm" data-export-txt="3" style="flex:1;">3ª CONTAGEM</button>
    </div>
    <div style="border-top:1px solid var(--borda);margin:28px 0 16px;padding-top:20px;">
      <div class="meta" style="font-weight:700;color:var(--vermelho);margin-bottom:8px;">ZONA DE RISCO</div>
      ${!state._confirmarExclusaoInv ? `
        <button class="btn btn-outline" id="btn-excluir-inventario" style="border-color:var(--vermelho);color:var(--vermelho);">EXCLUIR ESTE INVENTÁRIO</button>
      ` : `
        <div class="card" style="background:var(--vermelho-bg);border-color:var(--vermelho);">
          <h3 style="color:var(--vermelho);">Tem certeza?</h3>
          <div class="meta" style="color:var(--vermelho);margin-bottom:14px;">
            Isso apaga o Inventário ${inv.numero} inteiro — todos os produtos, lançamentos e correções.
            Não pode ser desfeito.
          </div>
          <button class="btn" style="background:var(--vermelho);color:#fff;margin-bottom:8px;" id="btn-excluir-inventario-confirmado">SIM, EXCLUIR O INVENTÁRIO ${inv.numero}</button>
          <button class="btn btn-ghost" id="btn-cancelar-exclusao-inv">CANCELAR</button>
        </div>
      `}
    </div>`;
  } else if (state.gerenciarTab === 'produtos') {
    const termo = (state.produtosSearch || '').trim().toLowerCase();
    const statusFiltro = state.produtosStatusFiltro || '';
    const produtosFiltrados = inv.products
      .filter(p =>
        !termo ||
        String(p.codigo).toLowerCase() === termo ||
        (p.referencia || '').toLowerCase().includes(termo) ||
        (p.descricao || '').toLowerCase().includes(termo))
      .filter(p => !statusFiltro || productStatus(inv, p.codigo).status === statusFiltro)
      .sort((a, b) => parseInt(a.codigo, 10) - parseInt(b.codigo, 10));
    body = `
      <div class="field" style="margin-bottom:10px;">
        <input id="produtos-search" placeholder="Buscar por código, referência ou descrição..." value="${state.produtosSearch || ''}" />
      </div>
      <div class="field" style="margin-bottom:12px;">
        <select id="produtos-status-filtro">
          <option value="">Todos os status</option>
          <option value="AGUARDANDO 1ª" ${statusFiltro==='AGUARDANDO 1ª'?'selected':''}>Aguardando 1ª</option>
          <option value="EM CONTAGEM (1ª)" ${statusFiltro==='EM CONTAGEM (1ª)'?'selected':''}>Em contagem (1ª)</option>
          <option value="AGUARDANDO 2ª" ${statusFiltro==='AGUARDANDO 2ª'?'selected':''}>Aguardando 2ª</option>
          <option value="EM CONTAGEM (2ª)" ${statusFiltro==='EM CONTAGEM (2ª)'?'selected':''}>Em contagem (2ª)</option>
          <option value="AGUARDANDO 3ª" ${statusFiltro==='AGUARDANDO 3ª'?'selected':''}>⚠️ Aguardando 3ª (divergência)</option>
          <option value="EM CONTAGEM (3ª)" ${statusFiltro==='EM CONTAGEM (3ª)'?'selected':''}>Em contagem (3ª)</option>
          <option value="NÃO CONTADO" ${statusFiltro==='NÃO CONTADO'?'selected':''}>⬜ Não contado (nem 1ª nem 2ª)</option>
          <option value="DIVERGÊNCIA CRÍTICA" ${statusFiltro==='DIVERGÊNCIA CRÍTICA'?'selected':''}>🔴 Divergência crítica</option>
          <option value="FINALIZADO" ${statusFiltro==='FINALIZADO'?'selected':''}>✓ Finalizado</option>
        </select>
      </div>
      <div class="meta" style="margin-bottom:8px;">${produtosFiltrados.length} de ${inv.products.length} produtos</div>
      <table class="report"><tr><th>Cód</th><th>Ref</th><th>1ª</th><th>2ª</th><th>3ª</th><th>Final</th><th>Avaria</th><th>Status</th></tr>
      ${produtosFiltrados.map(p => {
        const s = productStatus(inv, p.codigo);
        const avaria = inv.entries.filter(e => e.codigo === p.codigo).reduce((soma, e) => soma + (e.qtdAvaria || 0), 0);
        return `<tr data-corrigir="${p.codigo}"><td>${p.codigo}</td><td>${p.referencia}</td><td>${s.t1?formatNumeroBR(s.t1):'-'}</td><td>${s.t2?formatNumeroBR(s.t2):'-'}</td><td>${s.t3?formatNumeroBR(s.t3):'-'}</td><td><b>${s.final!=null?formatNumeroBR(s.final):'-'}</b></td><td>${avaria ? `<span style="color:var(--laranja);font-weight:700;">${formatNumeroBR(avaria)}</span>` : '-'}</td><td>${statusBadge(s.status)}</td></tr>`;
      }).join('')}</table>`;
  } else if (state.gerenciarTab === 'equipe') {
    const totalLancamentos = inv.entries.length;
    const porUsuario = {};
    inv.entries.forEach(e => {
      if (!porUsuario[e.userName]) porUsuario[e.userName] = { lancamentos: 0, produtos: new Set() };
      porUsuario[e.userName].lancamentos += 1;
      porUsuario[e.userName].produtos.add(e.codigo);
    });
    const linhas = Object.entries(porUsuario).sort((a, b) => b[1].lancamentos - a[1].lancamentos);
    body = linhas.length === 0 ? emptyState(ICON('user', 44),'Nenhum lançamento ainda') : `
      <div class="meta" style="margin-bottom:10px;">${totalLancamentos} lançamentos no total, de ${linhas.length} pessoa(s)</div>
      ${linhas.map(([nome, d]) => {
        const pctColab = totalLancamentos ? Math.round((d.lancamentos / totalLancamentos) * 100) : 0;
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <h3>${nome}</h3><span class="badge badge-andamento">${pctColab}% do total</span>
          </div>
          <div class="meta">${d.produtos.size} produto(s) contado(s) · ${d.lancamentos} lançamento(s)</div>
          <div class="progress-bar-bg" style="margin-top:8px;"><div class="progress-bar-fill" style="width:${pctColab}%"></div></div>
        </div>`;
      }).join('')}`;
  }

  return `
  <div class="topbar">
    <button class="icon-btn" id="btn-voltar-inv">←</button>
    <div class="titles">${brandIcon()}<div><h1>Inventário ${inv.numero}</h1><div class="sub">${inv.products.length} produtos</div></div></div>
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
  if (status === 'DIVERGÊNCIA CRÍTICA') return `<span class="badge badge-erro">⚠ DIVERGÊNCIA CRÍTICA</span>`;
  return `<span class="badge badge-andamento">${status}</span>`;
}

function modalCorrecao(inv) {
  if (!state._corrigirCodigo) return '';
  const p = inv.products.find(p => p.codigo === state._corrigirCodigo);
  const s = productStatus(inv, p.codigo);
  const lancamentos = inv.entries.filter(e => e.codigo === p.codigo).sort((a, b) => a.round - b.round);
  const round = state._corrigirRound || 1;
  const totalAtualRound = effectiveRoundTotal(inv, p.codigo, round);
  return `
  <div style="position:fixed;inset:0;background:rgba(11,37,69,0.55);z-index:40;display:flex;align-items:center;justify-content:center;">
    <div class="card" style="width:88%;max-width:380px;max-height:85vh;overflow:auto;">
      <h3>Corrigir — ${p.referencia}</h3>
      <div class="meta" style="margin-bottom:14px;">1ª: <b>${formatNumeroBR(s.t1)}</b> · 2ª: <b>${formatNumeroBR(s.t2)}</b> · 3ª: <b>${formatNumeroBR(s.t3)}</b> · Final: <b>${s.final!=null?formatNumeroBR(s.final):'-'}</b></div>
      ${s.status === 'DIVERGÊNCIA CRÍTICA' ? `
        <div class="card" style="background:var(--laranja-bg);border-color:var(--laranja);margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
            <input type="checkbox" id="chk-validar-3a" ${state._validar3a ? 'checked' : ''} style="width:20px;height:20px;flex-shrink:0;" />
            <span style="font-weight:700;color:var(--laranja);">✓ Validar a 3ª contagem (${formatNumeroBR(s.t3)}) como correta</span>
          </label>
          ${state._validar3a ? `
            <div class="meta" style="margin:12px 0 6px;">A equipe errou na 1ª ou na 2ª — substituir qual pela 3ª?</div>
            <div style="display:flex;gap:8px;margin-bottom:12px;">
              <button data-validar-substituir="1" class="btn btn-sm ${state._validarSubstituirRound===1?'btn-primary':'btn-outline'}" style="flex:1;">1ª (era ${formatNumeroBR(s.t1)})</button>
              <button data-validar-substituir="2" class="btn btn-sm ${state._validarSubstituirRound===2?'btn-primary':'btn-outline'}" style="flex:1;">2ª (era ${formatNumeroBR(s.t2)})</button>
            </div>
            <div class="field"><label>Motivo do ajuste</label><input id="validar-motivo" placeholder="Ex: 3ª contagem feita com mais gente, validada pelo administrador" /></div>
            <button class="btn btn-success" id="btn-aplicar-validacao-3a" ${state._validarSubstituirRound ? '' : 'disabled'}>APLICAR E VALIDAR</button>
          ` : ''}
        </div>
      ` : ''}
      ${lancamentos.length ? `
        <div class="meta" style="font-weight:600;margin-bottom:6px;">Onde foi contado</div>
        <table class="report" style="margin-bottom:16px;">
          <tr><th>Cont.</th><th>Qtd</th><th>Como</th><th>Avaria</th><th>Árvore</th><th>Lado</th><th>Quem</th><th></th></tr>
          ${lancamentos.map(e => {
            const maisRecenteDaRodada3 = e.round === 3 && lancamentos.filter(x => x.round === 3).reduce((a, b) => new Date(a.timestamp) > new Date(b.timestamp) ? a : b).id === e.id;
            return `<tr style="${maisRecenteDaRodada3 ? 'background:var(--verde-bg);' : ''}"><td>${e.round}ª${maisRecenteDaRodada3 ? ' ✓' : ''}</td><td>${formatNumeroBR(e.quantity)}</td><td>${formatarDetalhe(e.detalheContagem)}</td><td>${e.qtdAvaria ? formatNumeroBR(e.qtdAvaria) : '-'}</td><td>${e.arvore || '-'}</td><td>${e.lado || '-'}</td><td>${e.userName || '-'}</td><td><button data-excluir-lancamento="${e.id}" style="background:none;border:none;color:var(--vermelho);font-size:15px;padding:0 4px;" title="Excluir este lançamento">✕</button></td></tr>`;
          }).join('')}
        </table>
        <div class="meta" style="margin-top:-10px;margin-bottom:16px;">✓ = lançamento da 3ª contagem que está valendo (mais recente — a 3ª é soberana, não soma).</div>
      ` : ''}
      ${p ? (() => {
        const correcoesDoProduto = inv.corrections.filter(c => c.codigo === p.codigo).sort((a, b) => a.round - b.round);
        if (!correcoesDoProduto.length) return '';
        return `
        <div class="meta" style="font-weight:600;margin-bottom:6px;">Correções feitas (sobrescrevem os lançamentos)</div>
        <table class="report" style="margin-bottom:16px;">
          <tr><th>Cont.</th><th>Novo total</th><th>Motivo</th><th>Quem</th><th></th></tr>
          ${correcoesDoProduto.map(c => `<tr><td>${c.round}ª</td><td><b>${formatNumeroBR(c.newTotal)}</b></td><td>${c.reason || '-'}</td><td>${c.userName || '-'}</td><td><button data-excluir-correcao="${c.id}" style="background:none;border:none;color:var(--vermelho);font-size:15px;padding:0 4px;" title="Excluir esta correção">✕</button></td></tr>`).join('')}
        </table>
      `; })() : ''}
      <div class="field">
        <label>Qual contagem corrigir?</label>
        <div class="tabs-inline" style="margin-bottom:0;">
          ${[1,2,3].filter(r => roundHasData(inv, p.codigo, r) || inv.roundClosed[r]).map(r => `<button data-corr-round="${r}" class="${round===r?'active':''}">${r}ª CONTAGEM</button>`).join('')}
        </div>
      </div>
      ${lancamentos.some(e => e.round === round) ? `<button class="btn btn-ghost" style="color:var(--vermelho);margin-bottom:10px;" id="btn-excluir-todos-rodada">EXCLUIR TODOS OS LANÇAMENTOS DA ${round}ª CONTAGEM (só deste produto)</button>` : ''}
      <div class="field"><label>Novo total da ${round}ª contagem</label><input id="corr-novo-total" type="number" value="${totalAtualRound}" /></div>
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
    <div class="topbar"><div class="titles">${brandIcon()}<h1>Inventariar</h1></div></div>
    <div class="content">
      <p class="meta" style="margin-bottom:10px;">Selecione o inventário:</p>
      ${inventarios.length === 0 ? emptyState(ICON('package', 44),'Nenhum inventário em andamento') :
        inventarios.map(inv => `<div class="card" data-select-count-inv="${inv.id}"><h3>Inventário ${inv.numero}</h3><div class="meta">${inv.products.length} produtos</div></div>`).join('')}
    </div>
    ${tabbar()}`;
  }

  const inv = currentInventory();
  if (!inv) { state.currentInventoryId = null; return viewInventariar(); }

  const p = state.produtoEncontrado;
  const rodadaHabilitada = r => inv.roundOpen[r] || (r === 1 && !inv.roundClosed[1]);

  return `
  <div class="topbar">
    <button class="icon-btn" id="btn-sair-contagem">←</button>
    <div class="titles">${brandIcon()}<div><h1>INVENTARIAR – INV. ${inv.numero}</h1><div class="sub">${currentProfile.nome}</div></div></div>
    <div style="width:36px;"></div>
  </div>
  <div class="content">
    ${!p ? `
      <div class="icon-toolbar" style="grid-template-columns:1fr;">
        <button data-abrir-popup="contagem"><span class="ic">${ICON('rotate-cw', 26)}</span><span>${state.currentRound}ª contagem</span></button>
      </div>
      <div class="field"><label>CÓDIGO OU CÓDIGO DE BARRAS</label>
        <div class="campo-com-camera">
          <input id="input-codigo" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Digite o código ou toque na câmera" autofocus />
          <button type="button" id="btn-abrir-camera" class="btn-camera" aria-label="Escanear com a câmera" title="Escanear com a câmera">${ICON('camera', 24)}</button>
        </div>
      </div>
      <div id="qr-reader" style="display:none;"></div>
      <button class="btn btn-primary" id="btn-buscar-produto">BUSCAR</button>
      ${popupInventariar(inv, rodadaHabilitada)}
    ` : `
      <div class="lanc">
        <div class="lanc-info">
          <span class="cod-pill">CÓD. ${p.codigo}</span>
          <div class="lanc-txt"><div class="lanc-ref">${p.referencia}</div><div class="lanc-desc">${p.descricao}</div></div>
        </div>
        <div class="lanc-foto">
          ${p.temFoto ? `<img src="assets/products/${p.codigo}.png" alt="${esc(p.referencia)}" />` : `<div class="no-photo">SEM FOTO</div>`}
          <button type="button" class="lanc-cont" data-abrir-popup="contagem" aria-label="${state.currentRound}ª contagem — toque para trocar">${state.currentRound}</button>
        </div>
        <div class="icon-toolbar" style="grid-template-columns:1fr 1fr;">
          <button data-qtdmodo="simples" class="${state.qtdModo==='simples'?'active':''}"><span class="ic">${ICON('pencil', 22)}</span><span>SIMPLES</span></button>
          <button data-qtdmodo="volumes" class="${state.qtdModo==='volumes'?'active':''}"><span class="ic">${ICON('package', 22)}</span><span>VOLUMES</span></button>
        </div>
        ${state.qtdModo === 'simples' ? `
          <div class="qtd-control">
            <button id="qtd-menos">−</button><input id="qtd-input" type="number" inputmode="numeric" pattern="[0-9]*" value="${state.qtd}" /><button id="qtd-mais">+</button>
          </div>
        ` : `
          <div class="loc-resumo" style="margin-bottom:0;">
            <span style="display:inline-flex;align-items:center;gap:6px;">${ICON('package', 18)} Total por volumes: <b>${formatNumeroBR(calcularTotalVolumes())}</b></span>
            <button data-abrir-popup="volumes">${calcularTotalVolumes() > 0 ? 'ALTERAR' : '+ DEFINIR'}</button>
          </div>
        `}
        <div class="lanc-obs">
          <button data-abrir-popup="local"><span class="ic">${ICON('map-pin', 24)}</span><span class="tx"><small>Local</small><b>${['Pátio','Almoxarifado','Vitrine'].includes(state.arvore) ? state.arvore : (state.arvore ? `Árv. ${state.arvore}${state.lado ? ' / ' + state.lado : ''}` : 'Definir')}</b></span></button>
          <button data-abrir-popup="avaria"><span class="ic ic-avaria">${ICON('triangle-alert', 24)}</span><span class="tx"><small>Avaria</small><b>${state.qtdAvaria ? formatNumeroBR(parseFloat(String(state.qtdAvaria).replace(',', '.')) || 0) : 'Avaria'}</b></span></button>
        </div>
      </div>
      <div class="registrar-fixo" style="display:flex;gap:10px;">
        <button class="btn btn-lima" id="btn-registrar" style="flex:3;">REGISTRAR</button>
        <button class="btn btn-outline" id="btn-cancelar-produto" style="flex:1.2;font-size:13px;">CANCELAR</button>
      </div>
      ${popupInventariar(inv, rodadaHabilitada)}
    `}
  </div>
  ${tabbar()}`;
}

function popupInventariar(inv, rodadaHabilitada) {
  if (!state._popupAberto) return '';
  let titulo = '', conteudo = '';
  if (state._popupAberto === 'local') {
    titulo = 'Localização';
    const especiais = ['Pátio', 'Almoxarifado', 'Vitrine'];
    const tipoAtual = especiais.includes(state.arvore) ? state.arvore : 'Árvore';
    conteudo = `
      <div class="field">
        <label>Tipo de local</label>
        <select id="input-tipo-local">
          <option value="Árvore" ${tipoAtual==='Árvore'?'selected':''}>🌳 Árvore</option>
          <option value="Pátio" ${tipoAtual==='Pátio'?'selected':''}>🪵 Pátio (mercadoria no chão)</option>
          <option value="Almoxarifado" ${tipoAtual==='Almoxarifado'?'selected':''}>📦 Almoxarifado</option>
          <option value="Vitrine" ${tipoAtual==='Vitrine'?'selected':''}>🪟 Vitrine</option>
        </select>
      </div>
      <div id="campos-arvore-lado" style="${tipoAtual==='Árvore'?'':'display:none;'}">
        <div class="field"><label>Árvore</label><input id="input-arvore" placeholder="Ex: 1" value="${tipoAtual==='Árvore'?state.arvore:''}" /></div>
        <div class="field"><label>Lado</label><input id="input-lado" placeholder="Ex: B" value="${state.lado}" /></div>
      </div>
      <button class="btn btn-lima" id="btn-confirmar-popup">CONFIRMAR</button>`;
  } else if (state._popupAberto === 'avaria') {
    titulo = 'Avaria';
    conteudo = `
      <div class="field"><label>Quantidade avariada</label><input id="input-avaria" type="text" inputmode="decimal" placeholder="Ex: 5 — deixe em branco se não houver" value="${state.qtdAvaria}" /></div>
      <div class="aviso-avaria">
        <b>Como funciona</b>
        <ul>
          <li>A avaria já está <b>dentro</b> da quantidade que você contou. Não some por fora: se contou 20 e 5 estão avariados, registre 20 e avaria 5.</li>
          <li>Não pode ser maior que o total do lançamento.</li>
          <li>Vale só para este lançamento. No relatório, a coluna Avaria soma as avarias de todos os lançamentos do produto.</li>
          <li>Não altera a quantidade contada nem a comparação entre as contagens.</li>
        </ul>
      </div>
      <button class="btn btn-lima" id="btn-confirmar-popup">CONFIRMAR</button>`;
  } else if (state._popupAberto === 'contagem') {
    titulo = 'Qual contagem?';
    conteudo = [1,2,3].map(r => {
      const habilitada = rodadaHabilitada(r);
      const atual = state.currentRound === r;
      return `<button data-escolher-round="${r}" ${habilitada ? '' : 'disabled'} class="btn ${habilitada ? 'btn-lima' : ''} btn-sm" style="width:100%;margin-bottom:10px;${!habilitada ? 'background:#eeeef0;color:#b4b7be;' : ''}">${r}ª CONTAGEM${atual && habilitada ? ' (atual)' : ''}${!habilitada ? ' (bloqueada)' : ''}</button>`;
    }).join('');
  } else if (state._popupAberto === 'volumes') {
    titulo = 'Por volumes';
    conteudo = `
      <div class="meta" style="margin-bottom:10px;">Uma linha por combinação — deixe "Unidade" em branco quando for só peça solta.</div>
      <div style="display:flex;gap:8px;margin-bottom:4px;">
        <div style="flex:1;font-size:11px;color:var(--texto-suave);font-weight:600;">VOLUME</div>
        <div style="width:14px;"></div>
        <div style="flex:1;font-size:11px;color:var(--texto-suave);font-weight:600;">UNIDADE</div>
        <div style="width:26px;"></div>
      </div>
      ${state.volumeLinhas.map((linha, i) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <input data-linha-idx="${i}" data-campo="qtd" type="text" inputmode="decimal" placeholder="Ex: 22" value="${linha.qtd}" style="flex:1;min-width:0;" />
          <span style="color:var(--texto-suave);font-weight:700;">×</span>
          <input data-linha-idx="${i}" data-campo="pecas" type="text" inputmode="decimal" placeholder="Ex: 12 (opcional)" value="${linha.pecas}" style="flex:1;min-width:0;" />
          <button data-remover-linha="${i}" style="background:none;border:none;color:var(--vermelho);font-size:18px;padding:0 4px;">✕</button>
        </div>
      `).join('')}
      <button class="btn btn-outline btn-sm" id="btn-add-linha" style="width:100%;margin-bottom:10px;">+ ADICIONAR LINHA</button>
      <div style="text-align:center;background:var(--azul-claro);border-radius:10px;padding:10px;margin-bottom:12px;">
        <div style="font-size:11px;color:var(--texto-suave);">TOTAL CALCULADO</div>
        <div style="font-size:24px;font-weight:800;color:var(--texto);">${formatNumeroBR(calcularTotalVolumes())}</div>
      </div>
      <button class="btn btn-lima" id="btn-confirmar-volumes">CONFIRMAR</button>`;
  }
  return `
  <div class="popup-overlay">
    <div class="popup-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 style="margin:0;">${titulo}</h3>
        <button id="btn-fechar-popup" class="popup-close">✕</button>
      </div>
      ${conteudo}
    </div>
  </div>`;
}

/* ---- RELATÓRIOS ---- */
function viewRelatorios() {
  return `
  <div class="topbar"><div class="titles">${brandIcon()}<h1>Relatórios</h1></div></div>
  <div class="content">
    ${inventoriesCache.length === 0 ? emptyState(ICON('chart-column', 44),'Nenhum inventário ainda') : inventoriesCache.map(inv => {
      const div = divergentProducts(inv);
      return `<div class="card"><h3>Inventário ${inv.numero}</h3><div class="meta">${inv.entries.length} lançamentos · ${div.length} divergência(s)</div>
        <button class="btn btn-outline btn-sm" style="margin-top:10px;" data-export-final="${inv.id}">EXPORTAR EXCEL FINAL (CSV)</button></div>`;
    }).join('')}
  </div>
  ${tabbar()}`;
}

/* ---- PERFIL ---- */
function viewPerfil() {
  const minhasEntradas = currentProfile.role === 'inventariar'
    ? inventoriesCache.flatMap(inv => inv.entries
        .filter(e => e.userName === currentProfile.nome)
        .map(e => ({ ...e, inv })))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    : [];

  return `
  <div class="topbar"><div class="titles">${brandIcon()}<h1>Perfil</h1></div></div>
  <div class="content">
    <div class="card"><h3>${esc(currentProfile.nome)}</h3><div class="meta">Acesso: @${esc(currentProfile.usuario)} · Perfil: ${currentProfile.role === 'gerenciar' ? 'Gerenciar' : 'Inventariar'}</div></div>
    <div class="card" id="card-tema">
      <h3 style="margin-bottom:12px;">Aparência</h3>
      <div class="seg-tema">
        ${[['claro','Claro'],['escuro','Escuro'],['auto','Automático']].map(([k,l]) => `<button type="button" data-tema="${k}" class="${TEMA.pref===k?'active':''}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="card" id="card-som">
      <h3 style="display:flex;align-items:center;gap:8px;">Som de confirmação</h3>
      <label class="linha-som"><input type="checkbox" id="chk-som" ${SOM.ligado ? 'checked' : ''} /> <span>Tocar som ao lançar</span></label>
      <div class="linha-som"><span>Volume</span><input type="range" id="rng-vol" min="0" max="1" step="0.05" value="${SOM.volume}" /></div>
      <button class="btn btn-outline btn-sm" id="btn-testar-som" type="button">TESTAR SOM</button>
    </div>
    <button class="btn btn-outline" id="btn-sair" style="margin-bottom:18px;">SAIR</button>
    ${currentProfile.role === 'inventariar' ? `
      <div class="meta" style="font-weight:600;margin-bottom:8px;">Produtos que eu contei (${minhasEntradas.length})</div>
      ${minhasEntradas.length === 0 ? emptyState(ICON('package', 44),'Você ainda não registrou nenhuma contagem') : `
        <div class="lista-scroll">
          ${minhasEntradas.map(e => {
            const p = e.inv.products.find(p => p.codigo === e.codigo);
            return `<div class="card">
              <div style="display:flex;justify-content:space-between;align-items:start;">
                <h3>${p?.referencia || e.codigo} <span style="color:var(--texto-suave);font-weight:600;">· Cód. ${e.codigo}</span></h3>
                <span class="badge badge-andamento">${e.round}ª contagem</span>
              </div>
              <div class="meta">${p?.descricao || ''}</div>
              <div class="meta">Qtd: <b>${formatNumeroBR(e.quantity)}</b>${e.detalheContagem ? ` (${formatarDetalhe(e.detalheContagem)})` : ''}${e.qtdAvaria ? ` · <span style="color:var(--laranja);">${formatNumeroBR(e.qtdAvaria)} avariada</span>` : ''}${e.arvore ? ` · Árvore ${e.arvore}` : ''}${e.lado ? ` · Lado ${e.lado}` : ''} · Inventário ${e.inv.numero}</div>
            </div>`;
          }).join('')}
        </div>
      `}
    ` : ''}
  </div>
  ${tabbar()}`;
}

/* ---- USUÁRIOS (só Gerenciar) ---- */
function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function carregarUsuarios() {
  const { data, error } = await sb.from('profiles')
    .select('id,nome,usuario,role,ativo,created_at')
    .not('usuario', 'is', null)
    .order('nome');
  if (error) { showToast('Não foi possível carregar os usuários: ' + error.message, true, 4000); return; }
  state.usuariosLista = data || [];
}

function rotuloPerfil(role) { return role === 'gerenciar' ? 'Gerenciar' : 'Inventariar'; }
function classeBadgePerfil(u) {
  if (!u.ativo) return 'badge-erro';
  return u.role === 'gerenciar' ? 'badge-andamento' : 'badge-sucesso';
}

function cardUsuario(u) {
  return `<div class="card" data-editar-usuario="${u.id}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;">
    <div style="min-width:0;">
      <h3>${esc(u.nome)}${u.id === currentProfile.id ? ' <span style="color:var(--texto-suave);font-weight:500;">(você)</span>' : ''}</h3>
      <div class="meta">@${esc(u.usuario)}${u.ativo ? '' : ' · desativado'}</div>
    </div>
    <span class="badge ${classeBadgePerfil(u)}">${rotuloPerfil(u.role)}</span>
  </div>`;
}

function viewUsuarios() {
  const lista = state.usuariosLista;
  return `
  <div class="topbar"><div class="titles">${brandIcon()}<h1>Usuários</h1></div></div>
  <div class="content">
    ${lista.length === 0 ? emptyState(ICON('key-round', 44), 'Nenhum usuário cadastrado ainda') : lista.map(cardUsuario).join('')}
  </div>
  <button class="fab" id="fab-novo-usuario">+</button>
  ${popupUsuario()}
  ${tabbar()}`;
}

function popupUsuario() {
  const alvo = state._usuarioPopup;
  if (!alvo) return '';
  const fechar = `<button id="btn-fechar-popup-usuario" class="popup-close">✕</button>`;
  const envolver = (inner) => `<div class="popup-overlay"><div class="popup-card" style="max-width:340px;width:88%;">${inner}</div></div>`;
  const btnPeq = 'padding:13px;font-size:15px;';

  if (alvo === 'novo') {
    return envolver(`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;"><h3 style="margin:0;font-size:17px;">Novo usuário</h3>${fechar}</div>
      <div class="field" style="margin-bottom:12px;"><label>Nome</label><input id="nu-nome" autocomplete="off" placeholder="Ex: Ana Souza" /></div>
      <div class="field" style="margin-bottom:12px;"><label>Usuário (para entrar)</label><input id="nu-usuario" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Ex: ana.souza" /></div>
      <div class="field" style="margin-bottom:12px;"><label>Senha inicial</label><input id="nu-senha" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Mínimo 8 caracteres" /></div>
      <div class="field" style="margin-bottom:16px;"><label>Perfil</label><select id="nu-role"><option value="inventariar">Inventariar</option><option value="gerenciar">Gerenciar</option></select></div>
      <div style="display:flex;gap:10px;"><button class="btn btn-outline" id="btn-cancelar-usuario" style="${btnPeq}">CANCELAR</button><button class="btn btn-primary" id="btn-criar-usuario" style="${btnPeq}">CRIAR</button></div>`);
  }

  const u = state.usuariosLista.find(x => x.id === alvo);
  if (!u) return '';
  const euMesmo = u.id === currentProfile.id;
  const cab = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><h3 style="margin:0;font-size:17px;">${esc(u.nome)}</h3>${fechar}</div>
    <div class="meta" style="margin-bottom:16px;">@${esc(u.usuario)} · <span class="badge ${classeBadgePerfil(u)}">${rotuloPerfil(u.role)}</span>${u.ativo ? '' : ' · desativado'}</div>`;
  const voltar = `<button class="btn btn-outline" id="btn-acao-voltar" style="${btnPeq}">VOLTAR</button>`;

  if (state._usuarioAcao === 'senha') {
    return envolver(cab + `
      <div class="field" style="margin-bottom:16px;"><label>Nova senha</label><input id="ed-senha" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Mínimo 8 caracteres" /></div>
      <div style="display:flex;gap:10px;">${voltar}<button class="btn btn-primary" id="btn-salvar-senha" style="${btnPeq}">SALVAR</button></div>`);
  }
  if (state._usuarioAcao === 'perfil') {
    const outro = u.role === 'gerenciar' ? 'inventariar' : 'gerenciar';
    return envolver(cab + `
      <div class="field" style="margin-bottom:16px;"><label>Novo perfil</label>
        <select id="ed-role"><option value="inventariar" ${outro === 'inventariar' ? 'selected' : ''}>Inventariar</option><option value="gerenciar" ${outro === 'gerenciar' ? 'selected' : ''}>Gerenciar</option></select></div>
      <div style="display:flex;gap:10px;">${voltar}<button class="btn btn-primary" id="btn-salvar-perfil" style="${btnPeq}">SALVAR</button></div>`);
  }
  if (state._usuarioAcao === 'ativo') {
    return envolver(cab + `
      <div style="font-size:14px;margin-bottom:16px;">${u.ativo
        ? 'Desativar o acesso deste usuário? Ele será desconectado e não conseguirá mais entrar.'
        : 'Reativar o acesso deste usuário?'}</div>
      <div style="display:flex;gap:10px;">${voltar}<button class="btn ${u.ativo ? 'btn-danger' : 'btn-primary'}" id="btn-confirmar-ativo" style="${btnPeq}">${u.ativo ? 'DESATIVAR' : 'REATIVAR'}</button></div>`);
  }
  return envolver(cab + `
    <button class="btn btn-outline" data-usuario-acao="senha" style="${btnPeq}margin-bottom:10px;">🔒 Redefinir senha</button>
    ${euMesmo ? `<div class="meta" style="text-align:center;">Você não pode mudar o próprio perfil nem desativar o próprio acesso.</div>` : `
      <button class="btn btn-outline" data-usuario-acao="perfil" style="${btnPeq}margin-bottom:10px;">Mudar perfil</button>
      <button class="btn ${u.ativo ? 'btn-danger' : 'btn-primary'}" data-usuario-acao="ativo" style="${btnPeq}">${u.ativo ? 'Desativar acesso' : 'Reativar acesso'}</button>`}`);
}

function bindUsuarios() {
  if (state.tab !== 'usuarios') return;
  const fecharPopup = () => { state._usuarioPopup = null; state._usuarioAcao = null; render(); };
  document.getElementById('fab-novo-usuario')?.addEventListener('click', () => { state._usuarioPopup = 'novo'; state._usuarioAcao = null; render(); });
  document.querySelectorAll('[data-editar-usuario]').forEach(c => c.onclick = () => { state._usuarioPopup = c.dataset.editarUsuario; state._usuarioAcao = null; render(); });
  document.getElementById('btn-fechar-popup-usuario')?.addEventListener('click', fecharPopup);
  document.getElementById('btn-cancelar-usuario')?.addEventListener('click', fecharPopup);
  document.querySelectorAll('[data-usuario-acao]').forEach(b => b.onclick = () => { state._usuarioAcao = b.dataset.usuarioAcao; render(); });
  document.getElementById('btn-acao-voltar')?.addEventListener('click', () => { state._usuarioAcao = null; render(); });

  const chamar = async (btn, funcao, args, msgOk) => {
    const textoOriginal = btn.textContent;
    btn.disabled = true; btn.textContent = 'AGUARDE...';
    const { error } = await sb.rpc(funcao, args);
    if (error) { btn.disabled = false; btn.textContent = textoOriginal; showToast(error.message, true, 4500); return; }
    showToast(msgOk);
    await carregarUsuarios();
    state._usuarioPopup = null; state._usuarioAcao = null;
    render();
  };

  document.getElementById('btn-criar-usuario')?.addEventListener('click', (e) => {
    const nome = document.getElementById('nu-nome').value.trim();
    const usuario = normalizarUsuario(document.getElementById('nu-usuario').value);
    const senha = document.getElementById('nu-senha').value;
    const role = document.getElementById('nu-role').value;
    if (!nome) { showToast('Informe o nome.', true); return; }
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) { showToast('Usuário: 3 a 30 caracteres, só letras minúsculas, números, ponto, hífen ou sublinhado.', true, 4500); return; }
    if (senha.length < 8) { showToast('A senha precisa ter pelo menos 8 caracteres.', true); return; }
    chamar(e.currentTarget, 'admin_criar_usuario', { p_usuario: usuario, p_nome: nome, p_senha: senha, p_role: role }, 'Usuário criado.');
  });
  document.getElementById('btn-salvar-senha')?.addEventListener('click', (e) => {
    const senha = document.getElementById('ed-senha').value;
    if (senha.length < 8) { showToast('A senha precisa ter pelo menos 8 caracteres.', true); return; }
    chamar(e.currentTarget, 'admin_redefinir_senha', { p_id: state._usuarioPopup, p_senha: senha }, 'Senha redefinida.');
  });
  document.getElementById('btn-salvar-perfil')?.addEventListener('click', (e) => {
    chamar(e.currentTarget, 'admin_mudar_perfil', { p_id: state._usuarioPopup, p_role: document.getElementById('ed-role').value }, 'Perfil alterado.');
  });
  document.getElementById('btn-confirmar-ativo')?.addEventListener('click', (e) => {
    const u = state.usuariosLista.find(x => x.id === state._usuarioPopup);
    if (!u) return;
    chamar(e.currentTarget, 'admin_definir_ativo', { p_id: u.id, p_ativo: !u.ativo }, u.ativo ? 'Acesso desativado.' : 'Acesso reativado.');
  });
}

/* ---------------- EVENTOS ---------------- */

function bindGlobal() {
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    state.tab = b.dataset.tab; state.currentInventoryId = null; state.produtoEncontrado = null; state._usuarioPopup = null; render();
    if (state.tab === 'usuarios') carregarUsuarios().then(() => { if (state.tab === 'usuarios') render(); });
  });

  const sair = document.getElementById('btn-sair');
  if (sair) sair.onclick = sairDoApp;

  document.querySelectorAll('[data-invfilter]').forEach(b => b.onclick = () => { state._invFilter = b.dataset.invfilter; render(); });
  document.querySelectorAll('[data-open-inv]').forEach(b => b.onclick = () => {
    if (currentProfile.role !== 'gerenciar') return;
    state.currentInventoryId = b.dataset.openInv; state.gerenciarTab = 'resumo'; render();
  });
  const btnVoltar = document.getElementById('btn-voltar-inv');
  if (btnVoltar) btnVoltar.onclick = () => { state.currentInventoryId = null; state.produtosSearch = ''; state.produtosStatusFiltro = ''; state._confirmarExclusaoInv = false; render(); };
  document.querySelectorAll('[data-gtab]').forEach(b => b.onclick = () => { state.gerenciarTab = b.dataset.gtab; render(); });
  document.getElementById('produtos-status-filtro')?.addEventListener('change', e => {
    state.produtosStatusFiltro = e.target.value;
    render();
  });
  document.getElementById('produtos-search')?.addEventListener('input', e => {
    state.produtosSearch = e.target.value;
    const posCursor = e.target.selectionStart;
    render();
    const campoNovo = document.getElementById('produtos-search');
    if (campoNovo) { campoNovo.focus(); campoNovo.setSelectionRange(posCursor, posCursor); }
  });

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
  const fileWinthor = document.getElementById('file-winthor');
  if (fileWinthor) fileWinthor.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Lendo PDF...');
    try {
      const texto = await extractTextFromPdf(file);
      console.log('[pdf] texto extraído:', texto.length, 'caracteres,', texto.split('\n').length, 'linhas');
      state.novoInventarioTexto = texto;
      state.novoInventarioPreview = parseWinthorReport(texto);
      console.log('[pdf] produtos identificados no PDF:', state.novoInventarioPreview.produtos.length, '| número do inventário:', state.novoInventarioPreview.numeroInventario);
      render();
    } catch (err) {
      console.error('[pdf] erro ao ler:', err);
      showToast('Não foi possível ler esse PDF. Tente colar o texto manualmente.', true);
    }
  };
  const btnConfirmarInv = document.getElementById('btn-confirmar-inv');
  if (btnConfirmarInv) btnConfirmarInv.onclick = async () => {
    const preview = state.novoInventarioPreview;
    const numero = preview.numeroInventario || String(Date.now()).slice(-4);
    console.log('[import] iniciando criação — numero:', numero, '| produtos no preview:', preview.produtos.length);
    btnConfirmarInv.disabled = true; btnConfirmarInv.textContent = 'CRIANDO...';
    let ok = false;
    try {
      ok = await criarInventarioSupabase(numero, preview.produtos);
    } catch (err) {
      console.error('[import] erro inesperado:', err);
      showToast('Erro inesperado ao importar: ' + (err?.message || err), true, 8000);
    }
    btnConfirmarInv.disabled = false; btnConfirmarInv.textContent = 'CONFIRMAR E CRIAR INVENTÁRIO';
    if (ok) {
      console.log('[import] concluído com sucesso.');
      state._novoOpen = false; state.novoInventarioTexto = ''; state.novoInventarioPreview = null;
    } else {
      console.log('[import] NÃO concluído — preview mantido pra você tentar de novo.');
    }
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
  document.querySelectorAll('[data-reabrir]').forEach(b => b.onclick = () => {
    const r = +b.dataset.reabrir;
    const inv = currentInventory();
    atualizarEtapaSupabase(inv.id, {
      round_open: { ...inv.roundOpen, [r]: true },
      round_closed: { ...inv.roundClosed, [r]: false },
      status: 'em_andamento',
    });
  });
  document.querySelectorAll('[data-finalizar]').forEach(b => b.onclick = () => {
    const inv = currentInventory();
    atualizarEtapaSupabase(inv.id, { status: 'finalizado' });
  });
  const btnExportCsv = document.getElementById('btn-export-csv');
  if (btnExportCsv) btnExportCsv.onclick = () => exportLancamentosCsv(currentInventory());
  const btnAtualizarDados = document.getElementById('btn-atualizar-dados');
  if (btnAtualizarDados) btnAtualizarDados.onclick = async () => {
    btnAtualizarDados.disabled = true; btnAtualizarDados.textContent = 'ATUALIZANDO...';
    await refreshInventories({ completo: true });
    btnAtualizarDados.disabled = false; btnAtualizarDados.textContent = '🔄 ATUALIZAR DADOS (antes de gerar relatórios)';
    showToast('Dados atualizados.');
    render();
  };
  const btnExportAcompanhamento = document.getElementById('btn-export-acompanhamento');
  if (btnExportAcompanhamento) btnExportAcompanhamento.onclick = () => exportAcompanhamentoCsv(currentInventory());
  const btnExportXlsx = document.getElementById('btn-export-xlsx');
  if (btnExportXlsx) btnExportXlsx.onclick = () => exportRelatorioCompletoXlsx(currentInventory());
  document.getElementById('btn-excluir-inventario')?.addEventListener('click', () => {
    state._confirmarExclusaoInv = true; render();
  });
  document.getElementById('btn-cancelar-exclusao-inv')?.addEventListener('click', () => {
    state._confirmarExclusaoInv = false; render();
  });
  document.getElementById('btn-excluir-inventario-confirmado')?.addEventListener('click', async () => {
    const inv = currentInventory();
    const ok = await excluirInventarioSupabase(inv.id);
    state._confirmarExclusaoInv = false;
    if (ok) { state.currentInventoryId = null; }
    render();
  });
  document.querySelectorAll('[data-export-round]').forEach(b => b.onclick = () => {
    exportLancamentosPorContagem(currentInventory(), +b.dataset.exportRound);
  });
  document.querySelectorAll('[data-export-txt]').forEach(b => b.onclick = () => {
    exportTxtRotina1147(currentInventory(), +b.dataset.exportTxt);
  });
  document.querySelectorAll('[data-export-final]').forEach(b => b.onclick = () => {
    exportFinalCsv(inventoriesCache.find(i => i.id === b.dataset.exportFinal));
  });

  document.querySelectorAll('[data-corrigir]').forEach(tr => tr.onclick = () => {
    if (currentProfile.role !== 'gerenciar') return;
    const inv = currentInventory();
    const c3 = roundHasData(inv, tr.dataset.corrigir, 3);
    const c2 = roundHasData(inv, tr.dataset.corrigir, 2);
    state._corrigirCodigo = tr.dataset.corrigir;
    state._corrigirRound = c3 ? 3 : c2 ? 2 : 1;
    state._validar3a = false;
    state._validarSubstituirRound = null;
    render();
  });
  document.querySelectorAll('[data-corr-round]').forEach(b => b.onclick = () => {
    state._corrigirRound = +b.dataset.corrRound; render();
  });
  const btnFecharCorr = document.getElementById('btn-fechar-correcao');
  if (btnFecharCorr) btnFecharCorr.onclick = () => { state._corrigirCodigo = null; render(); };
  document.getElementById('chk-validar-3a')?.addEventListener('change', e => {
    state._validar3a = e.target.checked;
    if (!e.target.checked) state._validarSubstituirRound = null;
    render();
  });
  document.querySelectorAll('[data-validar-substituir]').forEach(b => b.onclick = () => {
    state._validarSubstituirRound = +b.dataset.validarSubstituir;
    render();
  });
  const btnAplicarValidacao3a = document.getElementById('btn-aplicar-validacao-3a');
  if (btnAplicarValidacao3a) btnAplicarValidacao3a.onclick = async () => {
    const motivo = document.getElementById('validar-motivo').value.trim();
    if (!motivo) { alert('Informe o motivo do ajuste.'); return; }
    const inv = currentInventory();
    const codigo = state._corrigirCodigo;
    const round = state._validarSubstituirRound;
    const s = productStatus(inv, codigo);
    const oldTotal = round === 1 ? s.t1 : s.t2;
    btnAplicarValidacao3a.disabled = true; btnAplicarValidacao3a.textContent = 'APLICANDO...';
    // Apaga de vez os lançamentos antigos dessa contagem (não deixa nada
    // "por baixo" que possa somar errado depois) e só então registra a
    // correção, com o motivo e o valor antigo preservados para auditoria.
    await excluirTodosLancamentosRodada(inv.id, codigo, round);
    await salvarCorrecaoSupabase(inv.id, codigo, round, oldTotal, s.t3, `[3ª validada pelo administrador — lançamentos antigos da ${round}ª excluídos] ${motivo}`);
    state._corrigirCodigo = null;
    state._validar3a = false;
    state._validarSubstituirRound = null;
    render();
  };
  const btnSalvarCorr = document.getElementById('btn-salvar-correcao');
  if (btnSalvarCorr) btnSalvarCorr.onclick = async () => {
    const novoTotal = +document.getElementById('corr-novo-total').value;
    const motivo = document.getElementById('corr-motivo').value.trim();
    if (!motivo) { alert('Informe o motivo da correção.'); return; }
    const inv = currentInventory();
    const round = state._corrigirRound || 1;
    const oldTotal = effectiveRoundTotal(inv, state._corrigirCodigo, round);
    await salvarCorrecaoSupabase(inv.id, state._corrigirCodigo, round, oldTotal, novoTotal, motivo);
    state._corrigirCodigo = null;
    render();
  };
  document.querySelectorAll('[data-excluir-lancamento]').forEach(b => b.onclick = async () => {
    if (!confirm('Excluir este lançamento? Essa ação não pode ser desfeita.')) return;
    await excluirLancamentoSupabase(b.dataset.excluirLancamento);
    render();
  });
  document.querySelectorAll('[data-excluir-correcao]').forEach(b => b.onclick = async () => {
    if (!confirm('Excluir esta correção? A contagem volta a valer pela soma dos lançamentos.')) return;
    await excluirCorrecaoSupabase(b.dataset.excluirCorrecao);
    render();
  });
  const btnExcluirTodosRodada = document.getElementById('btn-excluir-todos-rodada');
  if (btnExcluirTodosRodada) btnExcluirTodosRodada.onclick = async () => {
    const round = state._corrigirRound || 1;
    if (!confirm(`Excluir TODOS os lançamentos da ${round}ª contagem deste produto? Essa ação não pode ser desfeita.`)) return;
    const inv = currentInventory();
    await excluirTodosLancamentosRodada(inv.id, state._corrigirCodigo, round);
    render();
  };

  document.querySelectorAll('[data-select-count-inv]').forEach(c => c.onclick = () => {
    const inv = inventoriesCache.find(i => i.id === c.dataset.selectCountInv);
    state.currentInventoryId = c.dataset.selectCountInv;
    state.currentRound = inv ? rodadaAbertaAtual(inv) : 1;
    state.produtoEncontrado = null; render();
  });
  const btnSair = document.getElementById('btn-sair-contagem');
  if (btnSair) btnSair.onclick = () => { state.currentInventoryId = null; state.produtoEncontrado = null; render(); };
  const inputCodigo = document.getElementById('input-codigo');
  const btnBuscar = document.getElementById('btn-buscar-produto');
  const buscar = () => { const val = (inputCodigo?.value || '').trim(); if (val) buscarProduto(val); };
  if (btnBuscar) btnBuscar.onclick = buscar;
  if (inputCodigo) inputCodigo.addEventListener('keydown', e => { if (e.key === 'Enter') buscar(); });

  const btnAbrirCamera = document.getElementById('btn-abrir-camera');
  if (btnAbrirCamera) btnAbrirCamera.onclick = iniciarScanner;

  document.getElementById('qtd-menos')?.addEventListener('click', () => {
    state.qtd = Math.max(0, state.qtd - 1);
    const input = document.getElementById('qtd-input');
    if (input) input.value = state.qtd;
  });
  document.getElementById('qtd-mais')?.addEventListener('click', () => {
    state.qtd = state.qtd + 1;
    const input = document.getElementById('qtd-input');
    if (input) input.value = state.qtd;
  });
  document.getElementById('qtd-input')?.addEventListener('change', e => { state.qtd = Math.max(0, +e.target.value || 0); });
  document.querySelectorAll('[data-qtdmodo]').forEach(b => b.onclick = () => {
    state.qtdModo = b.dataset.qtdmodo;
    if (state.qtdModo === 'volumes') {
      if (state.volumeLinhas.length === 0) state.volumeLinhas = [linhaVazia()];
      state._popupAberto = 'volumes';
    }
    saveLastQtyConfig(state.qtdModo);
    render();
  });
  document.getElementById('btn-confirmar-volumes')?.addEventListener('click', () => {
    if (calcularTotalVolumes() <= 0) { showToast('Preencha as linhas antes de confirmar.', true); return; }
    state._popupAberto = null; render();
  });
  document.querySelectorAll('[data-linha-idx]').forEach(inp => inp.addEventListener('change', e => {
    const idx = +inp.dataset.linhaIdx;
    state.volumeLinhas[idx][inp.dataset.campo] = e.target.value;
    render();
  }));
  document.getElementById('btn-add-linha')?.addEventListener('click', () => { state.volumeLinhas.push(linhaVazia()); render(); });
  document.querySelectorAll('[data-remover-linha]').forEach(b => b.onclick = () => {
    const idx = +b.dataset.removerLinha;
    state.volumeLinhas.splice(idx, 1);
    if (state.volumeLinhas.length === 0) state.volumeLinhas = [linhaVazia()];
    render();
  });
  document.querySelectorAll('[data-abrir-popup]').forEach(b => b.onclick = () => { state._popupAberto = b.dataset.abrirPopup; render(); });
  document.getElementById('btn-fechar-popup')?.addEventListener('click', () => { state._popupAberto = null; render(); });
  document.getElementById('input-tipo-local')?.addEventListener('change', e => {
    const campos = document.getElementById('campos-arvore-lado');
    if (campos) campos.style.display = e.target.value === 'Árvore' ? '' : 'none';
  });
  document.getElementById('btn-confirmar-popup')?.addEventListener('click', () => {
    const inputTipoLocal = document.getElementById('input-tipo-local');
    const inputArvore = document.getElementById('input-arvore');
    const inputLado = document.getElementById('input-lado');
    const inputAvaria = document.getElementById('input-avaria');
    if (inputTipoLocal) {
      if (inputTipoLocal.value === 'Árvore') {
        state.arvore = (inputArvore?.value || '').trim();
        state.lado = (inputLado?.value || '').trim();
      } else {
        state.arvore = inputTipoLocal.value;
        state.lado = '';
      }
    }
    if (inputAvaria) state.qtdAvaria = inputAvaria.value.trim();
    state._popupAberto = null;
    render();
  });
  document.querySelectorAll('[data-escolher-round]').forEach(b => b.onclick = () => {
    if (b.disabled) return;
    state.currentRound = +b.dataset.escolherRound;
    state.produtoEncontrado = null;
    state._popupAberto = null;
    render();
  });
  document.getElementById('input-arvore')?.addEventListener('change', e => { state.arvore = e.target.value.trim(); });
  document.getElementById('input-lado')?.addEventListener('change', e => { state.lado = e.target.value.trim(); });
  document.getElementById('input-avaria')?.addEventListener('change', e => { state.qtdAvaria = e.target.value.trim(); });
  document.getElementById('btn-cancelar-produto')?.addEventListener('click', () => { state.produtoEncontrado = null; state.qtd = 0; state.arvore = ''; state.lado = ''; state._popupAberto = null; render(); });
  document.getElementById('btn-registrar')?.addEventListener('click', registrarLancamento);
}

function buscarProduto(valor) {
  const inv = currentInventory();
  if (!inv) return;
  if (!rodadaHabilitada(inv, state.currentRound)) {
    showToast(`A ${state.currentRound}ª contagem não está mais aberta. Toque no ícone de Contagem e escolha a etapa certa.`, true);
    return;
  }
  let codigo = valor;
  if (/^\d{12}$/.test(valor) && valor.startsWith('20')) codigo = String(parseInt(valor.slice(2), 10));
  const produto = inv.products.find(p => p.codigo === codigo);
  if (!produto) { showToast('Este produto não pertence a este inventário.', true); return; }
  if (state.currentRound === 3 && !divergentProducts(inv).some(p => p.codigo === codigo)) {
    const s = productStatus(inv, codigo);
    if (s.status === 'FINALIZADO' && s.t1 === s.t2) {
      showToast(`Esse produto já bateu na 1ª e 2ª contagem (${formatNumeroBR(s.final)}) — não precisa contar de novo, já foi preenchido automaticamente.`, true);
    } else {
      showToast('Este produto não está aguardando 3ª contagem.', true);
    }
    return;
  }
  state.produtoEncontrado = produto;
  state.qtd = 0;
  const last = getLastLocation();
  state.arvore = last.arvore;
  state.lado = last.lado;
  state._localExpandida = false;
  state._popupAberto = null;
  const qtyCfg = getLastQtyConfig();
  state.qtdModo = qtyCfg.modo || 'simples';
  state.volumeLinhas = state.qtdModo === 'volumes' ? [linhaVazia()] : [];
  state._volumesExpandida = true;
  if (navigator.vibrate) navigator.vibrate(60);
  render();
}

async function registrarLancamento() {
  if (state._registrando) return; // trava contra toque duplo
  state._registrando = true;
  const btn = document.getElementById('btn-registrar');
  if (btn) btn.disabled = true;
  try { await registrarLancamentoInterno(); }
  finally { state._registrando = false; const b2 = document.getElementById('btn-registrar'); if (b2) b2.disabled = false; }
}

async function registrarLancamentoInterno() {
  const inv = currentInventory();
  const p = state.produtoEncontrado;
  if (!inv || !p) return;
  if (!rodadaHabilitada(inv, state.currentRound)) {
    showToast(`A ${state.currentRound}ª contagem não está mais aberta. Escolha a etapa certa e tente de novo.`, true);
    state.produtoEncontrado = null; render();
    return;
  }

  let quantidade, detalheContagem = null;
  if (state.qtdModo === 'volumes') {
    quantidade = calcularTotalVolumes();
    if (quantidade <= 0) { showToast('Preencha as linhas — o total precisa ser maior que zero.', true); return; }
    detalheContagem = state.volumeLinhas
      .filter(l => l.qtd !== '')
      .map(l => ({ qtd: parseFloat(String(l.qtd).replace(',', '.')) || 0, pecas: l.pecas !== '' ? (parseFloat(String(l.pecas).replace(',', '.')) || 0) : null }));
  } else {
    quantidade = state.qtd;
    if (quantidade <= 0) { showToast('Informe uma quantidade maior que zero.', true); return; }
  }

  const arvore = (state.arvore || '').trim();
  const lado = (state.lado || '').trim();
  const qtdAvaria = state.qtdAvaria !== '' ? (parseFloat(String(state.qtdAvaria).replace(',', '.')) || 0) : null;
  if (qtdAvaria != null && qtdAvaria > quantidade) {
    showToast('A quantidade avariada não pode ser maior que o total contado.', true);
    return;
  }
  const ok = await registrarLancamentoSupabase(inv.id, p.codigo, state.currentRound, quantidade, arvore, lado, detalheContagem, qtdAvaria);
  if (!ok) return;
  saveLastLocation(arvore, lado);
  saveLastQtyConfig(state.qtdModo);

  // Decide o tipo do aviso: normal (✓) ou atenção (⚠).
  let aviso = { tipo: 'ok', linha2: '' };
  try {
    const invAtual = currentInventory();
    if (state.currentRound === 3) {
      const s = productStatus(invAtual, p.codigo);
      if (s.status === 'DIVERGÊNCIA CRÍTICA') aviso = { tipo: 'atencao', titulo: 'Lançado, mas não bate', linha2: 'A 3ª contagem não bate com nenhuma das anteriores. Avise o gerente.' };
    } else if (state.currentRound === 2) {
      const t1 = effectiveRoundTotal(invAtual, p.codigo, 1), t2 = effectiveRoundTotal(invAtual, p.codigo, 2);
      if (roundHasData(invAtual, p.codigo, 1) && t1 !== t2) {
        aviso = { tipo: 'atencao', titulo: 'Lançado, mas difere da 1ª', linha2: `1ª contagem: ${formatNumeroBR(t1)} · 2ª até agora: ${formatNumeroBR(t2)}` };
      }
    }
  } catch (e) { console.error(e); }

  state.produtoEncontrado = null; state.qtd = 0; state.arvore = ''; state.lado = ''; state._localExpandida = false;
  state.qtdAvaria = '';
  state.volumeLinhas = state.qtdModo === 'volumes' ? [linhaVazia()] : [];
  state._volumesExpandida = true;
  render();
  mostrarConfirmacao({
    tipo: aviso.tipo,
    titulo: aviso.titulo || 'Lançado!',
    linha1: `${state.currentRound}ª contagem · ${formatNumeroBR(quantidade)}${state.qtdModo === 'volumes' ? ' (calculado)' : ''}`,
    linha2: aviso.linha2 || `${p.referencia} · ${p.descricao}${qtdAvaria ? ` · ${formatNumeroBR(qtdAvaria)} avariada` : ''}`,
  });
  setTimeout(() => document.getElementById('input-codigo')?.focus(), 50);
}



/* ---------------- TEMA (claro / escuro / automático) ---------------- */
const TEMA = {
  get pref() { try { return localStorage.getItem('if_tema') || 'auto'; } catch (e) { return 'auto'; } },
  set pref(v) { try { localStorage.setItem('if_tema', v); } catch (e) {} },
  efetivo() { return this.pref === 'auto' ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro') : this.pref; },
  aplicar() { document.documentElement.setAttribute('data-tema', this.efetivo());
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', this.efetivo() === 'escuro' ? '#0A101D' : '#DEE9FF'); },
};
TEMA.aplicar();
if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => TEMA.aplicar()); } catch (e) {} }

/* ---------------- SOM E CONFIRMAÇÃO ---------------- */

const SOM = {
  get ligado() { try { return localStorage.getItem('if_som') !== '0'; } catch (e) { return true; } },
  set ligado(v) { try { localStorage.setItem('if_som', v ? '1' : '0'); } catch (e) {} },
  get volume() { try { const v = parseFloat(localStorage.getItem('if_vol')); return isNaN(v) ? 0.6 : Math.min(1, Math.max(0, v)); } catch (e) { return 0.6; } },
  set volume(v) { try { localStorage.setItem('if_vol', String(v)); } catch (e) {} },
  ctx: null,
};

// O iPhone só libera o som depois de um toque do usuário: "destrava" no primeiro toque na tela.
function destravarSom() {
  try {
    if (!SOM.ctx) SOM.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (SOM.ctx.state === 'suspended') SOM.ctx.resume();
  } catch (e) {}
}
['touchstart', 'touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, destravarSom, { passive: true }));

function tocarTom(freq, inicio, dur, tipo = 'sine', ganho = 1) {
  const ctx = SOM.ctx; if (!ctx) return;
  const t0 = ctx.currentTime + inicio;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = tipo; osc.frequency.setValueAtTime(freq, t0);
  const pico = 0.5 * SOM.volume * ganho;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(pico, 0.0002), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function tocarSom(tipo) {
  if (!SOM.ligado || SOM.volume <= 0) return;
  destravarSom();
  try {
    if (tipo === 'ok') { tocarTom(1568, 0, 0.16); tocarTom(2093, 0.07, 0.18, 'sine', 0.8); }          // "tin" agudo e curto
    else if (tipo === 'atencao') { tocarTom(880, 0, 0.18, 'triangle'); tocarTom(622, 0.2, 0.26, 'triangle'); } // dois tons descendentes
    else if (tipo === 'erro') { tocarTom(196, 0, 0.35, 'sawtooth', 0.7); }                              // tom grave
  } catch (e) { console.error(e); }
}

// Pop-up central: só avisa e some sozinho. Não bloqueia toques (já dá para ler o próximo produto).
function mostrarConfirmacao({ tipo, titulo, linha1, linha2 }) {
  document.querySelectorAll('.confirma-overlay').forEach(el => el.remove());
  const atencao = tipo === 'atencao';
  const el = document.createElement('div');
  el.className = 'confirma-overlay';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="confirma-card ${atencao ? 'atencao' : ''}">
      <div class="confirma-ic">${atencao ? ICON('triangle-alert', 52) : '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="confirma-tick" d="M5 12.5l4.5 4.5L19 7.5"/></svg>'}</div>
      <div class="confirma-titulo">${esc(titulo)}</div>
      <div class="confirma-l1">${esc(linha1 || '')}</div>
      <div class="confirma-l2">${esc(linha2 || '')}</div>
    </div>`;
  document.body.appendChild(el);
  tocarSom(atencao ? 'atencao' : 'ok');
  const dur = atencao ? 2400 : 1100;
  setTimeout(() => el.classList.add('saindo'), dur);
  setTimeout(() => el.remove(), dur + 220);
}

function showToast(msg, erro, duracaoMs) {
  const el = document.createElement('div');
  el.className = 'toast' + (erro ? ' erro' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  if (erro) tocarSom('erro');
  setTimeout(() => el.remove(), duracaoMs || 2400);
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

function downloadTxt(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function produtosDaContagemParaExport(inv, round) {
  if (round === 3) {
    return inv.products
      .map(p => {
        const s = productStatus(inv, p.codigo);
        const entradas = inv.entries.filter(e => e.codigo === p.codigo && e.round === 3);
        const avaria = entradas.reduce((soma, e) => soma + (e.qtdAvaria || 0), 0);
        const locs = [...new Set(entradas.filter(e => e.arvore || e.lado).map(e => `${e.arvore || '-'}/${e.lado || '-'}`))].join('; ');
        const detalhes = entradas.length
          ? entradas.map(e => e.detalheContagem ? formatarDetalhe(e.detalheContagem) : formatNumeroBR(e.quantity)).join(' | ')
          : (s.t1 === s.t2 ? 'igual à 1ª/2ª (automático)' : '-');
        return { produto: p, quantidade: s.t3, avaria, locs, detalhes };
      })
      .filter(x => x.quantidade);
  }
  return inv.products
    .filter(p => inv.entries.some(e => e.codigo === p.codigo && e.round === round))
    .map(p => {
      const entradas = inv.entries.filter(e => e.codigo === p.codigo && e.round === round);
      const quantidade = entradas.reduce((soma, e) => soma + e.quantity, 0);
      const avaria = entradas.reduce((soma, e) => soma + (e.qtdAvaria || 0), 0);
      const locs = [...new Set(entradas.filter(e => e.arvore || e.lado).map(e => `${e.arvore || '-'}/${e.lado || '-'}`))].join('; ');
      const detalhes = entradas.map(e => e.detalheContagem ? formatarDetalhe(e.detalheContagem) : formatNumeroBR(e.quantity)).join(' | ');
      return { produto: p, quantidade, avaria, locs, detalhes };
    });
}

function exportTxtRotina1147(inv, round) {
  if (!inv) return;
  const itens = produtosDaContagemParaExport(inv, round);
  if (itens.length === 0) { showToast(`Não há itens na ${round}ª contagem ainda.`, true); return; }

  const linhas = itens.map(({ produto: p, quantidade }) => {
    const codBarras = String(p.codigo).padStart(14, '0');
    const codProd = String(p.codigo).padStart(6, '0');
    const numInventario = String(inv.numero).padStart(6, '0');
    const contagem = String(round).padStart(4, '0');
    const qtd = quantidade.toFixed(1).replace('.', ',').padStart(6, '0');
    return codBarras + codProd + numInventario + contagem + qtd;
  });

  downloadTxt(`inventario_${inv.numero}_${round}a_contagem_rotina1147.txt`, linhas.join('\r\n'));
}

function exportAcompanhamentoCsv(inv) {
  if (!inv) return;
  const rows = [['CODPROD','REFERENCIA','DESCRICAO','LOCALIZACOES','QTD_1A','QUEM_CONTOU_1A','QTD_2A','QUEM_CONTOU_2A','QTD_3A','QUEM_CONTOU_3A','STATUS']];
  inv.products.forEach(p => {
    const s = productStatus(inv, p.codigo);
    const entradasProduto = inv.entries.filter(e => e.codigo === p.codigo);
    const locs = [...new Set(entradasProduto.filter(e => e.arvore || e.lado).map(e => `${e.arvore || '-'}/${e.lado || '-'}`))].join('; ');
    const quemDaRodada = round => [...new Set(entradasProduto.filter(e => e.round === round).map(e => e.userName))].join(', ');
    rows.push([
      p.codigo, p.referencia, p.descricao, locs || '-',
      s.t1 ? formatNumeroBR(s.t1) : '', quemDaRodada(1),
      s.t2 ? formatNumeroBR(s.t2) : '', quemDaRodada(2),
      s.t3 ? formatNumeroBR(s.t3) : '', quemDaRodada(3),
      s.status,
    ]);
  });
  downloadCsv(`inventario_${inv.numero}_acompanhamento.csv`, rows);
}

function exportLancamentosCsv(inv) {
  if (!inv) return;
  const rows = [['CODPROD','DESCRICAO','QUANTIDADE','NUMINVENTARIO','CONTAGEM','ARVORE','LADO','DETALHAMENTO','QTD_AVARIA']];
  inv.entries.forEach(e => {
    const p = inv.products.find(p => p.codigo === e.codigo);
    rows.push([e.codigo, p?.descricao || '', formatNumeroBR(e.quantity), inv.numero, e.round, e.arvore || '', e.lado || '', formatarDetalhe(e.detalheContagem), formatNumeroBR(e.qtdAvaria)]);
  });
  downloadCsv(`inventario_${inv.numero}_lancamentos.csv`, rows);
}

function exportLancamentosPorContagem(inv, round) {
  if (!inv) return;
  const rows = [['CODPROD','REFERENCIA','DESCRICAO','QUANTIDADE','NUMINVENTARIO','LOCALIZACOES','DETALHAMENTO','QTD_AVARIA']];
  const itens = produtosDaContagemParaExport(inv, round);
  itens.forEach(({ produto: p, quantidade, avaria, locs, detalhes }) => {
    rows.push([p.codigo, p.referencia, p.descricao, formatNumeroBR(quantidade), inv.numero, locs || '-', detalhes || '-', formatNumeroBR(avaria || '')]);
  });
  if (rows.length === 1) { showToast(`Não há itens na ${round}ª contagem ainda.`, true); return; }
  downloadCsv(`inventario_${inv.numero}_${round}a_contagem.csv`, rows);
}

function exportRelatorioCompletoXlsx(inv) {
  if (!inv) return;

  const resumo = [['CODPROD','REFERENCIA','QTD_1A','QTD_2A','QTD_3A','QTD_FINAL','QTD_AVARIA','STATUS']];
  inv.products.forEach(p => {
    const s = productStatus(inv, p.codigo);
    const entradasProduto = inv.entries.filter(e => e.codigo === p.codigo);
    const avaria = entradasProduto.reduce((soma, e) => soma + (e.qtdAvaria || 0), 0);
    resumo.push([p.codigo, p.referencia, s.t1 || '', s.t2 || '', s.t3 || '', s.final ?? '', avaria || '', s.status]);
  });

  const detalhamento = [['CODPROD','REFERENCIA','DESCRICAO','CONTAGEM','QUANTIDADE','COMO','QTD_AVARIA','ARVORE','LADO','USUARIO','DATA_HORA']];
  inv.entries
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .forEach(e => {
      const p = inv.products.find(p => p.codigo === e.codigo);
      detalhamento.push([
        e.codigo, p?.referencia || '', p?.descricao || '', e.round, e.quantity,
        formatarDetalhe(e.detalheContagem), e.qtdAvaria ?? '', e.arvore || '', e.lado || '',
        e.userName || '', new Date(e.timestamp).toLocaleString('pt-BR'),
      ]);
    });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), 'Resumo');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalhamento), 'Detalhamento');
  XLSX.writeFile(wb, `inventario_${inv.numero}_relatorio.xlsx`);
}

function exportFinalCsv(inv) {
  if (!inv) return;
  const rows = [['CODPROD','DESCRICAO','QTD','STATUS','NUMINVENTARIO','QTD_AVARIA','LOCALIZACOES']];
  inv.products.forEach(p => {
    const s = productStatus(inv, p.codigo);
    const entradasProduto = inv.entries.filter(e => e.codigo === p.codigo);
    const avaria = entradasProduto.reduce((soma, e) => soma + (e.qtdAvaria || 0), 0);
    const locs = [...new Set(entradasProduto
      .filter(e => e.arvore || e.lado)
      .map(e => `${e.arvore || '-'}/${e.lado || '-'}`))].join('; ');
    const qtd = melhorQuantidade(inv, p.codigo);
    rows.push([p.codigo, p.descricao, formatNumeroBR(qtd), s.status, inv.numero, formatNumeroBR(avaria || ''), locs || '-']);
  });
  downloadCsv(`inventario_${inv.numero}_final.csv`, rows);
}

/* ---------------- INICIALIZAÇÃO ---------------- */

function criarMarcaDagua() {
  if (document.getElementById('wm-bg')) return;
  const wm = document.createElement('div');
  wm.id = 'wm-bg'; wm.className = 'wm-bg'; wm.setAttribute('aria-hidden', 'true');
  wm.innerHTML = '<img src="assets/brand/marca-dagua-f.png" class="wm1" alt=""><img src="assets/brand/marca-dagua-f.png" class="wm2" alt="">';
  document.body.insertBefore(wm, document.body.firstChild);
}

(async function start() {
  criarMarcaDagua();
  await ensureMasterLoaded();
  try {
    const { data: { session } } = await withTimeout(sb.auth.getSession(), 12000, 'Servidor demorando para responder.');
    if (session) {
      const perfil = await loadProfile(session.user.id);
      if (perfil && perfil.ativo && perfil.usuario) aplicarPerfil(perfil, true);
      else await sb.auth.signOut();
    }
  } catch (err) { console.error('Falha ao restaurar sessão:', err); }
  if (currentProfile && !state._precisaDupla) {
    await refreshInventories();
    assinarTempoReal();
    iniciarSincronizacaoSegura();
  }
  // Sessão encerrada em outro lugar (ou usuário desativado): volta para o login.
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT' && currentProfile) { currentProfile = null; state._precisaDupla = false; render(); }
  });
  render();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(()=>{}));
}
