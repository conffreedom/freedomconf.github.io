/* ============================================================
   js/admin.js
   ------------------------------------------------------------
   Lógica do PAINEL ADMINISTRATIVO (admin.html):
     1) Login / logout via Supabase Auth, com proteção de acesso;
     2) Dashboard: contadores, tabela de inscrições e alteração
        de status de pagamento;
     3) Exportação da lista em CSV para o financeiro;
     4) Portaria / Check-in: leitura de QR code pela câmera e
        validação manual do código do ingresso.

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

  // Alterna qual das 3 telas fica visível, usando a classe
  // ".active" já definida em css/styles.css.
  function mostrarTela(idTela) {
    [telaLogin, telaDashboard, telaCheckin].forEach(function (tela) {
      if (!tela) return;
      tela.classList.toggle('active', tela.id === idTela);
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

  async function fazerLogout() {
    pararScannerCamera();
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
  // contadores, pela exportação em CSV e pelo check-in (para
  // manter os contadores da portaria coerentes com o dashboard
  // sem precisar buscar tudo de novo a cada leitura de QR code).
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

  function renderizarTabela() {
    if (listaInscricoes.length === 0) {
      tabelaBody.innerHTML = '';
      tabelaVazia.textContent = 'Nenhuma inscrição encontrada.';
      tabelaVazia.style.display = 'block';
      return;
    }

    tabelaVazia.style.display = 'none';

    const linhasHtml = listaInscricoes.map(function (inscricao) {
      const linkComprovante = inscricao.comprovante_url
        ? '<a href="' + inscricao.comprovante_url + '" target="_blank" rel="noopener" class="btn-line" style="padding:4px 10px; font-size:11px;">Ver</a>'
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
    // tudo do zero).
    const inscricao = listaInscricoes.find(function (i) { return String(i.id) === String(id); });
    if (inscricao) inscricao.status_pagamento = novoStatus;
    renderizarTabela();
    atualizarEstatisticas();
  });

  btnAtualizarLista.addEventListener('click', carregarInscricoes);

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
      return [
        celulaCsv(i.nome_completo),
        celulaCsv(i.email),
        celulaCsv(i.telefone),
        celulaCsv(NOMES_COMBO[i.tipo_ingresso] || i.tipo_ingresso),
        celulaCsv(Number(i.valor_pago || 0).toFixed(2).replace('.', ',')),
        celulaCsv(NOMES_STATUS[i.status_pagamento] || i.status_pagamento),
        celulaCsv(i.codigo_ingresso),
        celulaCsv(i.comprovante_url || ''),
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

  // Evita que o mesmo código seja processado duas vezes seguidas
  // muito rápido (ex.: a câmera detecta o mesmo QR em vários
  // frames antes do resultado anterior sumir da tela).
  let processandoCheckin = false;

  async function processarCodigo(codigoDigitado) {
    if (processandoCheckin) return;

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
      // portaria e do dashboard ficarem corretos sem novo fetch.
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
    }
  }

  btnValidarManual.addEventListener('click', function () {
    processarCodigo(codigoManualInput.value);
  });

  codigoManualInput.addEventListener('keydown', function (evento) {
    if (evento.key === 'Enter') processarCodigo(codigoManualInput.value);
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
          // Pausa a câmera enquanto o código lido é validado no
          // banco, para não disparar o mesmo scan várias vezes.
          if (scannerCamera && !processandoCheckin) {
            processarCodigo(textoDecodificado);
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
      mostrarTela('login');
    }
  });

  (async function verificarSessaoInicial() {
    const { data } = await window.supabaseClient.auth.getSession();
    if (data && data.session) {
      await iniciarDashboard(data.session);
    } else {
      mostrarTela('login');
    }
  })();
});