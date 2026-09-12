/* ============================================================
   js/admin.js
   ------------------------------------------------------------
   Lógica do PAINEL ADMINISTRATIVO (admin.html):
     1) Login / logout via Supabase Auth, com proteção de acesso
        e alternância de visibilidade da senha;
     2) Dashboard: contadores, busca/filtro e tabela de
        inscrições com alteração de status de pagamento,
        atualizada em tempo real via Supabase Realtime;
     3) Exportação da lista em CSV para o financeiro;
     4) Portaria / Check-in: leitura de QR code pela câmera (com
        cooldown contra leituras repetidas) e validação manual do
        código do ingresso.

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient),
       carregado ANTES deste arquivo;
     - biblioteca html5-qrcode (window.Html5Qrcode), carregada no
       <head> do admin.html.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ----------------------------------------------------------
     0) ELEMENTOS DAS 3 TELAS
     ---------------------------------------------------------- */

  const telaLogin = document.getElementById('login');
  const telaDashboard = document.getElementById('dashboard');
  const telaCheckin = document.getElementById('checkin');

  // Alterna qual das 3 telas fica visível. Além de ligar/desligar a
  // classe ".active" (usada pela animação de entrada em
  // css/styles.css), também força "display" diretamente no estilo
  // inline de cada tela — isso garante que a tela escondida fique
  // SEMPRE completamente oculta (display:none), mesmo que o CSS
  // externo ainda não tenha carregado ou esteja com cache antigo.
  function mostrarTela(idTela) {
    [telaLogin, telaDashboard, telaCheckin].forEach(function (tela) {
      if (!tela) return;
      const estaAtiva = tela.id === idTela;
      tela.classList.toggle('active', estaAtiva);
      tela.style.display = estaAtiva ? 'block' : 'none';
    });
  }

  /* ----------------------------------------------------------
     1) LOGIN / LOGOUT
     ---------------------------------------------------------- */

  const loginEmail = document.getElementById('loginEmail');
  const loginSenha = document.getElementById('loginSenha');
  const btnLogin = document.getElementById('btnLogin');
  const erroLogin = document.getElementById('erroLogin');
  const adminEmailLogado = document.getElementById('adminEmailLogado');

  function mostrarErroLogin(mensagem) {
    erroLogin.textContent = mensagem;
    erroLogin.style.display = 'block';
  }

  function esconderErroLogin() {
    erroLogin.style.display = 'none';
    erroLogin.textContent = '';
  }

  // Cria o botão de "mostrar/ocultar senha" (ícone de olho) e o
  // insere dentro do próprio campo de senha, sem depender de nenhum
  // elemento novo no HTML. Envolve só o <input> (não o .field
  // inteiro, que também contém o <label>) num wrapper relativo, para
  // o botão ficar posicionado exatamente em cima do campo.
  function configurarToggleSenha() {
    if (!loginSenha || document.getElementById('btnMostrarSenha')) return;

    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    loginSenha.parentNode.insertBefore(wrapper, loginSenha);
    wrapper.appendChild(loginSenha);

    loginSenha.style.paddingRight = '42px';

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.id = 'btnMostrarSenha';
    botao.setAttribute('aria-label', 'Mostrar senha');
    botao.textContent = '👁️';
    botao.style.cssText =
      'position:absolute; right:8px; top:50%; transform:translateY(-50%); ' +
      'background:none; border:none; cursor:pointer; font-size:15px; padding:6px; line-height:1;';
    wrapper.appendChild(botao);

    botao.addEventListener('click', function () {
      const estaOculta = loginSenha.type === 'password';
      loginSenha.type = estaOculta ? 'text' : 'password';
      botao.textContent = estaOculta ? '🙈' : '👁️';
      botao.setAttribute('aria-label', estaOculta ? 'Ocultar senha' : 'Mostrar senha');
    });
  }
  configurarToggleSenha();

  async function fazerLogin() {
    esconderErroLogin();

    const email = loginEmail.value.trim();
    const senha = loginSenha.value;

    if (!email || !senha) {
      mostrarErroLogin('Informe e-mail e senha.');
      return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Entrando...';

    const { data, error } = await window.supabaseClient.auth.signInWithPassword({
      email: email,
      password: senha,
    });

    btnLogin.disabled = false;
    btnLogin.textContent = 'Entrar';

    if (error) {
      mostrarErroLogin('E-mail ou senha inválidos.');
      return;
    }

    loginSenha.value = '';
    await iniciarDashboard(data.session);
  }

  btnLogin.addEventListener('click', fazerLogin);

  // Permite logar apertando Enter em qualquer um dos dois campos.
  [loginEmail, loginSenha].forEach(function (campo) {
    campo.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') fazerLogin();
    });
  });

  // Encerra a sessão, para a câmera (se estiver ligada), cancela a
  // inscrição do Realtime e volta para a tela de login — chamada
  // tanto pelo botão "Sair" do dashboard quanto pelo da portaria.
  async function fazerLogout() {
    pararScannerCamera();
    pararRealtime();
    await window.supabaseClient.auth.signOut();
    listaInscricoes = [];
    mostrarTela('login');
  }

  document.getElementById('btnSairDashboard').addEventListener('click', fazerLogout);
  document.getElementById('btnSairCheckin').addEventListener('click', fazerLogout);

  /* ----------------------------------------------------------
     2) DASHBOARD — carregamento e exibição dos dados
     ---------------------------------------------------------- */

  const statTotal = document.getElementById('statTotal');
  const statTotalSub = document.getElementById('statTotalSub');
  const statArrecadado = document.getElementById('statArrecadado');
  const statPendentes = document.getElementById('statPendentes');
  const statCheckins = document.getElementById('statCheckins');

  const tabelaBody = document.getElementById('tabelaInscricoesBody');
  const tabelaVazia = document.getElementById('tabelaVazia');
  const tabelaCarregando = document.getElementById('tabelaCarregando');

  const btnAtualizarLista = document.getElementById('btnAtualizarLista');
  const btnExportarCsv = document.getElementById('btnExportarCsv');
  const btnIrCheckin = document.getElementById('btnIrCheckin');
  const btnVoltarDashboard = document.getElementById('btnVoltarDashboard');

  const NOMES_COMBO = {
    SEXTA: 'Sexta',
    SABADO: 'Sábado',
    COMBO: 'Combo',
  };

  const NOMES_STATUS = {
    pendente: 'Pendente',
    aprovado: 'Aprovado',
    recusado: 'Recusado',
  };

  // Cache local dos dados carregados. É usada pela tabela, pelos
  // contadores, pela busca/filtro, pela exportação em CSV e pelo
  // check-in (para manter os contadores da portaria coerentes com
  // o dashboard sem precisar buscar tudo de novo a cada leitura).
  let listaInscricoes = [];

  function formatarMoeda(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  async function iniciarDashboard(sessao) {
    const usuario = sessao && sessao.user ? sessao.user : (await window.supabaseClient.auth.getUser()).data.user;
    adminEmailLogado.textContent = usuario ? usuario.email : '—';

    mostrarTela('dashboard');
    await carregarInscricoes();
    iniciarRealtime();
  }

  async function carregarInscricoes() {
    tabelaCarregando.style.display = 'block';
    tabelaVazia.style.display = 'none';
    tabelaBody.innerHTML = '';

    const { data, error } = await window.supabaseClient
      .from('inscricoes')
      .select('*')
      .order('created_at', { ascending: false });

    tabelaCarregando.style.display = 'none';

    if (error) {
      tabelaVazia.textContent = 'Não foi possível carregar as inscrições. Tente atualizar a página.';
      tabelaVazia.style.display = 'block';
      return;
    }

    listaInscricoes = data || [];
    renderizarTabela();
    atualizarEstatisticas();
  }

  function badgeStatusHtml(status) {
    const classe = status === 'aprovado' ? 'ok' : status === 'recusado' ? 'fail' : 'pending';
    return '<span class="badge ' + classe + '">' + (NOMES_STATUS[status] || status) + '</span>';
  }

  /* ----------------------------------------------------------
     2.1) BUSCA / FILTRO DA TABELA
     ---------------------------------------------------------- */

  // Campo de busca criado dinamicamente (não existe no admin.html
  // original) e inserido logo acima da tabela. Filtra por nome,
  // e-mail, código ou status — tudo em memória, sobre os dados já
  // carregados, sem precisar de uma nova consulta ao Supabase.
  let campoFiltroTabela = null;
  let termoFiltroAtual = '';

  function criarCampoFiltro() {
    const wrapTabela = document.querySelector('.tabela-wrap');
    if (!wrapTabela || document.getElementById('campoFiltroTabela')) return;

    const container = document.createElement('div');
    container.style.marginBottom = '14px';

    campoFiltroTabela = document.createElement('input');
    campoFiltroTabela.type = 'text';
    campoFiltroTabela.id = 'campoFiltroTabela';
    campoFiltroTabela.placeholder = 'Buscar por nome, e-mail, código ou status...';
    campoFiltroTabela.autocomplete = 'off';
    campoFiltroTabela.style.cssText =
      'width:100%; padding:12px 14px; border-radius:9px; border:1.5px solid var(--cinza); ' +
      'font-size:14px; font-family:\'Inter\',sans-serif; box-sizing:border-box;';

    container.appendChild(campoFiltroTabela);
    wrapTabela.parentNode.insertBefore(container, wrapTabela);

    campoFiltroTabela.addEventListener('input', function () {
      termoFiltroAtual = campoFiltroTabela.value.trim().toLowerCase();
      renderizarTabela();
    });
  }

  // Monta uma única string com todos os campos pesquisáveis de uma
  // inscrição, em minúsculas, para comparar contra o termo digitado.
  function textoPesquisavel(inscricao) {
    return [
      inscricao.nome_completo,
      inscricao.email,
      inscricao.telefone,
      inscricao.codigo_ingresso,
      NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso,
      NOMES_STATUS[inscricao.status_pagamento] || inscricao.status_pagamento,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function renderizarTabela() {
    const listaExibida = termoFiltroAtual
      ? listaInscricoes.filter(function (i) { return textoPesquisavel(i).includes(termoFiltroAtual); })
      : listaInscricoes;

    if (listaExibida.length === 0) {
      tabelaBody.innerHTML = '';
      tabelaVazia.textContent = termoFiltroAtual
        ? 'Nenhuma inscrição encontrada para "' + campoFiltroTabela.value.trim() + '".'
        : 'Nenhuma inscrição encontrada.';
      tabelaVazia.style.display = 'block';
      return;
    }

    tabelaVazia.style.display = 'none';

    const linhasHtml = listaExibida.map(function (inscricao) {
      // O bucket "comprovantes" é privado, então não existe uma URL
      // pública fixa para linkar diretamente. Em vez de um <a href>,
      // renderizamos um botão que, ao ser clicado, pede ao Supabase
      // uma URL assinada válida por curto tempo (abrirComprovante()).
      const linkComprovante = inscricao.comprovante_url
        ? '<button type="button" class="btn-line btn-ver-comprovante" data-comprovante="' + escaparHtml(inscricao.comprovante_url) + '" style="padding:4px 10px; font-size:11px;">Ver</button>'
        : '—';

      const checkinTexto = inscricao.checkin_realizado
        ? '<span class="badge ok">Sim</span>'
        : '<span class="badge pending">Não</span>';

      return (
        '<tr data-id="' + inscricao.id + '">' +
          '<td>' + escaparHtml(inscricao.nome_completo) + '</td>' +
          '<td>' + escaparHtml(inscricao.email) + '<br><span style="color:#888;">' + escaparHtml(inscricao.telefone) + '</span></td>' +
          '<td><span class="tipo-pill">' + (NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso) + '</span></td>' +
          '<td>' + formatarMoeda(inscricao.valor_pago) + '</td>' +
          '<td>' + linkComprovante + '</td>' +
          '<td>' +
            '<select class="select-status" data-id="' + inscricao.id + '">' +
              '<option value="pendente"' + (inscricao.status_pagamento === 'pendente' ? ' selected' : '') + '>Pendente</option>' +
              '<option value="aprovado"' + (inscricao.status_pagamento === 'aprovado' ? ' selected' : '') + '>Aprovado</option>' +
              '<option value="recusado"' + (inscricao.status_pagamento === 'recusado' ? ' selected' : '') + '>Recusado</option>' +
            '</select> ' + badgeStatusHtml(inscricao.status_pagamento) +
          '</td>' +
          '<td>' + checkinTexto + '</td>' +
        '</tr>'
      );
    });

    tabelaBody.innerHTML = linhasHtml.join('');
  }

  // Evita que texto vindo do banco (nome, e-mail etc.) seja
  // interpretado como HTML ao ser injetado na tabela via innerHTML.
  function escaparHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto === null || texto === undefined ? '' : String(texto);
    return div.innerHTML;
  }

  function atualizarEstatisticas() {
    // Os contadores sempre refletem TODAS as inscrições, mesmo com
    // um filtro de busca ativo na tabela — são números do evento
    // como um todo, não da busca no momento.
    const total = listaInscricoes.length;
    const aprovados = listaInscricoes.filter(function (i) { return i.status_pagamento === 'aprovado'; });
    const pendentes = listaInscricoes.filter(function (i) { return i.status_pagamento === 'pendente'; });
    const checkins = listaInscricoes.filter(function (i) { return i.checkin_realizado; });

    const arrecadado = aprovados.reduce(function (soma, i) { return soma + Number(i.valor_pago || 0); }, 0);

    statTotal.textContent = String(total);
    statTotalSub.textContent = aprovados.length + ' aprovados';
    statArrecadado.textContent = formatarMoeda(arrecadado);
    statPendentes.textContent = String(pendentes.length);
    statCheckins.textContent = String(checkins.length);
  }

  // Extrai só o caminho do arquivo dentro do bucket a partir do
  // valor salvo em "comprovante_url". Como o bucket agora é
  // privado, esse valor pode já estar salvo como caminho puro
  // (ex.: "comprovante_123_456.jpg") ou, em registros mais antigos
  // gravados quando o bucket ainda era público, como uma URL
  // completa (".../object/public/comprovantes/comprovante_123_456.jpg").
  // Esta função cobre os dois casos, sempre devolvendo só o caminho
  // que createSignedUrl() espera receber.
  function extrairCaminhoComprovante(valorSalvo) {
    const marcador = '/comprovantes/';
    const posicao = valorSalvo.indexOf(marcador);
    if (posicao === -1) {
      return valorSalvo; // já é só o caminho dentro do bucket
    }
    return valorSalvo.slice(posicao + marcador.length);
  }

  // Gera uma URL assinada temporária (válida por 60 segundos) para
  // o comprovante e abre em uma nova aba. É gerada sob demanda, no
  // momento do clique — nunca na renderização da tabela — porque
  // uma URL assinada expira e não faria sentido deixá-la pronta
  // "esperando" na página.
  async function abrirComprovante(botao) {
    const caminho = extrairCaminhoComprovante(botao.getAttribute('data-comprovante'));
    const textoOriginal = botao.textContent;

    botao.disabled = true;
    botao.textContent = 'Abrindo...';

    const { data, error } = await window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .createSignedUrl(caminho, 60);

    botao.disabled = false;
    botao.textContent = textoOriginal;

    if (error || !data || !data.signedUrl) {
      alert('Não foi possível abrir o comprovante. Tente novamente.');
      return;
    }

    window.open(data.signedUrl, '_blank', 'noopener');
  }

  // Delegação de evento: um único listener no <tbody> cobre todos
  // os <select> de status, mesmo os que ainda vão ser criados
  // depois de recarregar a tabela.
  tabelaBody.addEventListener('change', async function (evento) {
    const select = evento.target;
    if (!select.classList.contains('select-status')) return;

    const id = select.getAttribute('data-id');
    const novoStatus = select.value;
    const statusAnterior = (listaInscricoes.find(function (i) { return String(i.id) === String(id); }) || {}).status_pagamento;

    select.disabled = true;

    const { error } = await window.supabaseClient
      .from('inscricoes')
      .update({ status_pagamento: novoStatus })
      .eq('id', id);

    select.disabled = false;

    if (error) {
      select.value = statusAnterior;
      alert('Não foi possível atualizar o status. Tente novamente.');
      return;
    }

    // Atualiza a cópia local e a linha inteira (para o badge e os
    // contadores acompanharem a mudança sem precisar recarregar
    // tudo do zero). O Realtime também vai receber esse UPDATE, mas
    // atualizar localmente já deixa a resposta instantânea para
    // quem clicou, sem esperar o round-trip do evento.
    const inscricao = listaInscricoes.find(function (i) { return String(i.id) === String(id); });
    if (inscricao) inscricao.status_pagamento = novoStatus;
    renderizarTabela();
    atualizarEstatisticas();
  });

  // Delegação separada (evento diferente) para o botão "Ver"
  // comprovante — assim ele funciona mesmo depois que a tabela é
  // recriada por renderizarTabela().
  tabelaBody.addEventListener('click', function (evento) {
    const botao = evento.target.closest('.btn-ver-comprovante');
    if (!botao) return;
    abrirComprovante(botao);
  });

  btnAtualizarLista.addEventListener('click', carregarInscricoes);

  /* ----------------------------------------------------------
     2.2) TEMPO REAL (Supabase Realtime)
     ---------------------------------------------------------- */

  // Canal do Realtime — mantido numa variável de módulo para poder
  // ser cancelado no logout (evita ficar recebendo eventos de uma
  // sessão que já terminou).
  let canalRealtime = null;

  // Evita recarregar a lista inteira várias vezes seguidas quando
  // chegam vários eventos em sequência rápida (ex.: uma edição em
  // lote no banco) — agrupa tudo numa única atualização, 500ms
  // depois do último evento recebido.
  let timeoutRealtime = null;
  function agendarRecarga() {
    clearTimeout(timeoutRealtime);
    timeoutRealtime = setTimeout(function () {
      carregarInscricoes();
    }, 500);
  }

  function iniciarRealtime() {
    if (canalRealtime) return; // já está escutando

    canalRealtime = window.supabaseClient
      .channel('inscricoes-admin-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inscricoes' },
        function () {
          // Qualquer INSERT/UPDATE/DELETE na tabela recarrega a
          // lista, para o dashboard nunca ficar desatualizado sem
          // precisar de F5 — útil, por exemplo, quando duas pessoas
          // da equipe usam o painel ao mesmo tempo.
          agendarRecarga();
        }
      )
      .subscribe();
  }

  function pararRealtime() {
    clearTimeout(timeoutRealtime);
    if (canalRealtime) {
      window.supabaseClient.removeChannel(canalRealtime);
      canalRealtime = null;
    }
  }

  /* ----------------------------------------------------------
     3) EXPORTAÇÃO EM CSV (para o financeiro)
     ---------------------------------------------------------- */

  // Coloca aspas ao redor de qualquer campo que contenha vírgula,
  // aspas ou quebra de linha, e escapa aspas internas — regra
  // padrão do formato CSV (RFC 4180).
  function celulaCsv(valor) {
    const texto = valor === null || valor === undefined ? '' : String(valor);
    if (/[",\n]/.test(texto)) {
      return '"' + texto.replace(/"/g, '""') + '"';
    }
    return texto;
  }

  function exportarCsv() {
    if (listaInscricoes.length === 0) {
      alert('Não há inscrições para exportar.');
      return;
    }

    const cabecalho = ['Nome', 'E-mail', 'Telefone', 'Tipo de Ingresso', 'Valor', 'Status', 'Código', 'Link do Comprovante'];

    const linhas = listaInscricoes.map(function (i) {
      // Como o bucket é privado, a URL antiga (quando existir) não
      // abre sozinha num navegador — só o caminho do arquivo é
      // útil aqui, para quem for gerar uma URL assinada depois a
      // partir do painel ou do Supabase diretamente.
      const caminhoComprovante = i.comprovante_url ? extrairCaminhoComprovante(i.comprovante_url) : '';

      return [
        celulaCsv(i.nome_completo),
        celulaCsv(i.email),
        celulaCsv(i.telefone),
        celulaCsv(NOMES_COMBO[i.tipo_ingresso] || i.tipo_ingresso),
        celulaCsv(Number(i.valor_pago || 0).toFixed(2).replace('.', ',')),
        celulaCsv(NOMES_STATUS[i.status_pagamento] || i.status_pagamento),
        celulaCsv(i.codigo_ingresso),
        celulaCsv(caminhoComprovante),
      ].join(',');
    });

    // "\uFEFF" (BOM) no início garante que o Excel abra o arquivo
    // reconhecendo corretamente os acentos em UTF-8.
    const conteudoCsv = '\uFEFF' + [cabecalho.join(','), ...linhas].join('\r\n');

    const blob = new Blob([conteudoCsv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const dataFormatada = new Date().toISOString().slice(0, 10);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'freedom-conf-2026-inscricoes-' + dataFormatada + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  btnExportarCsv.addEventListener('click', exportarCsv);

  /* ----------------------------------------------------------
     4) NAVEGAÇÃO DASHBOARD ↔ CHECK-IN
     ---------------------------------------------------------- */

  btnIrCheckin.addEventListener('click', function () {
    mostrarTela('checkin');
    // Começa a portaria "limpa": sem resultado de leitura anterior
    // na tela e sem nenhum código digitado sobrando no campo manual.
    checkinResultado.className = 'checkin-resultado';
    checkinResultadoTitulo.textContent = '';
    checkinResultadoDetalhe.textContent = '';
    codigoManualInput.value = '';
    processandoCheckin = false;
    cooldownCameraAtivo = false;
    atualizarContadoresCheckin();
    iniciarScannerCamera();
  });

  btnVoltarDashboard.addEventListener('click', function () {
    pararScannerCamera();
    mostrarTela('dashboard');
    // Garante que qualquer check-in feito na portaria já apareça
    // refletido na tabela e nos contadores do dashboard.
    renderizarTabela();
    atualizarEstatisticas();
  });

  /* ----------------------------------------------------------
     5) CHECK-IN — validação de código (manual e por câmera)
     ---------------------------------------------------------- */

  const codigoManualInput = document.getElementById('codigoManualInput');
  const btnValidarManual = document.getElementById('btnValidarManual');
  const checkinResultado = document.getElementById('checkinResultado');
  const checkinResultadoTitulo = document.getElementById('checkinResultadoTitulo');
  const checkinResultadoDetalhe = document.getElementById('checkinResultadoDetalhe');
  const checkinContadorFeitos = document.getElementById('checkinContadorFeitos');
  const checkinContadorAprovados = document.getElementById('checkinContadorAprovados');

  function atualizarContadoresCheckin() {
    const aprovados = listaInscricoes.filter(function (i) { return i.status_pagamento === 'aprovado'; });
    const feitos = listaInscricoes.filter(function (i) { return i.checkin_realizado; });
    checkinContadorAprovados.textContent = String(aprovados.length);
    checkinContadorFeitos.textContent = String(feitos.length);
  }

  function mostrarResultadoCheckin(tipo, titulo, detalhe) {
    checkinResultado.className = 'checkin-resultado ' + tipo; // 'ok' | 'aviso' | 'erro'
    checkinResultadoTitulo.textContent = titulo;
    checkinResultadoDetalhe.textContent = detalhe;
  }

  // Evita que uma segunda leitura (manual ou por câmera) seja
  // processada enquanto a primeira ainda está em andamento.
  let processandoCheckin = false;

  // Cooldown específico do LEITOR DE CÂMERA: depois de qualquer
  // leitura, a câmera fica "surda" por alguns segundos antes de
  // aceitar uma nova leitura automática. Isso evita que o mesmo QR
  // code (ainda visível no enquadramento) seja lido várias vezes em
  // sequência rapidíssima enquanto o resultado é exibido na tela —
  // a validação manual (botão "Validar") NÃO é afetada por este
  // cooldown, já que ali a intenção de repetir é sempre explícita.
  let cooldownCameraAtivo = false;
  const DURACAO_COOLDOWN_CAMERA_MS = 4000; // 4 segundos

  async function processarCodigo(codigoDigitado, viaCamera) {
    if (processandoCheckin) return;
    if (viaCamera && cooldownCameraAtivo) return;

    const codigo = (codigoDigitado || '').trim().toUpperCase();
    if (!codigo) {
      mostrarResultadoCheckin('erro', 'Código vazio', 'Digite ou escaneie um código válido.');
      return;
    }

    processandoCheckin = true;
    btnValidarManual.disabled = true;

    try {
      const { data: inscricao, error } = await window.supabaseClient
        .from('inscricoes')
        .select('*')
        .eq('codigo_ingresso', codigo)
        .maybeSingle();

      if (error || !inscricao) {
        mostrarResultadoCheckin('erro', 'Código não encontrado', 'Confira o código e tente novamente: ' + codigo);
        return;
      }

      if (inscricao.status_pagamento !== 'aprovado') {
        mostrarResultadoCheckin(
          'aviso',
          'Pagamento ainda não aprovado',
          inscricao.nome_completo + ' — status atual: ' + (NOMES_STATUS[inscricao.status_pagamento] || inscricao.status_pagamento) + '. Encaminhe ao financeiro antes de liberar a entrada.'
        );
        return;
      }

      if (inscricao.checkin_realizado) {
        mostrarResultadoCheckin('aviso', 'Check-in já realizado', inscricao.nome_completo + ' já entrou anteriormente.');
        return;
      }

      const { error: erroUpdate } = await window.supabaseClient
        .from('inscricoes')
        .update({ checkin_realizado: true })
        .eq('id', inscricao.id);

      if (erroUpdate) {
        mostrarResultadoCheckin('erro', 'Erro ao confirmar check-in', 'Tente novamente em instantes.');
        return;
      }

      // Reflete a mudança na cópia local para os contadores da
      // portaria e do dashboard ficarem corretos sem novo fetch (o
      // Realtime também vai confirmar essa mudança pouco depois).
      inscricao.checkin_realizado = true;
      const jaExisteNaLista = listaInscricoes.some(function (i) { return String(i.id) === String(inscricao.id); });
      if (jaExisteNaLista) {
        listaInscricoes = listaInscricoes.map(function (i) {
          return String(i.id) === String(inscricao.id) ? inscricao : i;
        });
      } else {
        listaInscricoes.push(inscricao);
      }
      atualizarContadoresCheckin();

      mostrarResultadoCheckin(
        'ok',
        'Entrada liberada ✓',
        inscricao.nome_completo + ' — ' + (NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso)
      );
    } finally {
      processandoCheckin = false;
      btnValidarManual.disabled = false;
      codigoManualInput.value = '';
      codigoManualInput.focus();

      // Só a câmera entra em cooldown — a validação manual pode ser
      // repetida imediatamente, caso o operador precise corrigir e
      // digitar outro código em seguida.
      if (viaCamera) {
        cooldownCameraAtivo = true;
        setTimeout(function () {
          cooldownCameraAtivo = false;
        }, DURACAO_COOLDOWN_CAMERA_MS);
      }
    }
  }

  btnValidarManual.addEventListener('click', function () {
    processarCodigo(codigoManualInput.value, false);
  });

  codigoManualInput.addEventListener('keydown', function (evento) {
    if (evento.key === 'Enter') processarCodigo(codigoManualInput.value, false);
  });

  /* ----------------------------------------------------------
     6) CHECK-IN — leitura de QR code pela câmera (html5-qrcode)
     ---------------------------------------------------------- */

  let scannerCamera = null;

  function iniciarScannerCamera() {
    if (typeof Html5Qrcode === 'undefined') {
      console.error('[admin.js] Biblioteca html5-qrcode não carregada.');
      return;
    }
    if (scannerCamera) return; // já está rodando

    scannerCamera = new Html5Qrcode('qr-reader');

    const configuracao = { fps: 10, qrbox: { width: 240, height: 240 } };

    scannerCamera
      .start(
        { facingMode: 'environment' },
        configuracao,
        function aoLerCodigo(textoDecodificado) {
          // Bloqueado tanto pelo "processandoCheckin" (leitura em
          // andamento) quanto pelo cooldown da câmera (leitura
          // recém-concluída) — impede o loop de leituras repetidas
          // do mesmo código enquanto ele continua no enquadramento.
          if (scannerCamera && !processandoCheckin && !cooldownCameraAtivo) {
            processarCodigo(textoDecodificado, true);
          }
        },
        function aoFalharLeitura() {
          // Chamado a cada frame sem QR code detectado — não é um
          // erro real, então é intencionalmente ignorado.
        }
      )
      .catch(function (erro) {
        mostrarResultadoCheckin(
          'erro',
          'Câmera indisponível',
          'Não foi possível acessar a câmera. Verifique as permissões do navegador ou use a validação manual abaixo.'
        );
        console.error('[admin.js] Erro ao iniciar a câmera:', erro);
      });
  }

  function pararScannerCamera() {
    cooldownCameraAtivo = false;
    if (!scannerCamera) return;
    scannerCamera
      .stop()
      .then(function () {
        scannerCamera.clear();
        scannerCamera = null;
      })
      .catch(function () {
        scannerCamera = null;
      });
  }

  /* ----------------------------------------------------------
     7) PONTO DE ENTRADA: verifica sessão ao abrir a página
     ---------------------------------------------------------- */

  // Mantém o painel sincronizado se a sessão expirar ou for
  // encerrada em outra aba.
  window.supabaseClient.auth.onAuthStateChange(function (evento, sessao) {
    if (evento === 'SIGNED_OUT') {
      pararScannerCamera();
      pararRealtime();
      mostrarTela('login');
    }
  });

  (async function verificarSessaoInicial() {
    criarCampoFiltro();

    const { data } = await window.supabaseClient.auth.getSession();
    if (data && data.session) {
      await iniciarDashboard(data.session);
    } else {
      mostrarTela('login');
    }
  })();
});
