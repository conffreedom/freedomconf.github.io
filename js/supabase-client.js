/* ============================================================
   js/supabase-client.js
   ------------------------------------------------------------
   Ponto único de conexão com o Supabase.

   Este arquivo deve ser carregado ANTES de main.js / admin.js,
   logo depois da tag <script> do SDK do Supabase via CDN:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="js/supabase-client.js"></script>
     <script src="js/main.js"></script>   (ou js/admin.js)

   O SDK carregado pela CDN cria um objeto global chamado
   "supabase" com o método "supabase.createClient(...)". Aqui nós
   usamos esse método UMA única vez para criar a nossa instância
   de cliente e guardamos o resultado em "window.supabaseClient",
   para que qualquer outro script da página possa reutilizá-la
   sem precisar criar uma nova conexão.

   Essa mesma instância é usada tanto para:
     - Banco de dados:  supabaseClient.from('inscricoes')...
     - Autenticação:    supabaseClient.auth...
     - Armazenamento:   supabaseClient.storage.from('comprovantes')...
   ============================================================ */

(function () {
  'use strict';

  // URL do projeto Supabase.
  const SUPABASE_URL = 'https://oqwonohlkngnkhxcabgv.supabase.co';

  // Chave pública "anon". É seguro deixar essa chave exposta no
  // front-end: ela por si só não dá acesso a nada — quem controla
  // o que pode ser lido/gravado são as políticas de Row Level
  // Security (RLS) das tabelas e as políticas de Storage dos
  // buckets, configuradas no painel do Supabase. A chave
  // "service_role" (essa sim secreta) NUNCA deve aparecer aqui.
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xd29ub2hsa25nbmtoeGNhYmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEwNTQsImV4cCI6MjEwNDQ2NzA1NH0._wLQRVmw-KPIlm1XDgMDvaNpDdXKkuVXsZI_GdowRng';

  // Proteção simples: se por algum motivo este arquivo for
  // carregado antes do SDK do Supabase (ou o SDK falhar ao
  // carregar, por exemplo por bloqueio de rede), avisamos de
  // forma clara no console em vez de deixar um erro confuso do
  // tipo "supabase is not defined" mais adiante.
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    console.error(
      '[supabase-client] O SDK do Supabase não foi carregado. ' +
      'Verifique se a tag <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> ' +
      'está incluída ANTES de js/supabase-client.js.'
    );
    return;
  }

  // Cria a instância do client e a expõe globalmente como
  // "window.supabaseClient". Usamos um nome diferente de
  // "supabase" de propósito, para não conflitar com o objeto
  // global do SDK (que continua disponível como "window.supabase").
  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Nome do bucket de Storage onde ficam os comprovantes de PIX
  // enviados no formulário público. Centralizamos o nome aqui
  // para que main.js e admin.js nunca precisem repetir a string
  // solta pelo código.
  window.SUPABASE_COMPROVANTES_BUCKET = 'comprovantes';
})();

/* ============================================================
   Estrutura de banco esperada (tabela "inscricoes")
   ------------------------------------------------------------
   Este arquivo não cria tabelas nem buckets — isso é feito uma
   única vez no painel do Supabase. Deixamos aqui, em comentário,
   a estrutura mínima que o restante do código (main.js /
   admin.js) espera encontrar, para facilitar a auditoria técnica
   e a configuração do banco. Veja também sql/schema.sql.

   create table public.inscricoes (
     id                 uuid primary key default gen_random_uuid(),
     nome_completo       text not null,
     email                text not null,
     telefone             text not null,
     tipo_ingresso        text not null,               -- 'SEXTA' | 'SABADO' | 'COMBO'
     valor_pago           numeric(10,2) not null,
     codigo_ingresso      text not null unique,         -- ex.: FC2026-A1B2C3
     status_pagamento     text not null default 'pendente', -- 'pendente' | 'aprovado' | 'recusado'
     checkin_realizado    boolean not null default false,
     comprovante_url      text,                         -- link público do comprovante de PIX no Storage
     created_at           timestamptz not null default now()
   );
   ============================================================ */

/* ============================================================
   Storage esperado (bucket "comprovantes")
   ------------------------------------------------------------
   Criado em Project > Storage > New bucket, marcado como
   "Public bucket" (o link salvo em comprovante_url só é útil ao
   financeiro se puder ser aberto diretamente). As políticas do
   bucket devem permitir:
     - INSERT (upload) para o papel "anon", restrito a arquivos
       de imagem/PDF de até alguns MB;
     - SELECT (leitura) público, já que o bucket é público.
   O upload em si é feito em js/main.js, no momento do envio do
   formulário de inscrição. Veja sql/schema.sql para os comandos
   completos de criação do bucket e das políticas.
   ============================================================ */