# Inventário Fortal — agora com banco compartilhado

O app já está configurado com o Supabase de vocês (`config.js`). Falta só um passo
**seu**, que é criar as tabelas no banco — depois disso é só publicar e usar.

## 1. Criar as tabelas (uma vez só)

1. No painel do Supabase, abra **SQL Editor** (menu lateral).
2. Clique em **New query**.
3. Cole todo o conteúdo do arquivo `schema.sql` (está na raiz deste pacote).
4. Clique em **Run**.

Isso cria as tabelas de usuários, inventários, produtos do inventário, lançamentos
e correções — já com as permissões corretas (quem pode ver o quê, quem pode criar
inventário, quem pode corrigir).

## 2. Publicar

Arraste esta pasta inteira (`inventario-fortal-app`) no mesmo site que você já
reivindicou no Netlify (Deploys → arrastar pasta). O link continua o mesmo de
antes.

## 3. Testar com sincronização real

Agora dá pra testar com **dois celulares (ou um celular + o computador) ao mesmo
tempo** e ver a mágica acontecer:

1. No celular A: entrar como **Gerenciar**, criar o Inventário 48 (mesmo texto de
   exemplo de antes).
2. No celular B: entrar como **Inventariar**, escolher o Inventário 48, 1ª contagem.
3. Registrar uma contagem no celular B.
4. Voltar no celular A, abrir o inventário → **o progresso já aparece atualizado
   sozinho**, sem precisar atualizar a página.

### Texto de exemplo do Inventário 48
```
Inventário
48
1 1 3 LB036BCO - LAMBRI LISO GRANDE C/ LISTRA UN 1 1 UND
1 1 2 LB050BCO - LAMBRI CORRUGADO BRANCO UN 1 1 UND
1 1 4 L25504BCO - CONTORNO PORTA L.25 BRANCO UN 1 1 UND
1 1 5 L25517BCO - BATEDOR PORTAO 6,5 BRANCO UN 1 1 UND
1 1 1 PC027BCO - CONTORNO PORTAO 6,5 BRANCO UN 1 1 UND
```

## O que mudou tecnicamente

- Inventários, produtos do inventário, lançamentos e correções agora vivem no
  Supabase — compartilhados entre todos os celulares em tempo real.
- O catálogo de produtos (2.146 itens + fotos) continua sendo um arquivo dentro do
  próprio app — não muda com frequência, não precisa estar no banco.
- Cada celular recebe uma identidade anônima automática do Supabase na primeira vez
  que abre o app (não pede e-mail/senha para o time de estoque). O **nome** que a
  pessoa digita na tela de entrada é o que aparece nos relatórios e na auditoria.
- Isso é adequado para o piloto com a equipe interna. Se no futuro for necessário
  saber com certeza "foi realmente o João que contou" (não só um celular com o nome
  João digitado), o próximo passo é trocar por login com e-mail/senha — a estrutura
  do banco já está pronta para isso, é só trocar a parte de autenticação.
- Nenhuma regra de negócio mudou: soma de lançamentos, contagens independentes,
  finalização automática, 3ª contagem só nos divergentes, correções com motivo
  obrigatório — tudo continua igual, só passou a rodar em um banco de verdade.

## Aviso de segurança sobre as chaves

O arquivo `config.js` tem a URL do projeto e a chave **publishable** — essa chave é
feita para ficar visível no código do app, não é segredo. A chave que nunca deve
aparecer em lugar nenhum do app é a `service_role` / `secret` (essa sim dá acesso
total ao banco, sem passar pelas regras de permissão).
