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

  // Modal de seleção de INGRESSO (não de participante — nome+e-mail+
  // PIN já identificam uma pessoa só; isto é para quando essa mesma
  // pessoa tem mais de uma inscrição, ex.: comprou Sexta e depois
  // Sábado separadamente). Ver nota no final da resposta sobre o
  // HTML que este modal precisa ter em buscar.html.
  const modalSelecaoIngressos = document.getElementById('modalSelecaoIngressos');
  const btnFecharModalSelecaoIngressos = document.getElementById('btnFecharModalSelecaoIngressos');
  const seletorIngressos = document.getElementById('seletorIngressos');

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

  // Formata uma data ISO (como o Supabase devolve em "created_at")
  // no padrão brasileiro DD/MM/AAAA. Usa os componentes locais do
  // Date (dia/mês/ano do fuso do navegador), não UTC — para a data
  // exibida bater com o dia que a pessoa realmente viveu ao se
  // inscrever, não o de outro fuso horário.
  function formatarDataBr(dataIso) {
    if (!dataIso) return '';
    const data = new Date(dataIso);
    if (Number.isNaN(data.getTime())) return '';
    const dia = String(data.getDate()).padStart(2, '0');
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const ano = data.getFullYear();
    return dia + '/' + mes + '/' + ano;
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

  /* ----------------------------------------------------------
     3.1) MODAL DE SELEÇÃO DE INGRESSOS (mesma pessoa, mais de uma
          inscrição — ex.: Sexta comprada separada do Sábado)
     ---------------------------------------------------------- */

  function mostrarModalSelecaoIngressos() {
    if (modalSelecaoIngressos) modalSelecaoIngressos.classList.add('aberto');
  }

  function esconderModalSelecaoIngressos() {
    if (modalSelecaoIngressos) modalSelecaoIngressos.classList.remove('aberto');
  }

  if (btnFecharModalSelecaoIngressos) {
    btnFecharModalSelecaoIngressos.addEventListener('click', esconderModalSelecaoIngressos);
  }

  if (modalSelecaoIngressos) {
    // Clicar na área escurecida (fora dos cards) também fecha o
    // modal — só o clique diretamente no overlay conta.
    modalSelecaoIngressos.addEventListener('click', function (evento) {
      if (evento.target === modalSelecaoIngressos) esconderModalSelecaoIngressos();
    });
  }

  // Tecla Esc fecha o modal de seleção, se estiver aberto no momento.
  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && modalSelecaoIngressos && modalSelecaoIngressos.classList.contains('aberto')) {
      esconderModalSelecaoIngressos();
    }
  });

  // Devolve o badge visual certo (classe + texto) para o status de
  // pagamento de UM ingresso — reaproveita as mesmas classes .badge
  // já usadas no resto do site (.ok/.pending/.fail).
  function criarBadgeStatus(statusPagamento) {
    const badge = document.createElement('span');
    if (statusPagamento === 'aprovado') {
      badge.className = 'badge ok';
      badge.textContent = 'Aprovado';
    } else if (statusPagamento === 'recusado') {
      badge.className = 'badge fail';
      badge.textContent = 'Recusado';
    } else {
      // Qualquer outro valor (na prática, "pendente") cai aqui —
      // mesmo critério usado em renderizarResultado().
      badge.className = 'badge pending';
      badge.textContent = 'Pendente';
    }
    return badge;
  }

  // Monta um card por ingresso encontrado (tipo + data da inscrição
  // + badge de status) dentro de #seletorIngressos. Clicar em um
  // card fecha o modal e carrega a credencial daquele registro
  // exato — não há PIN adicional aqui, já foi validado uma vez, na
  // RPC, para TODOS os ingressos dessa pessoa.
  function renderizarSeletorDeIngressos(ingressos) {
    if (!seletorIngressos) return;
    seletorIngressos.innerHTML = '';

    // Mais antigos primeiro — ordem estável e previsível, já que a
    // RPC não garante nenhuma ordenação específica.
    const ingressosOrdenados = ingressos.slice().sort(function (a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });

    ingressosOrdenados.forEach(function (inscricao) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'cartao-participante';

      const tipo = document.createElement('span');
      tipo.className = 'cartao-participante-nome';
      tipo.textContent = NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso;

      const dataInscricao = document.createElement('span');
      dataInscricao.className = 'cartao-participante-data';
      const dataFormatada = formatarDataBr(inscricao.created_at);
      dataInscricao.textContent = dataFormatada ? 'Inscrito em ' + dataFormatada : '';

      card.appendChild(tipo);
      card.appendChild(dataInscricao);
      card.appendChild(criarBadgeStatus(inscricao.status_pagamento));

      card.addEventListener('click', function () {
        esconderModalSelecaoIngressos();
        renderizarResultado(inscricao);
      });

      seletorIngressos.appendChild(card);
    });

    mostrarModalSelecaoIngressos();
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
      // erradas.
      resetarTentativas();

      if (data.length === 1) {
        // Um só ingresso: vai direto para a credencial, sem
        // nenhuma etapa de seleção no meio.
        renderizarResultado(data[0]);
      } else {
        // Mais de um ingresso para essa mesma pessoa (ex.: comprou
        // Sexta e Sábado separadamente) — mostra um card por
        // ingresso para ela escolher qual quer ver.
        renderizarSeletorDeIngressos(data);
      }
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

  /* ============================================================
     6) TRANSFERÊNCIA DE INGRESSO (modal multi-etapas)
     ------------------------------------------------------------
     Fluxo: 1) identifica o titular atual (nome+e-mail+PIN, mesma
     RPC buscar_credencial_individual da busca normal) e escolhe o
     ingresso, se houver mais de um aprovado; 2) envia e confere um
     código de verificação por e-mail; 3) coleta os dados do novo
     titular; 4) confirma.

     ATENÇÃO — SUPOSIÇÕES A CONFIRMAR:
     - gerar_codigo_transferencia(p_email) foi usada exatamente como
       especificado.
     - transferir_ingresso(...) não teve a assinatura completa
       informada (só "..."). Assumi os parâmetros abaixo
       (p_codigo_ingresso, p_email_atual, p_codigo_verificacao,
       p_novo_nome, p_novo_email, p_novo_telefone, p_novo_pin). Se a
       função real usar outros nomes, é só ajustar o objeto passado
       para .rpc(...) nesta seção — o resto do fluxo não muda.
     - Não existe (que eu saiba) uma RPC dedicada só para VALIDAR o
       código OTP isoladamente. A Etapa 2 só confere localmente que
       são 6 dígitos e guarda o valor; a validação de verdade
       acontece dentro de transferir_ingresso, na Etapa 3 — se o
       código estiver errado, o erro da RPC aparece ali.
     ============================================================ */

  const btnAbrirTransferencia = document.getElementById('btnAbrirTransferencia');
  const modalTransferencia = document.getElementById('modalTransferencia');
  const btnFecharModalTransferencia = document.getElementById('btnFecharModalTransferencia');

  const transferenciaEtapas = [
    document.getElementById('transferenciaEtapa1'),
    document.getElementById('transferenciaEtapa2'),
    document.getElementById('transferenciaEtapa3'),
    document.getElementById('transferenciaEtapa4'),
  ];

  // Etapa 1
  const transfNome = document.getElementById('transfNome');
  const transfEmail = document.getElementById('transfEmail');
  const transfPin = document.getElementById('transfPin');
  const transferenciaSeletorIngressos = document.getElementById('transferenciaSeletorIngressos');
  const btnEnviarCodigoTransferencia = document.getElementById('btnEnviarCodigoTransferencia');
  const erroTransferenciaEtapa1 = document.getElementById('erroTransferenciaEtapa1');

  // Etapa 2
  const transferenciaEmailDestino = document.getElementById('transferenciaEmailDestino');
  const transfCodigoOtp = document.getElementById('transfCodigoOtp');
  const btnValidarCodigoTransferencia = document.getElementById('btnValidarCodigoTransferencia');
  const erroTransferenciaEtapa2 = document.getElementById('erroTransferenciaEtapa2');
  const btnVoltarEtapa1Transferencia = document.getElementById('btnVoltarEtapa1Transferencia');

  // Etapa 3
  const transfNovoNome = document.getElementById('transfNovoNome');
  const transfNovoEmail = document.getElementById('transfNovoEmail');
  const transfNovoTelefone = document.getElementById('transfNovoTelefone');
  const transfNovoPin = document.getElementById('transfNovoPin');
  const btnConfirmarTransferencia = document.getElementById('btnConfirmarTransferencia');
  const erroTransferenciaEtapa3 = document.getElementById('erroTransferenciaEtapa3');

  // Etapa 4
  const transferenciaMensagemSucesso = document.getElementById('transferenciaMensagemSucesso');
  const btnConcluirTransferencia = document.getElementById('btnConcluirTransferencia');

  // Estado da transferência em andamento — some quando o modal fecha
  // ou termina, para nunca "vazar" para uma próxima tentativa.
  let ingressoParaTransferir = null;
  let codigoVerificacaoTransferencia = null;

  // Máscara de telefone (mesmo formato usado no formulário de
  // inscrição): (00) 0000-0000 para fixo, (00) 00000-0000 p/ celular.
  function aplicarMascaraTelefone(valorBruto) {
    const digitos = valorBruto.replace(/\D/g, '').slice(0, 11);
    if (digitos.length === 0) return '';
    if (digitos.length <= 2) return '(' + digitos;
    const ddd = digitos.slice(0, 2);
    const restante = digitos.slice(2);
    const tamanhoPrimeiroBloco = digitos.length <= 10 ? 4 : 5;
    const primeiroBloco = restante.slice(0, tamanhoPrimeiroBloco);
    const segundoBloco = restante.slice(tamanhoPrimeiroBloco);
    let resultado = '(' + ddd + ') ' + primeiroBloco;
    if (segundoBloco) resultado += '-' + segundoBloco;
    return resultado;
  }

  // Máscaras dos campos numéricos desta seção — só dígitos, cada um
  // travado no próprio tamanho.
  [
    [transfPin, 4],
    [transfCodigoOtp, 6],
    [transfNovoPin, 4],
  ].forEach(function (par) {
    const campo = par[0];
    const tamanho = par[1];
    if (!campo) return;
    campo.addEventListener('input', function (evento) {
      evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, tamanho);
    });
  });

  if (transfNovoTelefone) {
    transfNovoTelefone.addEventListener('input', function (evento) {
      evento.target.value = aplicarMascaraTelefone(evento.target.value);
    });
  }

  function mostrarEtapaTransferencia(numeroEtapa) {
    transferenciaEtapas.forEach(function (etapaEl, indice) {
      if (!etapaEl) return;
      etapaEl.style.display = indice + 1 === numeroEtapa ? 'block' : 'none';
    });
  }

  function resetarFormularioTransferencia() {
    [transfNome, transfEmail, transfPin, transfCodigoOtp, transfNovoNome, transfNovoEmail, transfNovoTelefone, transfNovoPin].forEach(
      function (campo) {
        if (campo) campo.value = '';
      }
    );
    [erroTransferenciaEtapa1, erroTransferenciaEtapa2, erroTransferenciaEtapa3].forEach(esconderErro);
    if (transferenciaSeletorIngressos) {
      transferenciaSeletorIngressos.innerHTML = '';
      transferenciaSeletorIngressos.style.display = 'none';
    }
    ingressoParaTransferir = null;
    codigoVerificacaoTransferencia = null;
    mostrarEtapaTransferencia(1);
  }

  function abrirModalTransferencia() {
    resetarFormularioTransferencia();
    if (modalTransferencia) modalTransferencia.classList.add('aberto');
  }

  function fecharModalTransferencia() {
    if (modalTransferencia) modalTransferencia.classList.remove('aberto');
  }

  if (btnAbrirTransferencia) {
    btnAbrirTransferencia.addEventListener('click', abrirModalTransferencia);
  }
  if (btnFecharModalTransferencia) {
    btnFecharModalTransferencia.addEventListener('click', fecharModalTransferencia);
  }
  if (modalTransferencia) {
    modalTransferencia.addEventListener('click', function (evento) {
      if (evento.target === modalTransferencia) fecharModalTransferencia();
    });
  }
  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && modalTransferencia && modalTransferencia.classList.contains('aberto')) {
      fecharModalTransferencia();
    }
  });

  /* ------------------------------------------------------------
     Etapa 1 → dispara o código de verificação (ou mostra os cards
     de ingresso, se houver mais de um aprovado)
     ------------------------------------------------------------ */

  // Dispara a RPC gerar_codigo_transferencia e avança para a Etapa 2.
  // Isolada em função própria porque é chamada tanto direto (quando
  // só existe 1 ingresso aprovado) quanto pelo clique num card do
  // seletor (quando existe mais de 1).
  async function enviarCodigoDeVerificacao(email) {
    esconderErro(erroTransferenciaEtapa1);
    btnEnviarCodigoTransferencia.disabled = true;
    const textoOriginalBotao = btnEnviarCodigoTransferencia.textContent;
    btnEnviarCodigoTransferencia.textContent = 'Enviando código...';

    try {
      const { error } = await window.supabaseClient.rpc('gerar_codigo_transferencia', {
        p_email: email,
      });

      if (error) {
        mostrarErro(
          erroTransferenciaEtapa1,
          obterMensagemErro(error, 'Não foi possível enviar o código de verificação. Tente novamente.')
        );
        return;
      }

      if (transferenciaEmailDestino) transferenciaEmailDestino.textContent = email;
      mostrarEtapaTransferencia(2);
    } catch (erro) {
      console.error('[buscar.js] Erro ao gerar código de transferência:', erro);
      mostrarErro(erroTransferenciaEtapa1, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnEnviarCodigoTransferencia.disabled = false;
      btnEnviarCodigoTransferencia.textContent = textoOriginalBotao;
    }
  }

  // Monta um card por ingresso APROVADO encontrado, para a pessoa
  // escolher qual transferir. Reaproveita a mesma classe visual
  // (.cartao-participante) do seletor da busca normal.
  function renderizarSeletorParaTransferencia(ingressosAprovados, email) {
    if (!transferenciaSeletorIngressos) return;
    transferenciaSeletorIngressos.innerHTML = '';

    const ingressosOrdenados = ingressosAprovados.slice().sort(function (a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });

    ingressosOrdenados.forEach(function (inscricao) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'cartao-participante';

      const tipo = document.createElement('span');
      tipo.className = 'cartao-participante-nome';
      tipo.textContent = NOMES_COMBO[inscricao.tipo_ingresso] || inscricao.tipo_ingresso;

      const dataInscricao = document.createElement('span');
      dataInscricao.className = 'cartao-participante-data';
      const dataFormatada = formatarDataBr(inscricao.created_at);
      dataInscricao.textContent = dataFormatada ? 'Inscrito em ' + dataFormatada : '';

      card.appendChild(tipo);
      card.appendChild(dataInscricao);

      card.addEventListener('click', async function () {
        ingressoParaTransferir = inscricao;
        transferenciaSeletorIngressos.style.display = 'none';
        await enviarCodigoDeVerificacao(email);
      });

      transferenciaSeletorIngressos.appendChild(card);
    });

    transferenciaSeletorIngressos.style.display = 'flex';
  }

  async function iniciarTransferencia() {
    esconderErro(erroTransferenciaEtapa1);
    if (transferenciaSeletorIngressos) {
      transferenciaSeletorIngressos.innerHTML = '';
      transferenciaSeletorIngressos.style.display = 'none';
    }

    const nome = transfNome.value.trim();
    const email = transfEmail.value.trim();
    const pin = transfPin.value.trim();

    if (!nome) {
      mostrarErro(erroTransferenciaEtapa1, 'Digite seu nome completo.');
      transfNome.focus();
      return;
    }
    if (!email) {
      mostrarErro(erroTransferenciaEtapa1, 'Digite o e-mail usado na inscrição.');
      transfEmail.focus();
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      mostrarErro(erroTransferenciaEtapa1, 'Digite o PIN de 4 números.');
      transfPin.focus();
      return;
    }

    btnEnviarCodigoTransferencia.disabled = true;
    const textoOriginalBotao = btnEnviarCodigoTransferencia.textContent;
    btnEnviarCodigoTransferencia.textContent = 'Verificando...';

    try {
      // Mesma RPC da busca normal — reaproveitada aqui só para
      // identificar a pessoa e localizar os ingressos dela.
      const { data, error } = await window.supabaseClient.rpc('buscar_credencial_individual', {
        p_nome: nome,
        p_email: email,
        p_pin: pin,
      });

      if (error) {
        mostrarErro(erroTransferenciaEtapa1, obterMensagemErro(error, 'Não foi possível verificar seus dados. Tente novamente.'));
        return;
      }

      if (!Array.isArray(data) || data.length === 0) {
        mostrarErro(erroTransferenciaEtapa1, 'Não encontramos nenhuma inscrição com esses dados.');
        return;
      }

      // REGRA DE NEGÓCIO: só ingressos com pagamento aprovado podem
      // ser transferidos — pendente/recusado ficam de fora da lista.
      const aprovados = data.filter(function (inscricao) {
        return inscricao.status_pagamento === 'aprovado';
      });

      if (aprovados.length === 0) {
        mostrarErro(erroTransferenciaEtapa1, 'Apenas ingressos com pagamento APROVADO podem ser transferidos.');
        return;
      }

      if (aprovados.length === 1) {
        ingressoParaTransferir = aprovados[0];
        await enviarCodigoDeVerificacao(email);
      } else {
        renderizarSeletorParaTransferencia(aprovados, email);
      }
    } catch (erro) {
      console.error('[buscar.js] Erro ao iniciar transferência:', erro);
      mostrarErro(erroTransferenciaEtapa1, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnEnviarCodigoTransferencia.disabled = false;
      btnEnviarCodigoTransferencia.textContent = textoOriginalBotao;
    }
  }

  if (btnEnviarCodigoTransferencia) {
    btnEnviarCodigoTransferencia.addEventListener('click', iniciarTransferencia);
  }

  /* ------------------------------------------------------------
     Etapa 2 → confere o formato do código (a validação de verdade
     acontece dentro de transferir_ingresso, na Etapa 3)
     ------------------------------------------------------------ */

  function validarCodigoEtapa2() {
    esconderErro(erroTransferenciaEtapa2);
    const codigo = transfCodigoOtp.value.trim();

    if (!/^\d{6}$/.test(codigo)) {
      mostrarErro(erroTransferenciaEtapa2, 'Digite o código de 6 dígitos recebido por e-mail.');
      transfCodigoOtp.focus();
      return;
    }

    codigoVerificacaoTransferencia = codigo;
    mostrarEtapaTransferencia(3);
  }

  if (btnValidarCodigoTransferencia) {
    btnValidarCodigoTransferencia.addEventListener('click', validarCodigoEtapa2);
  }
  if (btnVoltarEtapa1Transferencia) {
    btnVoltarEtapa1Transferencia.addEventListener('click', function () {
      esconderErro(erroTransferenciaEtapa2);
      mostrarEtapaTransferencia(1);
    });
  }

  /* ------------------------------------------------------------
     Etapa 3 → dados do novo titular + confirmação final
     ------------------------------------------------------------ */

  async function confirmarTransferencia() {
    esconderErro(erroTransferenciaEtapa3);

    const novoNome = transfNovoNome.value.trim();
    const novoEmail = transfNovoEmail.value.trim();
    const novoTelefone = transfNovoTelefone.value.trim();
    const novoPin = transfNovoPin.value.trim();

    if (!novoNome || novoNome.indexOf(' ') === -1) {
      mostrarErro(erroTransferenciaEtapa3, 'Informe o nome completo do novo titular.');
      transfNovoNome.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novoEmail)) {
      mostrarErro(erroTransferenciaEtapa3, 'Informe um e-mail válido para o novo titular.');
      transfNovoEmail.focus();
      return;
    }
    if (novoTelefone.replace(/\D/g, '').length < 10) {
      mostrarErro(erroTransferenciaEtapa3, 'Informe um telefone válido, com DDD.');
      transfNovoTelefone.focus();
      return;
    }
    if (!/^\d{4}$/.test(novoPin)) {
      mostrarErro(erroTransferenciaEtapa3, 'Crie um PIN de 4 dígitos para o novo titular.');
      transfNovoPin.focus();
      return;
    }
    if (!ingressoParaTransferir || !codigoVerificacaoTransferencia) {
      mostrarErro(erroTransferenciaEtapa3, 'Não identificamos a solicitação. Feche o modal e tente novamente desde o início.');
      return;
    }

    btnConfirmarTransferencia.disabled = true;
    const textoOriginalBotao = btnConfirmarTransferencia.textContent;
    btnConfirmarTransferencia.textContent = 'Transferindo...';

    try {
      const { error } = await window.supabaseClient.rpc('transferir_ingresso', {
        p_codigo_ingresso: ingressoParaTransferir.codigo_ingresso,
        p_email_atual: transfEmail.value.trim(),
        p_codigo_verificacao: codigoVerificacaoTransferencia,
        p_novo_nome: novoNome,
        p_novo_email: novoEmail,
        p_novo_telefone: novoTelefone,
        p_novo_pin: novoPin,
      });

      if (error) {
        // Um código errado provavelmente cai aqui — a mensagem crua
        // do Postgres/RPC aparece para a pessoa corrigir e tentar de
        // novo (ela pode voltar à Etapa 2 pelo próprio botão, se
        // perceber que digitou o código errado).
        mostrarErro(
          erroTransferenciaEtapa3,
          obterMensagemErro(error, 'Não foi possível concluir a transferência. Confira os dados e tente novamente.')
        );
        return;
      }

      if (transferenciaMensagemSucesso) {
        transferenciaMensagemSucesso.textContent =
          'Transferência concluída com sucesso! O ingresso agora está no nome de ' +
          novoNome +
          '. A nova credencial já pode ser consultada por ele(a).';
      }
      mostrarEtapaTransferencia(4);
    } catch (erro) {
      console.error('[buscar.js] Erro ao confirmar transferência:', erro);
      mostrarErro(erroTransferenciaEtapa3, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnConfirmarTransferencia.disabled = false;
      btnConfirmarTransferencia.textContent = textoOriginalBotao;
    }
  }

  if (btnConfirmarTransferencia) {
    btnConfirmarTransferencia.addEventListener('click', confirmarTransferencia);
  }

  /* ------------------------------------------------------------
     Etapa 4 → concluir: fecha o modal e limpa um resultado antigo
     que porventura já estivesse na tela (pertence ao titular
     anterior, não faz mais sentido continuar exibido).
     ------------------------------------------------------------ */

  if (btnConcluirTransferencia) {
    btnConcluirTransferencia.addEventListener('click', function () {
      fecharModalTransferencia();
      esconderTodosOsResultados();
    });
  }
});
