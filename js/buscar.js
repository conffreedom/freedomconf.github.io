/* ============================================================
   js/buscar.js
   ------------------------------------------------------------
   Lógica do PORTAL DO PARTICIPANTE / CREDENCIAL (buscar.html):
     1) Busca em PASSO ÚNICO por Nome completo + E-mail + PIN de 4
        dígitos, via a RPC segura buscar_credencial_individual — a
        tabela "inscricoes" tem RLS bloqueando todo SELECT anônimo
        direto, então este arquivo nunca consulta a tabela por
        conta própria; tudo passa pela função no servidor, que
        valida os três campos de uma vez e só devolve a credencial
        correspondente;
     2) Renderização dos 3 estados (pendente / recusado / aprovado)
        e da credencial com QR code estilizado;
     3) Proteção anti-força-bruta via localStorage: bloqueio
        temporário após 5 tentativas incorretas;
     4) Download da credencial em PNG via html2canvas.

   ATENÇÃO — mudança de arquitetura (decisão de segurança): versões
   anteriores deste arquivo buscavam por e-mail OU código, listavam
   todos os participantes daquele e-mail (expondo nomes de outras
   pessoas cadastradas no mesmo e-mail antes de qualquer
   autenticação) e só depois pediam o PIN individualmente, por
   pessoa escolhida. Isso foi descartado de propósito: agora a busca
   já exige nome + e-mail + PIN toda vez, os três batendo ao mesmo
   tempo, então não existe mais lista de participantes nem modal de
   seleção — a RPC devolve OU a credencial exata, OU nada.
   Por isso os antigos #modalSelecaoParticipantes e #modalPin (e
   toda a lógica que dependia deles) saíram deste arquivo.

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient),
       carregado ANTES deste arquivo;
     - biblioteca QRCode.js (window.QRCode) e html2canvas
       (window.html2canvas), carregadas no <head> do buscar.html.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ----------------------------------------------------------
     0) ELEMENTOS E HELPERS GERAIS
     ---------------------------------------------------------- */

  const NOMES_COMBO = {
    SEXTA: 'Sexta-feira (30/10)',
    SABADO: 'Sábado (31/10)',
    COMBO: 'Sexta + Sábado',
  };

  const campoBuscaNome = document.getElementById('campoBuscaNome');
  const campoBuscaEmail = document.getElementById('campoBuscaEmail');
  const campoBuscaPin = document.getElementById('campoBuscaPin');
  const btnBuscarCredencial = document.getElementById('btnBuscarCredencial');
  const erroBuscaCredencial = document.getElementById('erroBuscaCredencial');

  const bloqueioAviso = document.getElementById('bloqueioAviso');
  const bloqueioAvisoTexto = document.getElementById('bloqueioAvisoTexto');

  const resultadoConsulta = document.getElementById('resultadoConsulta');
  const resultadoPendente = document.getElementById('resultadoPendente');
  const resultadoRecusado = document.getElementById('resultadoRecusado');
  const resultadoNaoEncontrado = document.getElementById('resultadoNaoEncontrado');
  const resultadoAprovado = document.getElementById('resultadoAprovado');

  const pendenteNome = document.getElementById('pendenteNome');
  const pendenteCombo = document.getElementById('pendenteCombo');
  const pendenteCodigo = document.getElementById('pendenteCodigo');

  const recusadoNome = document.getElementById('recusadoNome');
  const recusadoCodigo = document.getElementById('recusadoCodigo');

  const credencialContainer = document.getElementById('credencialContainer');
  const credencialNome = document.getElementById('credencialNome');
  const credencialTipo = document.getElementById('credencialTipo');
  const credencialQrcodeBox = document.getElementById('credencialQrcodeBox');
  const credencialCodigo = document.getElementById('credencialCodigo');
  const btnBaixarCredencial = document.getElementById('btnBaixarCredencial');

  function mostrarErro(elementoErro, mensagem) {
    if (!elementoErro) return;
    elementoErro.textContent = mensagem;
    elementoErro.style.display = 'block';
  }

  function esconderErro(elementoErro) {
    if (!elementoErro) return;
    elementoErro.style.display = 'none';
    elementoErro.textContent = '';
  }

  // Extrai a melhor mensagem de diagnóstico disponível de um erro,
  // seja ele um Error do JavaScript ou um objeto de erro retornado
  // pelo Supabase. Sempre retorna uma string, nunca undefined.
  function obterMensagemErro(erro, fallback) {
    if (!erro) return fallback;
    if (typeof erro === 'string') return erro;
    return erro.message || erro.error_description || fallback;
  }

  // "Primeiro + Último Nome" para o cabeçalho da credencial — o
  // nome completo às vezes é longo demais para caber bonito no card.
  function obterPrimeiroEUltimoNome(nomeCompleto) {
    const partes = (nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
    if (partes.length <= 1) return partes[0] || '';
    return partes[0] + ' ' + partes[partes.length - 1];
  }

  /* ----------------------------------------------------------
     1) PROTEÇÃO ANTI-FORÇA-BRUTA (localStorage)
     ---------------------------------------------------------- */

  // Cada tentativa incorreta (nome/e-mail/PIN não batendo juntos)
  // soma 1 neste contador; ao atingir o máximo, grava um horário de
  // desbloqueio no futuro e zera o contador. Tudo isolado por
  // dispositivo/navegador, já que localStorage não é compartilhado
  // entre aparelhos.
  const CHAVE_TENTATIVAS = 'freedomBuscarTentativasErradas';
  const CHAVE_BLOQUEIO_ATE = 'freedomBuscarBloqueadoAte';
  const MAX_TENTATIVAS_ERRADAS = 5;
  const DURACAO_BLOQUEIO_MS = 30 * 60 * 1000; // 30 minutos

  function obterBloqueioAte() {
    const valor = Number(localStorage.getItem(CHAVE_BLOQUEIO_ATE));
    return Number.isFinite(valor) ? valor : 0;
  }

  // Verifica se ainda há um bloqueio ativo. Se o bloqueio salvo já
  // expirou, limpa tudo sozinho (tentativas + horário) — o usuário
  // não precisa fazer nada para "destravar" depois do tempo passar.
  function estaBloqueado() {
    const bloqueioAte = obterBloqueioAte();
    if (bloqueioAte && Date.now() < bloqueioAte) {
      return true;
    }
    if (bloqueioAte) {
      localStorage.removeItem(CHAVE_BLOQUEIO_ATE);
      localStorage.removeItem(CHAVE_TENTATIVAS);
    }
    return false;
  }

  function minutosRestantesDeBloqueio() {
    const restanteMs = obterBloqueioAte() - Date.now();
    return Math.max(1, Math.ceil(restanteMs / 60000));
  }

  function registrarTentativaErrada() {
    const tentativas = (Number(localStorage.getItem(CHAVE_TENTATIVAS)) || 0) + 1;
    if (tentativas >= MAX_TENTATIVAS_ERRADAS) {
      localStorage.setItem(CHAVE_BLOQUEIO_ATE, String(Date.now() + DURACAO_BLOQUEIO_MS));
      localStorage.setItem(CHAVE_TENTATIVAS, '0');
    } else {
      localStorage.setItem(CHAVE_TENTATIVAS, String(tentativas));
    }
  }

  // Acertar a combinação reseta o contador — só tentativas ERRADAS
  // contam para o bloqueio.
  function resetarTentativas() {
    localStorage.removeItem(CHAVE_TENTATIVAS);
    localStorage.removeItem(CHAVE_BLOQUEIO_ATE);
  }

  // Reflete o estado de bloqueio na tela: mostra/esconde o aviso e
  // desabilita o botão de busca.
  function atualizarUiBloqueio() {
    const bloqueado = estaBloqueado();

    if (bloqueado) {
      bloqueioAvisoTexto.textContent = ' Tente novamente em cerca de ' + minutosRestantesDeBloqueio() + ' minuto(s).';
      bloqueioAviso.style.display = 'block';
    } else {
      bloqueioAviso.style.display = 'none';
    }

    if (btnBuscarCredencial) btnBuscarCredencial.disabled = bloqueado;

    return bloqueado;
  }

  // Roda uma vez ao carregar a página — se a pessoa já estava
  // bloqueada de uma visita anterior (mesmo navegador), o aviso já
  // aparece na hora, sem precisar tentar buscar de novo primeiro.
  atualizarUiBloqueio();

  /* ----------------------------------------------------------
     2) MÁSCARA DO CAMPO PIN (4 dígitos numéricos)
     ---------------------------------------------------------- */

  if (campoBuscaPin) {
    campoBuscaPin.addEventListener('input', function (evento) {
      evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, 4);
    });
  }

  /* ----------------------------------------------------------
     3) RESULTADO: estados (pendente/recusado/aprovado/não
        encontrado) e credencial com QR code
     ---------------------------------------------------------- */

  function esconderTodosOsResultados() {
    [resultadoPendente, resultadoRecusado, resultadoNaoEncontrado, resultadoAprovado].forEach(function (el) {
      if (el) el.style.display = 'none';
    });
    if (resultadoConsulta) resultadoConsulta.style.display = 'none';
  }

  function mostrarEstado(elementoParaMostrar) {
    [resultadoPendente, resultadoRecusado, resultadoNaoEncontrado, resultadoAprovado].forEach(function (el) {
      if (el) el.style.display = 'none';
    });
    if (elementoParaMostrar) elementoParaMostrar.style.display = 'block';
    resultadoConsulta.style.display = 'block';
  }

  function gerarQrCodeCredencial(codigo) {
    if (!credencialQrcodeBox || typeof QRCode === 'undefined') return;
    credencialQrcodeBox.innerHTML = '';
    new QRCode(credencialQrcodeBox, {
      text: codigo,
      width: 160,
      height: 160,
      colorDark: '#0f281e',
      colorLight: '#f5f0eb',
    });
  }

  function renderizarResultado(inscricao) {
    if (inscricao.status_pagamento === 'aprovado') {
      credencialNome.textContent = obterPrimeiroEUltimoNome(inscricao.nome_completo);
      credencialTipo.textContent = NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso;
      credencialCodigo.textContent = inscricao.codigo_ingresso;
      gerarQrCodeCredencial(inscricao.codigo_ingresso);
      mostrarEstado(resultadoAprovado);
    } else if (inscricao.status_pagamento === 'recusado') {
      recusadoNome.textContent = (inscricao.nome_completo || '').split(' ')[0];
      recusadoCodigo.textContent = inscricao.codigo_ingresso;
      mostrarEstado(resultadoRecusado);
    } else {
      // Qualquer outro valor (na prática, "pendente") cai aqui.
      pendenteNome.textContent = (inscricao.nome_completo || '').split(' ')[0];
      pendenteCombo.textContent = NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso;
      pendenteCodigo.textContent = inscricao.codigo_ingresso;
      mostrarEstado(resultadoPendente);
    }
  }

  /* ----------------------------------------------------------
     4) BUSCA EM PASSO ÚNICO (nome + e-mail + PIN via RPC)
     ---------------------------------------------------------- */

  // Único ponto de contato com o backend para localizar a credencial.
  // Os três campos são sanitizados com .trim() antes de seguir para
  // a RPC — o PIN também já vem só com dígitos, graças à máscara da
  // seção 2, mas o .trim() aqui é uma segunda camada de segurança
  // caso o valor chegue de outra forma (ex.: autocomplete do
  // navegador colando espaços).
  async function buscarCredencial() {
    esconderErro(erroBuscaCredencial);
    esconderTodosOsResultados();

    if (atualizarUiBloqueio()) {
      // Já bloqueado por tentativas erradas anteriores — nem tenta
      // buscar, só reforça o aviso na tela.
      return;
    }

    const nome = (campoBuscaNome.value || '').trim();
    const email = (campoBuscaEmail.value || '').trim();
    const pin = (campoBuscaPin.value || '').trim();

    if (!nome) {
      mostrarErro(erroBuscaCredencial, 'Digite seu nome completo.');
      campoBuscaNome.focus();
      return;
    }
    if (!email) {
      mostrarErro(erroBuscaCredencial, 'Digite o e-mail usado na inscrição.');
      campoBuscaEmail.focus();
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      mostrarErro(erroBuscaCredencial, 'Digite o PIN de 4 números.');
      campoBuscaPin.focus();
      return;
    }

    btnBuscarCredencial.disabled = true;
    const textoOriginalBotao = btnBuscarCredencial.textContent;
    btnBuscarCredencial.textContent = 'Buscando...';

    try {
      // A RPC valida nome + e-mail + PIN juntos, no servidor — o
      // navegador nunca lê a tabela "inscricoes" diretamente, e só
      // recebe de volta a credencial correspondente (ou nada).
      const { data, error } = await window.supabaseClient.rpc('buscar_credencial_individual', {
        p_nome: nome,
        p_email: email,
        p_pin: pin,
      });

      if (error) {
        mostrarErro(erroBuscaCredencial, obterMensagemErro(error, 'Não foi possível concluir a busca. Tente novamente.'));
        return;
      }

      if (!Array.isArray(data) || data.length === 0) {
        registrarTentativaErrada();
        if (!atualizarUiBloqueio()) {
          mostrarEstado(resultadoNaoEncontrado);
        }
        return;
      }

      // Nome + e-mail + PIN bateram: zera o contador de tentativas
      // erradas e renderiza a credencial encontrada.
      resetarTentativas();
      renderizarResultado(data[0]);
    } catch (erro) {
      console.error('[buscar.js] Erro ao buscar credencial:', erro);
      mostrarErro(erroBuscaCredencial, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnBuscarCredencial.textContent = textoOriginalBotao;
      btnBuscarCredencial.disabled = estaBloqueado();
    }
  }

  if (btnBuscarCredencial) {
    btnBuscarCredencial.addEventListener('click', buscarCredencial);
  }

  [campoBuscaNome, campoBuscaEmail, campoBuscaPin].forEach(function (campo) {
    if (!campo) return;
    campo.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') buscarCredencial();
    });
  });

  /* ----------------------------------------------------------
     5) DOWNLOAD DA CREDENCIAL EM PNG (html2canvas)
     ---------------------------------------------------------- */

  if (btnBaixarCredencial) {
    btnBaixarCredencial.addEventListener('click', async function () {
      if (!credencialContainer || typeof html2canvas === 'undefined') return;

      const textoOriginalBotao = btnBaixarCredencial.textContent;
      btnBaixarCredencial.disabled = true;
      btnBaixarCredencial.textContent = 'Gerando imagem...';

      try {
        // "backgroundColor" garante que o fundo #0f281e do card
        // apareça na imagem mesmo se, por algum motivo, o container
        // tiver alguma transparência não capturada corretamente;
        // "scale: 2" deixa o PNG final mais nítido (boa resolução
        // mesmo em telas de celular).
        const canvas = await html2canvas(credencialContainer, {
          backgroundColor: '#0f281e',
          scale: 2,
          useCORS: true,
        });

        const nomeElemento = document.getElementById('credencialNome')?.textContent || 'participante';
        const codigoElemento = document.getElementById('credencialCodigo')?.textContent || '';

        // Trata o nome (remove acentos, espaços viram hífens e fica em minúsculo)
        const nomeFormatado = nomeElemento
          .trim()
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-');

        // Nome único do arquivo (ex.: credencial-felipe-santos-fc2026-3wxz9z.png)
        const sufixoCodigo = codigoElemento ? `-${codigoElemento.toLowerCase()}` : '';
        const link = document.createElement('a');
        link.download = `credencial-${nomeFormatado}${sufixoCodigo}.png`;
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (erro) {
        console.error('[buscar.js] Erro ao gerar a imagem da credencial:', erro);
        alert('Não foi possível gerar a imagem da credencial. Tente novamente.');
      } finally {
        btnBaixarCredencial.disabled = false;
        btnBaixarCredencial.textContent = textoOriginalBotao;
      }
    });
  }
});
