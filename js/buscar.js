/* ============================================================
   js/buscar.js  (v=2.0.0)
   ------------------------------------------------------------
   Lógica da página BUSCAR CREDENCIAL (buscar.html):
     1) Consulta na tabela "inscricoes" do Supabase por E-MAIL +
        PIN de segurança (4 dígitos) — não por código/CPF;
     2) Trava anti-brute-force client-side: 5 tentativas erradas
        seguidas bloqueiam o formulário temporariamente
        (armazenado em localStorage, sobrevive a reload de página);
     3) Suporte a mais de uma inscrição com o mesmo e-mail + PIN
        (ex.: família cadastrada junto) via #seletorCredenciais;
     4) Estado do resultado igual ao antigo fluxo de consulta:
        pendente / recusado / aprovado (credencial + QR) / não
        encontrado;
     5) Download da credencial aprovada como PNG (via html2canvas),
        capturando só o #credencialContainer.

   IDs usados (conferidos com o buscar.html real):
     Formulário:      #campoBuscaEmail, #campoBuscaPin,
                       #btnBuscarCredencial, #erroBuscaCredencial
     Bloqueio:         #bloqueioAviso, #bloqueioAvisoTexto
     Seletor (família): #seletorCredenciais
     Resultado:        #resultadoConsulta, #resultadoPendente
                        (+ #pendenteNome, #pendenteCombo, #pendenteCodigo),
                        #resultadoRecusado (+ #recusadoNome, #recusadoCodigo),
                        #resultadoNaoEncontrado, #resultadoAprovado
     Credencial:       #credencialContainer, #credencialNome,
                        #credencialTipo, #credencialCodigo,
                        #credencialQrcodeBox
     Download:         #btnBaixarCredencial

   Depende de (carregados ANTES deste arquivo):
     - js/supabase-client.js (expõe window.supabaseClient);
     - biblioteca QRCode.js (window.QRCode);
     - biblioteca html2canvas (window.html2canvas).

   IMPORTANTE sobre a trava anti-brute-force: ela roda inteiramente
   no navegador (localStorage), então é uma camada de UX/dissuasão,
   não uma proteção de segurança real — qualquer pessoa pode limpar
   o localStorage (ou usar aba anônima) para resetar as tentativas.
   Proteção de verdade contra força bruta (rate limiting por IP,
   bloqueio no servidor, etc.) precisa ser feita no back-end/Supabase
   (ex.: uma Edge Function, ou um contador no banco por trás de RLS).
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ----------------------------------------------------------
     0) ELEMENTOS DA PÁGINA
     ---------------------------------------------------------- */

  const campoBuscaEmail = document.getElementById('campoBuscaEmail');
  const campoBuscaPin = document.getElementById('campoBuscaPin');
  const btnBuscarCredencial = document.getElementById('btnBuscarCredencial');
  const erroBuscaCredencial = document.getElementById('erroBuscaCredencial');

  const bloqueioAviso = document.getElementById('bloqueioAviso');
  const bloqueioAvisoTexto = document.getElementById('bloqueioAvisoTexto');

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
  const credencialCodigo = document.getElementById('credencialCodigo');
  const credencialQrcodeBox = document.getElementById('credencialQrcodeBox');

  const btnBaixarCredencial = document.getElementById('btnBaixarCredencial');

  const NOMES_COMBO = {
    SEXTA: 'Sexta-feira (30/10)',
    SABADO: 'Sábado (31/10)',
    COMBO: 'Sexta + Sábado',
  };

  // Guarda a credencial em exibição no momento — usado só para
  // nomear o arquivo do PNG baixado (ex.: "credencial-FC2026-AB12CD.png").
  let credencialAtual = null;

  function mostrarErro(mensagem) {
    if (!erroBuscaCredencial) return;
    erroBuscaCredencial.textContent = mensagem;
    erroBuscaCredencial.style.display = 'block';
  }

  function esconderErro() {
    if (!erroBuscaCredencial) return;
    erroBuscaCredencial.style.display = 'none';
    erroBuscaCredencial.textContent = '';
  }

  /* ----------------------------------------------------------
     1) MÁSCARA DO CAMPO PIN (4 dígitos numéricos)
     ---------------------------------------------------------- */

  // O HTML já traz maxlength="4"/inputmode="numeric"/pattern — isto
  // aqui é só o reforço em tempo real: descarta qualquer caractere
  // que não seja dígito assim que a pessoa digita.
  if (campoBuscaPin) {
    campoBuscaPin.addEventListener('input', function (evento) {
      evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, 4);
    });
  }

  /* ----------------------------------------------------------
     2) TRAVA ANTI-BRUTE-FORCE (localStorage)
     ---------------------------------------------------------- */

  const CHAVE_ARMAZENAMENTO = 'fc2026_busca_credencial_tentativas';
  const MAX_TENTATIVAS = 5;
  const DURACAO_BLOQUEIO_MS = 15 * 60 * 1000; // 15 minutos — ajuste livre

  // Lê o estado salvo ({ tentativas, bloqueadoAte }). Nunca lança
  // erro: se o localStorage estiver indisponível ou corrompido,
  // volta ao estado "zerado" em vez de quebrar a página.
  function lerEstadoTentativas() {
    try {
      const bruto = localStorage.getItem(CHAVE_ARMAZENAMENTO);
      if (!bruto) return { tentativas: 0, bloqueadoAte: null };
      const estado = JSON.parse(bruto);
      return {
        tentativas: Number(estado.tentativas) || 0,
        bloqueadoAte: estado.bloqueadoAte ? Number(estado.bloqueadoAte) : null,
      };
    } catch (erro) {
      return { tentativas: 0, bloqueadoAte: null };
    }
  }

  function salvarEstadoTentativas(estado) {
    try {
      localStorage.setItem(CHAVE_ARMAZENAMENTO, JSON.stringify(estado));
    } catch (erro) {
      // localStorage indisponível (aba anônima muito restrita, cota
      // cheia, etc.) — a trava simplesmente não persiste entre
      // reloads nesse caso, mas a página continua funcionando.
    }
  }

  // Verifica se HÁ bloqueio ativo agora. Se o bloqueio salvo já
  // expirou, aproveita para zerar o contador (começa do zero de
  // novo). Devolve o timestamp (ms) em que o bloqueio termina, ou
  // null se não há bloqueio ativo.
  function obterBloqueioAtivo() {
    const estado = lerEstadoTentativas();
    if (estado.bloqueadoAte && Date.now() < estado.bloqueadoAte) {
      return estado.bloqueadoAte;
    }
    if (estado.bloqueadoAte && Date.now() >= estado.bloqueadoAte) {
      salvarEstadoTentativas({ tentativas: 0, bloqueadoAte: null });
    }
    return null;
  }

  // Soma mais uma tentativa errada (chamado só quando e-mail+PIN não
  // batem com NENHUMA inscrição). Ao atingir o máximo, já grava o
  // horário em que o bloqueio se encerra.
  function registrarTentativaErrada() {
    const estado = lerEstadoTentativas();
    const novoTotal = estado.tentativas + 1;
    const novoEstado = { tentativas: novoTotal, bloqueadoAte: null };

    if (novoTotal >= MAX_TENTATIVAS) {
      novoEstado.bloqueadoAte = Date.now() + DURACAO_BLOQUEIO_MS;
    }

    salvarEstadoTentativas(novoEstado);
    return novoEstado;
  }

  function resetarTentativas() {
    salvarEstadoTentativas({ tentativas: 0, bloqueadoAte: null });
  }

  function minutosRestantes(bloqueadoAte) {
    const ms = bloqueadoAte - Date.now();
    return Math.max(1, Math.ceil(ms / 60000));
  }

  function definirCamposDesabilitados(desabilitado) {
    if (campoBuscaEmail) campoBuscaEmail.disabled = desabilitado;
    if (campoBuscaPin) campoBuscaPin.disabled = desabilitado;
    if (btnBuscarCredencial) btnBuscarCredencial.disabled = desabilitado;
  }

  // Aplica (ou remove) o bloqueio visual usando o bloco dedicado
  // #bloqueioAviso/#bloqueioAvisoTexto (não o #erroBuscaCredencial,
  // que fica só para erros de validação/"não encontrado"). Agenda
  // uma checagem periódica para reabilitar tudo sozinho assim que o
  // bloqueio expirar, sem precisar recarregar a página.
  let intervaloChecagemBloqueio = null;

  function aplicarEstadoBloqueio() {
    const bloqueadoAte = obterBloqueioAtivo();

    if (!bloqueadoAte) {
      if (bloqueioAviso) bloqueioAviso.style.display = 'none';
      definirCamposDesabilitados(false);
      if (intervaloChecagemBloqueio) {
        clearInterval(intervaloChecagemBloqueio);
        intervaloChecagemBloqueio = null;
      }
      return false;
    }

    esconderErro();
    const minutos = minutosRestantes(bloqueadoAte);
    if (bloqueioAvisoTexto) {
      bloqueioAvisoTexto.textContent =
        ' Tente novamente em cerca de ' + minutos + ' minuto' + (minutos > 1 ? 's' : '') + '.';
    }
    if (bloqueioAviso) bloqueioAviso.style.display = 'block';
    definirCamposDesabilitados(true);

    if (!intervaloChecagemBloqueio) {
      intervaloChecagemBloqueio = setInterval(function () {
        if (!obterBloqueioAtivo()) {
          aplicarEstadoBloqueio(); // cai no ramo "sem bloqueio" e já limpa o intervalo
        }
      }, 15000);
    }

    return true;
  }

  /* ----------------------------------------------------------
     3) VALIDAÇÃO DOS CAMPOS
     ---------------------------------------------------------- */

  function normalizarEmail(valor) {
    return (valor || '').trim().toLowerCase();
  }

  function normalizarPin(valor) {
    return (valor || '').replace(/\D/g, '').slice(0, 4);
  }

  function validarCamposBusca(email, pin) {
    const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValido) {
      mostrarErro('Informe o e-mail usado na inscrição.');
      if (campoBuscaEmail) campoBuscaEmail.focus();
      return false;
    }

    if (!/^\d{4}$/.test(pin)) {
      mostrarErro('Informe o PIN de segurança de 4 dígitos.');
      if (campoBuscaPin) campoBuscaPin.focus();
      return false;
    }

    return true;
  }

  /* ----------------------------------------------------------
     4) ESTADOS DO RESULTADO (pendente / recusado / aprovado / não
        encontrado) — mesmo princípio da consulta antiga, só que
        chaveada por e-mail + PIN em vez de e-mail/código.
     ---------------------------------------------------------- */

  function esconderTodosOsResultados() {
    [resultadoPendente, resultadoRecusado, resultadoAprovado, resultadoNaoEncontrado].forEach(function (cartao) {
      if (cartao) cartao.style.display = 'none';
    });
    if (resultadoConsulta) resultadoConsulta.style.display = 'none';
    credencialAtual = null;
  }

  function mostrarEstadoConsulta(idEstado) {
    [resultadoPendente, resultadoRecusado, resultadoAprovado, resultadoNaoEncontrado].forEach(function (cartao) {
      if (cartao) cartao.style.display = 'none';
    });
    if (idEstado) idEstado.style.display = 'block';
    if (resultadoConsulta) resultadoConsulta.style.display = 'block';
  }

  // O QR Code carrega SÓ o código da inscrição (texto puro, sem URL
  // nem prefixo) — de propósito: é o mesmo formato que o leitor da
  // Portaria (js/admin.js) já espera ao decodificar um QR no
  // check-in. Mudar esse formato aqui quebraria a leitura na entrada
  // do evento.
  function gerarQrCredencial(codigoIngresso) {
    if (!credencialQrcodeBox || typeof QRCode === 'undefined') return;
    credencialQrcodeBox.innerHTML = '';
    new QRCode(credencialQrcodeBox, {
      text: codigoIngresso,
      width: 180,
      height: 180,
      colorDark: '#0f281e',
      colorLight: '#f5f0eb',
    });
  }

  // Renderiza o card correto (pendente/recusado/aprovado) para UMA
  // inscrição já encontrada. Usada tanto para o caso "achou uma só"
  // quanto para cada opção escolhida no seletor de família.
  function renderizarResultadoPorStatus(dados) {
    const primeiroNome = (dados.nome_completo || '').split(' ')[0];
    const nomeComboExibicao = NOMES_COMBO[dados.tipo_ingresso] || dados.tipo_ingresso;

    if (dados.status_pagamento === 'aprovado') {
      credencialAtual = dados;
      if (credencialNome) credencialNome.textContent = dados.nome_completo || '';
      if (credencialTipo) credencialTipo.textContent = nomeComboExibicao;
      if (credencialCodigo) credencialCodigo.textContent = dados.codigo_ingresso || '';
      gerarQrCredencial(dados.codigo_ingresso);
      mostrarEstadoConsulta(resultadoAprovado);
    } else if (dados.status_pagamento === 'recusado') {
      if (recusadoNome) recusadoNome.textContent = primeiroNome;
      if (recusadoCodigo) recusadoCodigo.textContent = dados.codigo_ingresso;
      mostrarEstadoConsulta(resultadoRecusado);
    } else {
      // Qualquer outro valor (na prática, "pendente") cai aqui.
      if (pendenteNome) pendenteNome.textContent = primeiroNome;
      if (pendenteCombo) pendenteCombo.textContent = nomeComboExibicao;
      if (pendenteCodigo) pendenteCodigo.textContent = dados.codigo_ingresso;
      mostrarEstadoConsulta(resultadoPendente);
    }
  }

  /* ----------------------------------------------------------
     5) SELETOR DE CREDENCIAIS (mesmo e-mail + PIN, mais de uma
        inscrição — ex.: família cadastrada junto)
     ---------------------------------------------------------- */

  function renderizarSeletor(lista, indiceAtivo) {
    if (!seletorCredenciais) return;

    seletorCredenciais.innerHTML = '';

    if (!lista || lista.length <= 1) {
      seletorCredenciais.style.display = 'none';
      return;
    }

    lista.forEach(function (item, indice) {
      const chip = document.createElement('button');
      chip.type = 'button';
      const ativo = indice === indiceAtivo;
      // Estilo inline simples (sem depender de classes novas no
      // styles.css): pílula verde preenchida quando ativa, contorno
      // verde quando não.
      chip.style.cssText =
        'padding:8px 16px; border-radius:999px; cursor:pointer; ' +
        'font-family:Poppins,sans-serif; font-weight:600; font-size:12.5px; ' +
        'border:1.5px solid var(--verde); transition:background .15s ease, color .15s ease; ' +
        (ativo
          ? 'background:var(--verde); color:#fff;'
          : 'background:transparent; color:var(--verde);');
      chip.textContent = (item.nome_completo || 'Inscrição ' + (indice + 1)).split(' ')[0];

      chip.addEventListener('click', function () {
        renderizarSeletor(lista, indice);
        renderizarResultadoPorStatus(item);
      });

      seletorCredenciais.appendChild(chip);
    });

    seletorCredenciais.style.display = 'flex';
  }

  /* ----------------------------------------------------------
     6) AÇÃO PRINCIPAL: buscar credencial
     ---------------------------------------------------------- */

  async function buscarCredencial() {
    esconderErro();
    esconderTodosOsResultados();
    if (seletorCredenciais) {
      seletorCredenciais.innerHTML = '';
      seletorCredenciais.style.display = 'none';
    }

    // Bloqueado por tentativas erradas anteriores: nem chega a
    // consultar o Supabase.
    if (aplicarEstadoBloqueio()) return;

    const email = normalizarEmail(campoBuscaEmail ? campoBuscaEmail.value : '');
    const pin = normalizarPin(campoBuscaPin ? campoBuscaPin.value : '');

    if (!validarCamposBusca(email, pin)) return;

    if (!window.supabaseClient) {
      mostrarErro('Não foi possível conectar ao servidor. Tente novamente em instantes.');
      return;
    }

    btnBuscarCredencial.disabled = true;
    const textoOriginalBotao = btnBuscarCredencial.textContent;
    btnBuscarCredencial.textContent = 'Buscando...';

    try {
      // Sem .maybeSingle(): pode haver mais de uma inscrição com o
      // mesmo e-mail + PIN (família cadastrada junto), então
      // buscamos TODAS e decidimos o que fazer com a lista abaixo.
      const { data, error } = await window.supabaseClient
        .from('inscricoes')
        .select('*')
        .eq('email', email)
        .eq('pin_seguranca', pin)
        .order('created_at', { ascending: true });

      if (error) {
        mostrarErro('Não foi possível concluir a busca. Tente novamente em instantes.');
        return;
      }

      if (!data || data.length === 0) {
        const estadoAtualizado = registrarTentativaErrada();
        const restantes = Math.max(0, MAX_TENTATIVAS - estadoAtualizado.tentativas);

        mostrarEstadoConsulta(resultadoNaoEncontrado);

        if (estadoAtualizado.bloqueadoAte) {
          aplicarEstadoBloqueio(); // substitui a mensagem pela de bloqueio
        } else {
          mostrarErro(
            'E-mail ou PIN incorretos. Restam ' + restantes + (restantes === 1 ? ' tentativa.' : ' tentativas.')
          );
        }
        return;
      }

      // Encontrou pelo menos uma inscrição válida: e-mail + PIN
      // corretos, então zera o contador de tentativas erradas —
      // mesmo que o status de pagamento ainda esteja pendente.
      resetarTentativas();

      renderizarSeletor(data, 0);
      renderizarResultadoPorStatus(data[0]);
    } catch (erro) {
      console.error('[buscar.js] Erro ao buscar credencial:', erro);
      mostrarErro('Ocorreu um erro inesperado. Tente novamente.');
    } finally {
      // Só reabilita o botão se a busca não tiver acabado de
      // resultar em bloqueio (aplicarEstadoBloqueio já cuida de
      // desabilitar tudo nesse caso).
      if (!obterBloqueioAtivo()) {
        btnBuscarCredencial.disabled = false;
      }
      btnBuscarCredencial.textContent = textoOriginalBotao;
    }
  }

  if (btnBuscarCredencial) {
    btnBuscarCredencial.addEventListener('click', buscarCredencial);
  }

  [campoBuscaEmail, campoBuscaPin].forEach(function (campo) {
    if (!campo) return;
    campo.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') buscarCredencial();
    });
  });

  /* ----------------------------------------------------------
     7) DOWNLOAD DA CREDENCIAL EM PNG (html2canvas)
     ---------------------------------------------------------- */

  if (btnBaixarCredencial) {
    btnBaixarCredencial.addEventListener('click', async function () {
      if (!credencialContainer) return;

      if (typeof html2canvas === 'undefined') {
        mostrarErro('Não foi possível gerar a imagem da credencial (biblioteca não carregada).');
        return;
      }

      const textoOriginalBotao = btnBaixarCredencial.textContent;
      btnBaixarCredencial.disabled = true;
      btnBaixarCredencial.textContent = 'Gerando imagem...';

      try {
        // scale:3 força uma captura em resolução mais alta que a
        // tela (equivalente a ~3x a densidade normal de pixels),
        // para o PNG final sair nítido mesmo ampliado/impresso.
        const canvas = await html2canvas(credencialContainer, {
          scale: 3,
          backgroundColor: '#0f281e',
          useCORS: true,
        });

        const codigo = credencialAtual && credencialAtual.codigo_ingresso ? credencialAtual.codigo_ingresso : 'credencial';
        const link = document.createElement('a');
        link.download = 'credencial-freedom-conf-2026-' + codigo + '.png';
        link.href = canvas.toDataURL('image/png', 1.0);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (erro) {
        console.error('[buscar.js] Erro ao gerar PNG da credencial:', erro);
        mostrarErro('Não foi possível baixar a credencial. Tente novamente.');
      } finally {
        btnBaixarCredencial.disabled = false;
        btnBaixarCredencial.textContent = textoOriginalBotao;
      }
    });
  }

  /* ----------------------------------------------------------
     8) ESTADO INICIAL AO CARREGAR A PÁGINA
     ---------------------------------------------------------- */

  esconderTodosOsResultados();
  aplicarEstadoBloqueio();
});