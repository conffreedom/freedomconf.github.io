/* ============================================================
   js/buscar.js
   ------------------------------------------------------------
   Lógica do PORTAL DO PARTICIPANTE / CREDENCIAL (buscar.html):
     1) Busca híbrida por e-mail OU código da inscrição;
     2) Modal de seleção de participantes (cards bege, com nome e
        data da inscrição), quando a busca retorna uma ou mais
        inscrições associadas;
     3) Modal de PIN individual — pedido por participante, nunca no
        formulário inicial de busca. O PIN correto é conferido
        direto no filtro da consulta ao Supabase (o valor certo
        nunca é buscado em lote nem trafega para o navegador antes
        de bater);
     4) Renderização dos 3 estados (pendente / recusado / aprovado)
        e da credencial com QR code estilizado;
     5) Proteção anti-força-bruta via localStorage: bloqueio
        temporário após 5 tentativas de PIN incorretas;
     6) Download da credencial em PNG via html2canvas.

   Ambos os modais (seleção de participante e PIN) são abertos e
   fechados adicionando/removendo a classe ".aberto" — nenhuma
   lógica de visibilidade depende de seletores CSS ":has()" nem de
   estilo inline no overlay.

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

  const campoBusca = document.getElementById('campoBusca');
  const btnBuscarCredencial = document.getElementById('btnBuscarCredencial');
  const erroBuscaCredencial = document.getElementById('erroBuscaCredencial');

  const bloqueioAviso = document.getElementById('bloqueioAviso');
  const bloqueioAvisoTexto = document.getElementById('bloqueioAvisoTexto');

  const modalSelecaoParticipantes = document.getElementById('modalSelecaoParticipantes');
  const btnFecharModalSelecao = modalSelecaoParticipantes
    ? modalSelecaoParticipantes.querySelector('.modal-fechar')
    : null;
  const seletorCredenciais = document.getElementById('seletorCredenciais');

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

  const modalPin = document.getElementById('modalPin');
  const modalPinNome = document.getElementById('modalPinNome');
  const modalPinInput = document.getElementById('modalPinInput');
  const btnConfirmarPin = document.getElementById('btnConfirmarPin');
  const btnFecharModalPin = document.getElementById('btnFecharModalPin');
  const erroModalPin = document.getElementById('erroModalPin');

  // Guarda o participante escolhido no seletor enquanto o modal de
  // PIN está aberto — é contra o "id" dele que o PIN é conferido.
  let participanteSelecionado = null;

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

  // Cada tentativa de PIN incorreta soma 1 neste contador; ao
  // atingir o máximo, grava um horário de desbloqueio no futuro e
  // zera o contador. Tudo isolado por dispositivo/navegador, já que
  // localStorage não é compartilhado entre aparelhos.
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

  function registrarTentativaDePinErrada() {
    const tentativas = (Number(localStorage.getItem(CHAVE_TENTATIVAS)) || 0) + 1;
    if (tentativas >= MAX_TENTATIVAS_ERRADAS) {
      localStorage.setItem(CHAVE_BLOQUEIO_ATE, String(Date.now() + DURACAO_BLOQUEIO_MS));
      localStorage.setItem(CHAVE_TENTATIVAS, '0');
    } else {
      localStorage.setItem(CHAVE_TENTATIVAS, String(tentativas));
    }
  }

  // Acertar o PIN reseta o contador — só tentativas ERRADAS contam
  // para o bloqueio.
  function resetarTentativas() {
    localStorage.removeItem(CHAVE_TENTATIVAS);
    localStorage.removeItem(CHAVE_BLOQUEIO_ATE);
  }

  // Reflete o estado de bloqueio na tela: mostra/esconde o aviso e
  // desabilita os dois botões que poderiam ser usados para tentar
  // de novo (busca e confirmação do PIN).
  function atualizarUiBloqueio() {
    const bloqueado = estaBloqueado();

    if (bloqueado) {
      bloqueioAvisoTexto.textContent = ' Tente novamente em cerca de ' + minutosRestantesDeBloqueio() + ' minuto(s).';
      bloqueioAviso.style.display = 'block';
    } else {
      bloqueioAviso.style.display = 'none';
    }

    if (btnBuscarCredencial) btnBuscarCredencial.disabled = bloqueado;
    if (btnConfirmarPin) btnConfirmarPin.disabled = bloqueado;

    return bloqueado;
  }

  // Roda uma vez ao carregar a página — se a pessoa já estava
  // bloqueada de uma visita anterior (mesmo navegador), o aviso já
  // aparece na hora, sem precisar tentar buscar de novo primeiro.
  atualizarUiBloqueio();

  /* ----------------------------------------------------------
     2) MODAL DE SELEÇÃO DE PARTICIPANTES
     ---------------------------------------------------------- */

  function mostrarModalSelecao() {
    if (modalSelecaoParticipantes) modalSelecaoParticipantes.classList.add('aberto');
  }

  function esconderModalSelecao() {
    if (modalSelecaoParticipantes) modalSelecaoParticipantes.classList.remove('aberto');
  }

  if (btnFecharModalSelecao) {
    btnFecharModalSelecao.addEventListener('click', esconderModalSelecao);
  }

  if (modalSelecaoParticipantes) {
    // Clicar na área escurecida (fora dos cards bege) também fecha
    // o modal — só o clique diretamente no overlay conta.
    modalSelecaoParticipantes.addEventListener('click', function (evento) {
      if (evento.target === modalSelecaoParticipantes) esconderModalSelecao();
    });
  }

  /* ----------------------------------------------------------
     3) BUSCA HÍBRIDA (e-mail OU código da inscrição)
     ---------------------------------------------------------- */

  // Decide se o texto digitado deve ser buscado como e-mail ou como
  // código de inscrição — a regra é simples: se tem "@", é e-mail;
  // caso contrário, é código. Ambos são normalizados com
  // toLowerCase().trim(); a consulta em si usa "ilike" (comparação
  // sem diferenciar maiúsculas/minúsculas), então não importa se o
  // código foi digitado em caixa alta, baixa ou misturada.
  function detectarTipoBusca(valorDigitado) {
    const valor = valorDigitado.trim().toLowerCase();
    if (valor.includes('@')) {
      return { campo: 'email', valor: valor };
    }
    return { campo: 'codigo_ingresso', valor: valor };
  }

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

  // Monta um card bege por participante encontrado (nome em
  // destaque + data da inscrição no rodapé) dentro de
  // #seletorCredenciais, e abre o modal de seleção. Clicar em um
  // card abre o modal de PIN daquela pessoa especificamente.
  function renderizarSeletorParticipantes(participantes) {
    seletorCredenciais.innerHTML = '';

    participantes.forEach(function (pessoa) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'cartao-participante';

      const nome = document.createElement('span');
      nome.className = 'cartao-participante-nome';
      nome.textContent = pessoa.nome_completo;

      const dataInscricao = document.createElement('span');
      dataInscricao.className = 'cartao-participante-data';
      const dataFormatada = formatarDataBr(pessoa.created_at);
      dataInscricao.textContent = dataFormatada ? 'Inscrito em ' + dataFormatada : '';

      card.appendChild(nome);
      card.appendChild(dataInscricao);
      card.addEventListener('click', function () {
        abrirModalPin(pessoa);
      });

      seletorCredenciais.appendChild(card);
    });

    seletorCredenciais.style.display = 'flex';
    mostrarModalSelecao();
  }

  async function buscarParticipantes() {
    esconderErro(erroBuscaCredencial);
    esconderTodosOsResultados();
    esconderModalSelecao();
    seletorCredenciais.style.display = 'none';
    seletorCredenciais.innerHTML = '';

    if (atualizarUiBloqueio()) {
      // Já bloqueado por tentativas de PIN erradas anteriores — nem
      // tenta buscar, só reforça o aviso na tela.
      return;
    }

    const valorDigitado = campoBusca.value;
    if (!valorDigitado || !valorDigitado.trim()) {
      mostrarErro(erroBuscaCredencial, 'Digite seu e-mail ou o código da inscrição.');
      return;
    }

    const { campo, valor } = detectarTipoBusca(valorDigitado);

    btnBuscarCredencial.disabled = true;
    const textoOriginalBotao = btnBuscarCredencial.textContent;
    btnBuscarCredencial.textContent = 'Buscando...';

    try {
      // Nesta primeira consulta, só os campos necessários para
      // montar os cards são pedidos — nome, tipo de ingresso e a
      // data de criação (para o "Inscrito em DD/MM/AAAA"). O
      // "pin_seguranca" de ninguém é buscado em lote aqui; ele só
      // entra na consulta seguinte, já filtrado por um "id"
      // específico (ver validarPinDoParticipante).
      const { data, error } = await window.supabaseClient
        .from('inscricoes')
        .select('id, nome_completo, tipo_ingresso, created_at')
        .ilike(campo, valor)
        .order('nome_completo', { ascending: true });

      if (error) {
        mostrarErro(erroBuscaCredencial, obterMensagemErro(error, 'Não foi possível concluir a busca. Tente novamente.'));
        return;
      }

      if (!data || data.length === 0) {
        mostrarEstado(resultadoNaoEncontrado);
        return;
      }

      renderizarSeletorParticipantes(data);
    } catch (erro) {
      console.error('[buscar.js] Erro ao buscar participantes:', erro);
      mostrarErro(erroBuscaCredencial, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnBuscarCredencial.textContent = textoOriginalBotao;
      btnBuscarCredencial.disabled = estaBloqueado();
    }
  }

  if (btnBuscarCredencial) {
    btnBuscarCredencial.addEventListener('click', buscarParticipantes);
  }

  if (campoBusca) {
    campoBusca.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') buscarParticipantes();
    });
  }

  /* ----------------------------------------------------------
     4) MODAL DE PIN (por participante)
     ---------------------------------------------------------- */

  function abrirModalPin(pessoa) {
    participanteSelecionado = pessoa;
    modalPinNome.textContent = obterPrimeiroEUltimoNome(pessoa.nome_completo) || 'participante';
    modalPinInput.value = '';
    esconderErro(erroModalPin);
    esconderModalSelecao();
    modalPin.classList.add('aberto');
    modalPinInput.focus();
  }

  // Fecha o modal de PIN sem reabrir o de seleção — usado nos
  // caminhos "internos" (PIN validado com sucesso, ou bloqueio por
  // excesso de tentativas), onde voltar para a lista não faz sentido.
  function fecharModalPin() {
    modalPin.classList.remove('aberto');
    participanteSelecionado = null;
  }

  // Fecha o modal de PIN E reabre o de seleção — usado quando quem
  // está fechando é o PRÓPRIO usuário (botão "×", clique fora ou
  // Esc), já que nesse caso faz sentido deixá-lo escolher outra
  // pessoa sem precisar buscar de novo.
  function cancelarModalPin() {
    fecharModalPin();
    if (seletorCredenciais && seletorCredenciais.children.length > 0) {
      mostrarModalSelecao();
    }
  }

  if (btnFecharModalPin) {
    btnFecharModalPin.addEventListener('click', cancelarModalPin);
  }

  if (modalPin) {
    // Clicar na área escurecida (fora do card branco) também fecha
    // o modal — só o clique diretamente no overlay conta.
    modalPin.addEventListener('click', function (evento) {
      if (evento.target === modalPin) cancelarModalPin();
    });
  }

  // Tecla Esc fecha o modal que estiver aberto no momento — dá
  // prioridade ao de PIN, já que ele fica por cima do de seleção
  // quando os dois "existem" ao mesmo tempo.
  document.addEventListener('keydown', function (evento) {
    if (evento.key !== 'Escape') return;
    if (modalPin && modalPin.classList.contains('aberto')) {
      cancelarModalPin();
      return;
    }
    if (modalSelecaoParticipantes && modalSelecaoParticipantes.classList.contains('aberto')) {
      esconderModalSelecao();
    }
  });

  // O campo do PIN só aceita dígitos e no máximo 4 caracteres.
  if (modalPinInput) {
    modalPinInput.setAttribute('maxlength', '4');
    modalPinInput.setAttribute('inputmode', 'numeric');
    modalPinInput.addEventListener('input', function (evento) {
      evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, 4);
    });
    modalPinInput.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') validarPinDoParticipante();
    });
  }

  /* ----------------------------------------------------------
     5) VALIDAÇÃO DO PIN + RENDERIZAÇÃO DO RESULTADO
     ---------------------------------------------------------- */

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

  async function validarPinDoParticipante() {
    esconderErro(erroModalPin);

    if (atualizarUiBloqueio()) {
      fecharModalPin();
      return;
    }

    if (!participanteSelecionado) {
      fecharModalPin();
      return;
    }

    const pin = modalPinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      mostrarErro(erroModalPin, 'Digite um PIN de 4 números.');
      return;
    }

    btnConfirmarPin.disabled = true;
    const textoOriginalBotao = btnConfirmarPin.textContent;
    btnConfirmarPin.textContent = 'Verificando...';

    try {
      // A comparação do PIN acontece DIRETO no filtro da consulta —
      // o valor correto de "pin_seguranca" nunca é enviado ao
      // navegador antes de o usuário acertar; só pedimos o registro
      // completo ("select('*')") quando o par (id, pin_seguranca)
      // já bateu no próprio servidor.
      const { data, error } = await window.supabaseClient
        .from('inscricoes')
        .select('*')
        .eq('id', participanteSelecionado.id)
        .eq('pin_seguranca', pin)
        .maybeSingle();

      if (error) {
        mostrarErro(erroModalPin, obterMensagemErro(error, 'Não foi possível validar o PIN. Tente novamente.'));
        return;
      }

      if (!data) {
        registrarTentativaDePinErrada();
        if (atualizarUiBloqueio()) {
          fecharModalPin();
        } else {
          mostrarErro(erroModalPin, 'PIN incorreto. Confira e tente novamente.');
        }
        return;
      }

      // PIN correto: zera o contador de tentativas erradas, fecha o
      // modal (sem reabrir a seleção — a busca terminou com
      // sucesso) e mostra a credencial (ou o status correspondente).
      resetarTentativas();
      fecharModalPin();
      renderizarResultado(data);
    } catch (erro) {
      console.error('[buscar.js] Erro ao validar PIN:', erro);
      mostrarErro(erroModalPin, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnConfirmarPin.textContent = textoOriginalBotao;
      btnConfirmarPin.disabled = estaBloqueado();
    }
  }

  if (btnConfirmarPin) {
    btnConfirmarPin.addEventListener('click', validarPinDoParticipante);
  }

  /* ----------------------------------------------------------
     6) DOWNLOAD DA CREDENCIAL EM PNG (html2canvas)
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

        const link = document.createElement('a');
        // Pega o nome e o código da tela (ou do objeto do participante)
      const nomeElemento = document.getElementById('credencialNome')?.textContent || 'participante';
      const codigoElemento = document.getElementById('credencialCodigo')?.textContent || '';

      // Trata o nome (remove acentos, espaços viram hífens e fica em minúsculo)
      const nomeFormatado = nomeElemento
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-");

      // Define o nome único (ex: credencial-felipe-santos-fc2026-3wxz9z.png)
      const sufixoCodigo = codigoElemento ? `-${codigoElemento.toLowerCase()}` : '';
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
