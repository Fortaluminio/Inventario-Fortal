-- ============================================================
-- INVENTÁRIO FORTAL — Schema do banco (Supabase / Postgres)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em "Run".
-- ============================================================

-- Perfis de usuário (nome + papel: gerenciar / inventariar)
create table if not exists profiles (
  id uuid primary key default auth.uid(),
  nome text not null,
  role text not null check (role in ('gerenciar', 'inventariar')),
  created_at timestamptz default now()
);

-- Base mestre de produtos (~2.146 itens)
create table if not exists master_products (
  codigo text primary key,
  referencia text not null,
  descricao text,
  unidade text,
  codigo_barras text,
  foto_url text
);

-- Inventários
create table if not exists inventories (
  id uuid primary key default gen_random_uuid(),
  numero text not null,
  status text not null default 'em_andamento' check (status in ('em_andamento', 'finalizado')),
  round_open jsonb not null default '{"1":true,"2":false,"3":false}',
  round_closed jsonb not null default '{"1":false,"2":false,"3":false}',
  created_at timestamptz default now(),
  created_by uuid references profiles(id)
);

-- Produtos que pertencem a cada inventário (só esses podem ser contados)
create table if not exists inventory_products (
  inventory_id uuid references inventories(id) on delete cascade,
  codigo text not null,
  referencia text,
  descricao text,
  unidade text,
  codigo_barras text,
  foto_url text,
  primary key (inventory_id, codigo)
);

-- Lançamentos de contagem (nunca alterados, só inseridos — soma acontece na consulta)
create table if not exists count_entries (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid references inventories(id) on delete cascade,
  codigo text not null,
  round int not null check (round in (1,2,3)),
  quantity numeric not null check (quantity > 0),
  user_id uuid references profiles(id),
  user_nome text,
  device_id text,
  created_at timestamptz default now()
);

-- Correções manuais (auditoria — nunca apaga o histórico anterior)
create table if not exists corrections (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid references inventories(id) on delete cascade,
  codigo text not null,
  old_total numeric,
  new_total numeric,
  reason text not null,
  user_id uuid references profiles(id),
  user_nome text,
  created_at timestamptz default now()
);

-- ============================================================
-- SEGURANÇA (Row Level Security) — aplica as regras no banco,
-- não só na tela, como pede o prompt mestre.
-- ============================================================

alter table profiles enable row level security;
alter table master_products enable row level security;
alter table inventories enable row level security;
alter table inventory_products enable row level security;
alter table count_entries enable row level security;
alter table corrections enable row level security;

-- profiles: cada um só mexe no próprio perfil
create policy "ver proprio perfil" on profiles for select using (true);
create policy "criar proprio perfil" on profiles for insert with check (id = auth.uid());
create policy "atualizar proprio perfil" on profiles for update using (id = auth.uid());

-- master_products: leitura livre para quem está autenticado
create policy "ler base mestre" on master_products for select using (auth.role() = 'authenticated');

-- inventories: leitura livre; criar/editar só quem é Gerenciar
create policy "ler inventarios" on inventories for select using (auth.role() = 'authenticated');
create policy "criar inventario - gerenciar" on inventories for insert with check (
  exists (select 1 from profiles where id = auth.uid() and role = 'gerenciar')
);
create policy "editar inventario - gerenciar" on inventories for update using (
  exists (select 1 from profiles where id = auth.uid() and role = 'gerenciar')
);

-- inventory_products: leitura livre; inserir só quem é Gerenciar (import do PDF)
create policy "ler produtos do inventario" on inventory_products for select using (auth.role() = 'authenticated');
create policy "importar produtos - gerenciar" on inventory_products for insert with check (
  exists (select 1 from profiles where id = auth.uid() and role = 'gerenciar')
);

-- count_entries: qualquer autenticado lança contagem em seu próprio nome;
-- ninguém pode editar ou apagar um lançamento já feito (só corrigir via tabela corrections)
create policy "ler lancamentos" on count_entries for select using (auth.role() = 'authenticated');
create policy "lancar contagem" on count_entries for insert with check (user_id = auth.uid());

-- corrections: leitura livre; só Gerenciar pode registrar correção; nunca editável
create policy "ler correcoes" on corrections for select using (auth.role() = 'authenticated');
create policy "corrigir - gerenciar" on corrections for insert with check (
  exists (select 1 from profiles where id = auth.uid() and role = 'gerenciar')
);

-- ============================================================
-- Tempo real: permite que todos os celulares vejam mudanças ao vivo
-- ============================================================
alter publication supabase_realtime add table inventories, inventory_products, count_entries, corrections;
