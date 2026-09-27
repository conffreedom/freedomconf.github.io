/* ============================================================
   js/inscricao.js
   ------------------------------------------------------------
   Lógica do PORTAL DE INSCRIÇÃO (inscricao.html), em 3 passos
   isolados (Passo 1: dados pessoais + ingresso; Passo 2: Pix +
   comprovante; Passo 3: resumo + PIN + confirmação):
     1) Seleção de ingresso (Sexta / Sábado / Combo);
     1.1) Preços dos 3 ingressos e a chave Pix, carregados uma única
          vez ao abrir a página via a RPC obter_configuracoes_checkout
          — SEM nenhuma lógica de "lote" (não existe mais lote ativo,
          nem lote esgotado, nem Realtime de preço mudando sozinho);
     2) Máscara de telefone (Passo 1) e do PIN (Passo 3);
     3) Botão "Copiar Chave Pix" (Passo 2);
     4) Checagem de inscrição duplicada (nome + e-mail + tipo de
        ingresso) antes de avançar para o pagamento;
     5) Validação de cada passo isoladamente: dados pessoais
        (Passo 1), comprovante (Passo 2) e PIN com dupla confirmação
        (Passo 3) — e a navegação entre os 3 passos e os 2 botões
        "← Voltar";
     6) Upload do comprovante de Pix para o Supabase Storage;
     7) Criação da inscrição via RPC criar_inscricao_segura (não
        mais um INSERT direto na tabela — nem geração de código no
        cliente: o servidor cuida de tudo isso agora);
     8) Tela de sucesso com status "Aguardando Validação do Pix" e
        exibição do PIN cadastrado.

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient e
       window.SUPABASE_COMPROVANTES_BUCKET), carregado ANTES
       deste arquivo.

   ATENÇÃO — SUPOSIÇÕES A CONFIRMAR (não recebi a definição exata
   das duas RPCs, só o pedido para chamá-las):

   1) obter_configuracoes_checkout — assumi que é chamada SEM
      parâmetros e devolve (como objeto único, ou como array de 1
      item — o código trata os dois formatos) as colunas
      "preco_sexta", "preco_sabado", "preco_combo" e "chave_pix".
      Importante: assumi UMA chave Pix só para o evento inteiro (não
      mais uma por tipo de ingresso, como no antigo sistema de
      lotes) — é por isso que #chavePixTexto agora recebe um valor
      só, independente do card selecionado. Se a sua RPC ainda
      devolver uma chave por tipo, me avise que eu adapto de volta
      para o esquema "uma chave por card".

   2) criar_inscricao_segura — você especificou 5 parâmetros
      (p_nome, p_email, p_telefone, p_pin, p_tipo_ingresso). Mantive
      esses 5 exatamente como pedido, mas também incluí um 6º,
      "p_comprovante_url", com a URL que acabou de subir para o
      Storage. Sem esse parâmetro, o comprovante enviado fica sem
      NENHUM vínculo com a inscrição criada — a equipe não teria
      como conferir o pagamento no painel administrativo. Se a sua
      RPC realmente não aceita esse parâmetro (ou usa outro nome),
      é uma linha só para remover/ajustar — ver a função
      "criarInscricaoSegura" na seção 8.
      Também assumi que a RPC devolve (objeto único ou array de 1
      item) a linha criada, incluindo "codigo_ingresso" e
      "pin_seguranca" — usados na tela de sucesso.

   A contagem regressiva, o menu mobile e o scroll reveal da
   Landing Page NÃO estão mais aqui — ver js/main.js. A consulta de
   credencial (busca por nome/e-mail/PIN, QR code, download em PNG,
   transferência de ingresso) também NÃO está mais aqui — foi para
   js/buscar.js, que roda em buscar.html.

   Nenhuma troca de passo/tela neste arquivo dispara rolagem
   automática (scrollIntoView) nem depende de âncoras "#" — a
   navegação entre Passo 1 → 2 → 3 é feita só alternando
   display:block/none, sem mover o scroll do usuário.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  console.log('[inscricao.js] build: sem lógica de lotes — preços/Pix via RPC, criação via RPC segura');

  /* ----------------------------------------------------------
     1) SELEÇÃO DE INGRESSO (combos)
     ---------------------------------------------------------- */

  const NOMES_COMBO = {
    SEXTA: 'Sexta-feira (30/10)',
    SABADO: 'Sábado (31/10)',
    COMBO: 'Sexta + Sábado',
  };

  const listaCombos = document.querySelectorAll('#combos .combo');
  const totalValorEl = document.getElementById('totalValor');

  // Estado da inscrição em andamento. É atualizado conforme o
  // usuário navega pelos passos do formulário.
  const estadoInscricao = {
    tipoIngresso: 'COMBO',
    valor: 25.0,
  };

  // Aviso customizado de inscrição duplicada (Passo 1) — substitui
  // o alert() nativo do navegador. Precisa ser declarado ANTES da
  // primeira chamada de selecionarCombo() logo abaixo, porque ela
  // já chama esconderAvisoDuplicidade() internamente.
  const avisoDuplicidade = document.getElementById('avisoDuplicidade');
  const avisoDuplicidadeTexto = document.getElementById('avisoDuplicidadeTexto');
  const btnFecharAvisoDuplicidade = document.getElementById('btnFecharAvisoDuplicidade');

  function mostrarAvisoDuplicidade(mensagem) {
    if (!avisoDuplicidade) return;
    if (avisoDuplicidadeTexto) avisoDuplicidadeTexto.textContent = mensagem;
    avisoDuplicidade.style.display = 'flex';
  }

  function esconderAvisoDuplicidade() {
    if (!avisoDuplicidade) return;
    avisoDuplicidade.style.display = 'none';
  }

  if (btnFecharAvisoDuplicidade) {
    btnFecharAvisoDuplicidade.addEventListener('click', esconderAvisoDuplicidade);
  }

  // Formata um número para o padrão monetário brasileiro (R$ 0,00).
  function formatarMoeda(valor) {
    return valor.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  // Converte com segurança um valor vindo do HTML/banco para número.
  // Aceita tanto "25.00" quanto "25,50" (vírgula decimal) e devolve
  // NaN para vazio/nulo/texto inválido, para quem chama decidir o
  // que fazer. Única definição desta função no arquivo — usada tanto
  // ao aplicar os preços (1.1) quanto ao sincronizar o estado antes
  // do resumo/confirmação (seção 5).
  function lerValorNumerico(valorBruto) {
    if (valorBruto === null || valorBruto === undefined) return NaN;
    const texto = String(valorBruto).trim().replace(',', '.');
    if (texto === '') return NaN;
    const numero = Number(texto);
    return isFinite(numero) ? numero : NaN;
  }

  function selecionarCombo(comboEl) {
    listaCombos.forEach(function (c) {
      c.removeAttribute('data-selected');
    });
    comboEl.setAttribute('data-selected', 'true');

    estadoInscricao.tipoIngresso = comboEl.getAttribute('data-id');
    estadoInscricao.valor = parseFloat(comboEl.getAttribute('data-preco'));

    if (totalValorEl) {
      totalValorEl.textContent = formatarMoeda(estadoInscricao.valor);
    }

    // Trocar de ingresso pode resolver o conflito que gerou o aviso
    // de duplicidade (ele é específico por tipo) — some sozinho.
    esconderAvisoDuplicidade();
  }

  listaCombos.forEach(function (comboEl) {
    comboEl.addEventListener('click', function () {
      selecionarCombo(comboEl);
    });
  });

  // Garante que o estado inicial (JS) bate com o combo já marcado
  // como selecionado no HTML (data-selected="true").
  const comboInicial = document.querySelector('#combos .combo[data-selected="true"]') || listaCombos[0];
  if (comboInicial) {
    selecionarCombo(comboInicial);
  }

  /* ----------------------------------------------------------
     1.1) CONFIGURAÇÕES DE CHECKOUT: preços dos 3 ingressos e a
          chave Pix, via RPC obter_configuracoes_checkout
     ---------------------------------------------------------- */

  const chavePixTextoEl = document.getElementById('chavePixTexto');

  // Formata só o número, sem o "R$" (ex.: "20,00") — usado para
  // montar o preço em 2 linhas dentro do card (.preco-cifrao /
  // .preco-valor, já existentes no styles.css).
  function formatarNumeroBRL(valor) {
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Atualiza UM card: o atributo data-preco (fonte de verdade para o
  // JS) e o texto visível dentro de .preco, no formato em 2 linhas.
  function aplicarPrecoNoCard(comboEl, preco) {
    const valor = lerValorNumerico(preco);
    if (isNaN(valor)) return false;

    comboEl.setAttribute('data-preco', valor.toFixed(2));
    const precoEl = comboEl.querySelector('.preco');
    if (precoEl) {
      precoEl.innerHTML =
        '<span class="preco-cifrao">R$</span>' +
        '<span class="preco-valor">' + formatarNumeroBRL(valor) + '<small>/pessoa</small></span>';
    }
    return true;
  }

  // Cada tipo de ingresso tem sua própria coluna de preço na
  // configuração de checkout.
  const MAPA_CARDS_PRECO = {
    SEXTA: { seletor: '.combo[data-id="SEXTA"]', coluna: 'preco_sexta' },
    SABADO: { seletor: '.combo[data-id="SABADO"]', coluna: 'preco_sabado' },
    COMBO: { seletor: '.combo[data-id="COMBO"]', coluna: 'preco_combo' },
  };

  async function carregarConfiguracoesCheckout() {
    if (!window.supabaseClient) {
      console.error('[inscricao.js] carregarConfiguracoesCheckout: window.supabaseClient não existe ainda — verifique a ordem dos <script> no HTML.');
      return;
    }

    const { data, error } = await window.supabaseClient.rpc('obter_configuracoes_checkout');

    // Diagnóstico: mostra exatamente o que o Supabase devolveu, para
    // facilitar identificar RLS bloqueando a RPC, nome de coluna
    // incorreto, etc., sem precisar depurar às cegas.
    console.log('[inscricao.js] carregarConfiguracoesCheckout -> resposta do Supabase:', { data, error });

    if (error) {
      console.error('[inscricao.js] Erro ao carregar as configurações de checkout:', error.message || error);
      return;
    }

    // A RPC pode devolver um objeto único ou um array com 1 item,
    // dependendo de como foi definida no Postgres — cobrimos os
    // dois formatos.
    const config = Array.isArray(data) ? data[0] : data;
    if (!config) {
      console.warn('[inscricao.js] obter_configuracoes_checkout não devolveu nenhuma configuração — mantendo os preços estáticos do HTML.');
      return;
    }

    Object.keys(MAPA_CARDS_PRECO).forEach(function (idCombo) {
      const { seletor, coluna } = MAPA_CARDS_PRECO[idCombo];
      const comboEl = document.querySelector(seletor);

      if (!comboEl) {
        console.error('[inscricao.js] Card não encontrado no DOM para o seletor:', seletor);
        return;
      }

      const precoAplicado = aplicarPrecoNoCard(comboEl, config[coluna]);
      if (!precoAplicado) {
        console.error(
          '[inscricao.js] Coluna "' + coluna + '" veio inválida/ausente para o card ' + idCombo + ':',
          JSON.stringify(config[coluna])
        );
      }
    });

    if (chavePixTextoEl && config.chave_pix) {
      chavePixTextoEl.textContent = config.chave_pix;
    } else if (!config.chave_pix) {
      console.warn('[inscricao.js] "chave_pix" veio vazia/nula nas configurações de checkout — mantendo a chave estática do HTML.');
    }

    // Re-seleciona o card já marcado para o #totalValor refletir o
    // preço novo imediatamente (a seleção inicial rodou antes desta
    // consulta terminar).
    const comboSelecionado = document.querySelector('#combos .combo[data-selected="true"]') || comboInicial;
    if (comboSelecionado) {
      selecionarCombo(comboSelecionado);
    }

    // Se a pessoa já estiver no Passo 3 (resumo) quando isso chegar,
    // mantém o resumo em sincronia com o preço mais recente.
    if (typeof telaResumo !== 'undefined' && telaResumo && telaResumo.style.display === 'block') {
      preencherResumoComEstadoAtual();
    }
  }

  carregarConfiguracoesCheckout();

  /* ----------------------------------------------------------
     2) ELEMENTOS DOS 3 PASSOS DO FORMULÁRIO
     ---------------------------------------------------------- */

  const telaForm = document.getElementById('formInscricao');
  const telaPagamentoPix = document.getElementById('pagamentoPix');
  const telaResumo = document.getElementById('resumoPedido');
  const telaSucesso = document.getElementById('telaSucesso');

  const campoNome = document.getElementById('campoNome');
  const campoEmail = document.getElementById('campoEmail');
  const campoTelefone = document.getElementById('campoTelefone');
  const campoComprovante = document.getElementById('campoComprovante');

  // Campos do PIN de segurança de 4 dígitos, preenchidos no Passo 3
  // (confirmação) junto com a confirmação da inscrição.
  const campoPin = document.getElementById('campoPin');
  const campoPinConfirma = document.getElementById('campoPinConfirma');

  const erroInscricao = document.getElementById('erroInscricao');
  const erroComprovante = document.getElementById('erroComprovante');
  const erroResumo = document.getElementById('erroResumo');

  const btnIrPagamento = document.getElementById('btnIrPagamento');
  const btnVoltarPagamento = document.getElementById('btnVoltarPagamento');
  const btnIrConfirmacao = document.getElementById('btnIrConfirmacao');
  const btnVoltarResumo = document.getElementById('btnVoltarResumo');
  const btnConfirmarInscricao = document.getElementById('btnConfirmarInscricao');
  const btnNovaInscricao = document.getElementById('btnNovaInscricao');

  const resumoNomeTxt = document.getElementById('resumoNomeTxt');
  const resumoComboTxt = document.getElementById('resumoComboTxt');
  const resumoComprovanteTxt = document.getElementById('resumoComprovanteTxt');
  const resumoValorTxt = document.getElementById('resumoValorTxt');

  const nomeSucesso = document.getElementById('nomeSucesso');
  const comboSucesso = document.getElementById('comboSucesso');
  const codigoSucesso = document.getElementById('codigoSucesso');
  const pinSucesso = document.getElementById('pinSucesso');

  // Tamanho máximo aceito para o comprovante (5 MB) e tipos aceitos.
  const TAMANHO_MAXIMO_ARQUIVO = 5 * 1024 * 1024;
  const TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

  function esconderTodasAsTelas() {
    if (telaForm) telaForm.style.display = 'none';
    if (telaPagamentoPix) telaPagamentoPix.style.display = 'none';
    if (telaResumo) telaResumo.style.display = 'none';
    if (telaSucesso) telaSucesso.style.display = 'none';
  }

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

  /* ----------------------------------------------------------
     3) MÁSCARA DE TELEFONE
     ---------------------------------------------------------- */

  // Formata os dígitos digitados como (00) 00000-0000 (celular, 11
  // dígitos) ou (00) 0000-0000 (fixo, 10 dígitos), conforme a
  // quantidade de números já digitada. Qualquer caractere que não
  // seja dígito é descartado — é assim que letras ficam bloqueadas.
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

  if (campoTelefone) {
    campoTelefone.setAttribute('maxlength', '15');
    campoTelefone.setAttribute('inputmode', 'numeric');
    campoTelefone.addEventListener('input', function (evento) {
      evento.target.value = aplicarMascaraTelefone(evento.target.value);
    });
  }

  /* ----------------------------------------------------------
     3.1) MÁSCARA DO PIN DE SEGURANÇA (4 dígitos numéricos)
     ---------------------------------------------------------- */

  [campoPin, campoPinConfirma].forEach(function (campo) {
    if (!campo) return;
    campo.setAttribute('maxlength', '4');
    campo.setAttribute('inputmode', 'numeric');
    campo.setAttribute('autocomplete', 'off');
    campo.addEventListener('input', function (evento) {
      evento.target.value = evento.target.value.replace(/\D/g, '').slice(0, 4);
    });
  });

  /* ----------------------------------------------------------
     4) BOTÃO "COPIAR CHAVE PIX"
     ---------------------------------------------------------- */

  const btnCopiarPix = document.getElementById('btnCopiarPix');
  const chavePixTexto = document.getElementById('chavePixTexto');

  async function copiarTexto(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(texto);
        return true;
      } catch (erro) {
        // segue para o método alternativo abaixo
      }
    }
    try {
      const areaTemp = document.createElement('textarea');
      areaTemp.value = texto;
      areaTemp.style.position = 'fixed';
      areaTemp.style.opacity = '0';
      document.body.appendChild(areaTemp);
      areaTemp.focus();
      areaTemp.select();
      document.execCommand('copy');
      document.body.removeChild(areaTemp);
      return true;
    } catch (erro) {
      return false;
    }
  }

  if (btnCopiarPix && chavePixTexto) {
    btnCopiarPix.addEventListener('click', async function () {
      const chave = chavePixTexto.textContent.trim();
      const sucesso = await copiarTexto(chave);

      const textoOriginal = 'Copiar Chave Pix';
      btnCopiarPix.textContent = sucesso ? 'Copiado! ✓' : 'Não foi possível copiar';
      btnCopiarPix.classList.toggle('copiado', sucesso);

      setTimeout(function () {
        btnCopiarPix.textContent = textoOriginal;
        btnCopiarPix.classList.remove('copiado');
      }, 2000);
    });
  }

  /* ----------------------------------------------------------
     5) VALIDAÇÃO DE CADA PASSO + NAVEGAÇÃO
     ---------------------------------------------------------- */

  // Valida SÓ os dados pessoais (Passo 1).
  function validarPasso1() {
    esconderErro(erroInscricao);

    const nome = campoNome.value.trim();
    const email = campoEmail.value.trim();
    const telefone = campoTelefone.value.trim();

    if (nome.length < 3 || nome.indexOf(' ') === -1) {
      mostrarErro(erroInscricao, 'Informe seu nome completo.');
      campoNome.focus();
      return false;
    }

    const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailValido) {
      mostrarErro(erroInscricao, 'Informe um e-mail válido.');
      campoEmail.focus();
      return false;
    }

    const somenteDigitosTelefone = telefone.replace(/\D/g, '');
    if (somenteDigitosTelefone.length < 10) {
      mostrarErro(erroInscricao, 'Informe um telefone válido, com DDD.');
      campoTelefone.focus();
      return false;
    }

    return true;
  }

  // Valida SÓ o comprovante (Passo 2).
  function validarComprovante() {
    esconderErro(erroComprovante);

    const arquivo = campoComprovante.files[0];

    if (!arquivo) {
      mostrarErro(erroComprovante, 'Anexe o comprovante do Pix para continuar.');
      return false;
    }

    if (!TIPOS_ACEITOS.includes(arquivo.type)) {
      mostrarErro(erroComprovante, 'Formato inválido. Envie uma imagem (PNG/JPG) ou um PDF.');
      return false;
    }

    if (arquivo.size > TAMANHO_MAXIMO_ARQUIVO) {
      mostrarErro(erroComprovante, 'O arquivo deve ter até 5 MB.');
      return false;
    }

    return true;
  }

  // Relê o card marcado como selecionado na hora de montar o resumo
  // (ou de confirmar, na seção 8), em vez de confiar apenas no
  // estadoInscricao já guardado — garante que #resumoValorTxt e o
  // valor enviado na RPC usam exatamente o mesmo número exibido no
  // card. Cascata de segurança no valor: preço do card → último
  // valor válido já guardado no estado → 0. Nunca deixa NaN chegar
  // na tela nem na RPC.
  function sincronizarEstadoComCardSelecionado() {
    const cardSelecionado = document.querySelector('#combos .combo[data-selected="true"]');
    if (!cardSelecionado) return;

    const tipo = cardSelecionado.getAttribute('data-id');
    if (tipo) estadoInscricao.tipoIngresso = tipo;

    let valor = lerValorNumerico(cardSelecionado.getAttribute('data-preco'));
    if (isNaN(valor)) valor = lerValorNumerico(estadoInscricao.valor);
    if (isNaN(valor)) valor = 0;

    estadoInscricao.valor = valor;
  }

  // Preenche os 4 campos do resumo com o estado atual. Extraída como
  // função própria porque também é chamada por
  // carregarConfiguracoesCheckout (seção 1.1) se o preço mudar
  // enquanto a pessoa já está olhando o resumo.
  function preencherResumoComEstadoAtual() {
    const arquivoComprovante = campoComprovante.files[0];
    resumoNomeTxt.textContent = campoNome.value.trim();
    resumoComboTxt.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso || '—';
    resumoComprovanteTxt.textContent = arquivoComprovante ? arquivoComprovante.name : 'anexado';
    resumoValorTxt.textContent = formatarMoeda(estadoInscricao.valor);
  }

  if (btnIrPagamento) {
    btnIrPagamento.addEventListener('click', async function () {
      if (!validarPasso1()) return;

      // Limpa um aviso de duplicidade de uma tentativa anterior,
      // antes de checar de novo.
      esconderAvisoDuplicidade();

      // Garante que o tipo de ingresso usado na checagem de
      // duplicidade abaixo é exatamente o do card selecionado agora.
      sincronizarEstadoComCardSelecionado();

      const nomeParaChecagem = campoNome.value.trim();
      const emailParaChecagem = campoEmail.value.trim();
      const tipoIngressoParaChecagem = estadoInscricao.tipoIngresso;

      btnIrPagamento.disabled = true;
      const textoOriginalBotaoPagamento = btnIrPagamento.textContent;
      btnIrPagamento.textContent = 'Verificando...';

      try {
        const duplicada = await existeInscricaoDuplicada(nomeParaChecagem, emailParaChecagem, tipoIngressoParaChecagem);
        if (duplicada) {
          mostrarAvisoDuplicidade(
            'Já existe uma inscrição ativa deste tipo (ou um ingresso COMBO) para o participante ' +
              nomeParaChecagem + ' com este e-mail.'
          );
          return; // fica no Passo 1 — o botão é reabilitado no finally abaixo
        }
      } catch (erroInesperado) {
        // "Fail-open": um erro na CHECAGEM em si não deve travar
        // quem está tentando se inscrever de boa-fé.
        console.error('[inscricao.js] Erro inesperado ao checar duplicidade:', erroInesperado);
      } finally {
        btnIrPagamento.disabled = false;
        btnIrPagamento.textContent = textoOriginalBotaoPagamento;
      }

      esconderTodasAsTelas();
      telaPagamentoPix.style.display = 'block';
      // Sem scrollIntoView: a troca de passo só alterna qual card
      // está visível, mantendo a posição de rolagem do usuário.
    });
  }

  if (btnVoltarPagamento) {
    btnVoltarPagamento.addEventListener('click', function () {
      esconderErro(erroInscricao);
      esconderTodasAsTelas();
      telaForm.style.display = 'block';
    });
  }

  if (btnIrConfirmacao) {
    btnIrConfirmacao.addEventListener('click', function () {
      if (!validarComprovante()) return;

      preencherResumoComEstadoAtual();

      esconderTodasAsTelas();
      telaResumo.style.display = 'block';
    });
  }

  if (btnVoltarResumo) {
    btnVoltarResumo.addEventListener('click', function () {
      esconderErro(erroResumo);
      esconderTodasAsTelas();
      telaPagamentoPix.style.display = 'block';
    });
  }

  /* ----------------------------------------------------------
     6) CHECAGEM DE INSCRIÇÃO DUPLICADA
     ---------------------------------------------------------- */

  // Considera duplicidade quando este NOME + E-MAIL já têm uma
  // inscrição para o MESMO tipo de ingresso — ou já têm um ingresso
  // COMBO (que cobre os dois dias, tornando qualquer outra compra
  // redundante). Essa regra mora inteira na função SQL da RPC; aqui
  // só repassamos os três campos e lemos o booleano de volta.
  // Mantida exatamente como já estava — nada aqui depende de lote.
  async function existeInscricaoDuplicada(nome, email, tipoIngresso) {
    const { data, error } = await window.supabaseClient.rpc('checar_inscricao_duplicada', {
      p_nome: nome,
      p_email: email,
      p_tipo_ingresso: tipoIngresso,
    });

    if (error) {
      console.error('[inscricao.js] Erro ao checar duplicidade via RPC "checar_inscricao_duplicada":', error);
      return false;
    }

    return Boolean(data);
  }

  /* ----------------------------------------------------------
     7) HELPERS DE ARQUIVO E ERRO
     ---------------------------------------------------------- */

  // Mantém a extensão original (em minúsculas) ou usa ".png" como
  // fallback caso o arquivo não tenha extensão reconhecível.
  function obterExtensao(nomeOriginal) {
    const partes = nomeOriginal.split('.');
    return partes.length > 1 ? '.' + partes.pop().toLowerCase() : '.png';
  }

  // Extrai a melhor mensagem de diagnóstico disponível de um erro,
  // seja ele um Error do JavaScript ou um objeto de erro retornado
  // pelo Supabase. Sempre retorna uma string, nunca undefined.
  function obterMensagemErro(erro, fallback) {
    if (!erro) return fallback;
    if (typeof erro === 'string') return erro;
    return erro.message || erro.error_description || fallback;
  }

  // Lê o arquivo como ArrayBuffer antes do upload — evita uma falha
  // conhecida em navegadores mobile (Safari iOS e alguns WebViews
  // Android) onde o corpo da requisição não é lido corretamente
  // quando um File é repassado diretamente para o upload.
  function lerArquivoComoArrayBuffer(arquivo) {
    return new Promise(function (resolve, reject) {
      const leitor = new FileReader();
      leitor.onload = function () {
        resolve(leitor.result);
      };
      leitor.onerror = function () {
        reject(new Error('Não foi possível ler o arquivo do comprovante neste dispositivo.'));
      };
      leitor.readAsArrayBuffer(arquivo);
    });
  }

  /* ----------------------------------------------------------
     7.1) PIN DE SEGURANÇA: dupla validação (Passo 3)
     ---------------------------------------------------------- */

  function validarPin() {
    const pin = campoPin ? campoPin.value.trim() : '';
    const pinConfirma = campoPinConfirma ? campoPinConfirma.value.trim() : '';

    const pinNumericoDe4Digitos = /^\d{4}$/.test(pin);
    if (!pinNumericoDe4Digitos) {
      mostrarErro(erroResumo, 'Crie um PIN de segurança com exatamente 4 números.');
      if (campoPin) campoPin.focus();
      return null;
    }

    if (pin !== pinConfirma) {
      mostrarErro(erroResumo, 'Os dois PINs digitados não coincidem. Confira e tente novamente.');
      if (campoPinConfirma) campoPinConfirma.focus();
      return null;
    }

    return pin;
  }

  /* ----------------------------------------------------------
     7.2) TIPO DE INGRESSO: normalização antes da criação
     ---------------------------------------------------------- */

  const TIPOS_INGRESSO_VALIDOS = ['SEXTA', 'SABADO', 'COMBO'];

  function normalizarTipoIngresso(valorBruto) {
    const tipo = String(valorBruto || '').trim().toUpperCase();
    return TIPOS_INGRESSO_VALIDOS.includes(tipo) ? tipo : null;
  }

  /* ----------------------------------------------------------
     8) PASSO 3 → SUCESSO: upload do comprovante + criação segura
        da inscrição via RPC
     ---------------------------------------------------------- */

  // Faz upload do arquivo para o bucket "comprovantes" e devolve a
  // URL pública do arquivo salvo.
  async function enviarComprovante(arquivo) {
    const extensao = obterExtensao(arquivo.name);
    const nomeArquivoUnico = `comprovante_${Date.now()}_${Math.floor(Math.random() * 10000)}${extensao}`;

    const conteudoArquivo = await lerArquivoComoArrayBuffer(arquivo);

    const { error: erroUpload } = await window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .upload(nomeArquivoUnico, conteudoArquivo, {
        cacheControl: '3600',
        upsert: true,
        contentType: arquivo.type || 'application/octet-stream',
      });

    if (erroUpload) {
      throw new Error('Falha ao enviar o comprovante: ' + obterMensagemErro(erroUpload, 'erro desconhecido no upload.'));
    }

    const { data: dadosUrlPublica } = window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .getPublicUrl(nomeArquivoUnico);

    return dadosUrlPublica.publicUrl;
  }

  // Chama a RPC criar_inscricao_segura e devolve a linha criada.
  // Ver a nota "ATENÇÃO — SUPOSIÇÕES A CONFIRMAR" no cabeçalho do
  // arquivo sobre o parâmetro p_comprovante_url.
  async function criarInscricaoSegura(dados) {
    const { data, error } = await window.supabaseClient.rpc('criar_inscricao_segura', {
      p_nome: dados.nome,
      p_email: dados.email,
      p_telefone: dados.telefone,
      p_pin: dados.pin,
      p_tipo_ingresso: dados.tipoIngresso,
      // Ver ATENÇÃO no cabeçalho: parâmetro extra, não confirmado.
      p_comprovante_url: dados.comprovanteUrl,
    });

    if (error) {
      throw new Error('Falha ao salvar a inscrição: ' + obterMensagemErro(error, 'erro desconhecido ao gravar a inscrição.'));
    }

    // A RPC pode devolver um objeto único ou um array de 1 item.
    const inscricaoCriada = Array.isArray(data) ? data[0] : data;
    if (!inscricaoCriada) {
      throw new Error('A inscrição não pôde ser confirmada. Tente novamente.');
    }

    return inscricaoCriada;
  }

  if (btnConfirmarInscricao) {
    btnConfirmarInscricao.addEventListener('click', async function (evento) {
      // Dispara de forma síncrona, ANTES de qualquer código
      // assíncrono — garante que o botão já nasça bloqueado antes
      // de qualquer "await" rodar.
      if (evento && typeof evento.preventDefault === 'function') {
        evento.preventDefault();
      }

      if (btnConfirmarInscricao.disabled) return;

      esconderErro(erroResumo);

      const pinValidado = validarPin();
      if (!pinValidado) return;

      sincronizarEstadoComCardSelecionado();

      const tipoIngressoValidado = normalizarTipoIngresso(estadoInscricao.tipoIngresso);
      if (!tipoIngressoValidado) {
        console.error(
          '[inscricao.js] tipo_ingresso inválido no momento da criação:',
          estadoInscricao.tipoIngresso
        );
        mostrarErro(erroResumo, 'Não foi possível identificar o ingresso selecionado. Volte e escolha a opção novamente.');
        return;
      }

      btnConfirmarInscricao.disabled = true;
      const textoOriginalBotao = btnConfirmarInscricao.textContent;

      const arquivo = campoComprovante.files[0];
      if (!arquivo) {
        mostrarErro(erroResumo, 'O comprovante não foi encontrado. Volte e anexe novamente.');
        btnConfirmarInscricao.disabled = false;
        return;
      }

      const nomeCompleto = campoNome.value.trim();
      const email = campoEmail.value.trim();
      const telefone = campoTelefone.value.trim();

      try {
        btnConfirmarInscricao.textContent = 'Enviando...';
        const urlComprovante = await enviarComprovante(arquivo);

        btnConfirmarInscricao.textContent = 'Confirmando...';
        const inscricaoCriada = await criarInscricaoSegura({
          nome: nomeCompleto,
          email: email,
          telefone: telefone,
          pin: pinValidado,
          tipoIngresso: tipoIngressoValidado,
          comprovanteUrl: urlComprovante,
        });

        // Preenche e exibe a tela de sucesso. O pagamento ainda
        // depende de conferência manual — o código e o PIN exibidos
        // são os que a própria RPC devolveu (gerados/gravados no
        // servidor).
        nomeSucesso.textContent = nomeCompleto.split(' ')[0];
        comboSucesso.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso;
        codigoSucesso.textContent = inscricaoCriada.codigo_ingresso || '';
        if (pinSucesso) pinSucesso.textContent = inscricaoCriada.pin_seguranca || pinValidado;

        esconderTodasAsTelas();
        telaSucesso.style.display = 'block';
      } catch (erro) {
        console.error('[inscricao.js] Erro ao confirmar inscrição:', erro);
        mostrarErro(erroResumo, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
      } finally {
        btnConfirmarInscricao.disabled = false;
        btnConfirmarInscricao.textContent = textoOriginalBotao;
      }
    });
  }

  /* ----------------------------------------------------------
     9) "FAZER OUTRA INSCRIÇÃO": reseta o formulário
     ---------------------------------------------------------- */

  if (btnNovaInscricao) {
    btnNovaInscricao.addEventListener('click', function () {
      campoNome.value = '';
      campoEmail.value = '';
      campoTelefone.value = '';
      campoComprovante.value = '';
      if (campoPin) campoPin.value = '';
      if (campoPinConfirma) campoPinConfirma.value = '';
      esconderErro(erroInscricao);
      esconderErro(erroComprovante);
      esconderErro(erroResumo);
      esconderAvisoDuplicidade();

      selecionarCombo(comboInicial || listaCombos[0]);

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
    });
  }

  /* ----------------------------------------------------------
     10) FAQ: MODAL ÚNICO DE DÚVIDAS FREQUENTES
     ---------------------------------------------------------- */

  const faqCards = document.querySelectorAll('.faq-card');
  const modalFaq = document.getElementById('modalFaq');
  const modalFaqTitulo = document.getElementById('modalFaqTitulo');
  const modalFaqCorpo = document.getElementById('modalFaqCorpo');
  const btnFecharModalFaq = document.getElementById('btnFecharModalFaq');

  // Controla se o modal foi aberto "sob controle" da History API —
  // usado para o botão/gesto "Voltar" do celular fechar o modal em
  // vez de sair da página.
  let modalFaqAbertoPeloHistorico = false;

  function abrirModalFaq(pergunta, resposta) {
    if (!modalFaq) return;
    if (modalFaqTitulo) modalFaqTitulo.textContent = pergunta || '';
    if (modalFaqCorpo) modalFaqCorpo.textContent = resposta || '';

    const jaEstavaAberto = modalFaq.classList.contains('aberto');
    modalFaq.classList.add('aberto');

    if (!jaEstavaAberto) {
      history.pushState({ modalFaqAberto: true }, '');
      modalFaqAbertoPeloHistorico = true;
    }
  }

  function fecharModalFaq(fechadoPeloHistorico) {
    if (!modalFaq) return;
    if (!modalFaq.classList.contains('aberto')) return;

    modalFaq.classList.remove('aberto');

    if (modalFaqAbertoPeloHistorico && !fechadoPeloHistorico) {
      modalFaqAbertoPeloHistorico = false;
      history.back();
    } else {
      modalFaqAbertoPeloHistorico = false;
    }
  }

  faqCards.forEach(function (card) {
    card.addEventListener('click', function () {
      abrirModalFaq(card.getAttribute('data-pergunta'), card.getAttribute('data-resposta'));
    });

    card.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter' || evento.key === ' ') {
        evento.preventDefault();
        abrirModalFaq(card.getAttribute('data-pergunta'), card.getAttribute('data-resposta'));
      }
    });
  });

  if (btnFecharModalFaq) {
    btnFecharModalFaq.addEventListener('click', function () {
      fecharModalFaq(false);
    });
  }

  if (modalFaq) {
    modalFaq.addEventListener('click', function (evento) {
      if (evento.target === modalFaq) fecharModalFaq(false);
    });
  }

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && modalFaq && modalFaq.classList.contains('aberto')) {
      fecharModalFaq(false);
    }
  });

  window.addEventListener('popstate', function () {
    if (modalFaq && modalFaq.classList.contains('aberto')) {
      fecharModalFaq(true);
    }
  });
});
