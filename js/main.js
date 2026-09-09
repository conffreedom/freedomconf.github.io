/* ============================================================
   js/main.js
   ------------------------------------------------------------
   Lógica do SITE PÚBLICO (index.html):
     1) Contagem regressiva viva até o evento;
     2) Seleção de ingresso (Sexta / Sábado / Combo);
     3) Validação do formulário de inscrição;
     4) Upload do comprovante de Pix para o Supabase Storage;
     5) Geração do código único do ingresso e INSERT na tabela
        "inscricoes" do Supabase;
     6) Tela de sucesso com QR code do código gerado.

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient e
       window.SUPABASE_COMPROVANTES_BUCKET), carregado ANTES
       deste arquivo;
     - biblioteca QRCode.js (window.QRCode), carregada no
       <head> do index.html.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ----------------------------------------------------------
     1) CONTAGEM REGRESSIVA
     ---------------------------------------------------------- */

  // Data/hora do evento: 30/10/2026 às 20h, horário de Brasília
  // (UTC-3, sem horário de verão). Escrever o offset explicitamente
  // ("-03:00") evita que o resultado dependa do fuso horário
  // configurado no computador de quem está vendo a página.
  const DATA_EVENTO = new Date('2026-10-30T20:00:00-03:00');

  const elDias = document.getElementById('cdDias');
  const elHoras = document.getElementById('cdHoras');
  const elMin = document.getElementById('cdMin');
  const elSeg = document.getElementById('cdSeg');

  // Sempre exibe dois dígitos (ex.: "05" em vez de "5").
  function doisDigitos(numero) {
    return String(Math.max(0, numero)).padStart(2, '0');
  }

  function atualizarContagem() {
    const agora = new Date();
    const diferencaMs = DATA_EVENTO.getTime() - agora.getTime();

    // Evento já começou / já passou: zera o painel e para o timer.
    if (diferencaMs <= 0) {
      elDias.textContent = '00';
      elHoras.textContent = '00';
      elMin.textContent = '00';
      elSeg.textContent = '00';
      clearInterval(intervaloContagem);
      return;
    }

    const totalSegundos = Math.floor(diferencaMs / 1000);
    const dias = Math.floor(totalSegundos / 86400);
    const horas = Math.floor((totalSegundos % 86400) / 3600);
    const minutos = Math.floor((totalSegundos % 3600) / 60);
    const segundos = totalSegundos % 60;

    elDias.textContent = doisDigitos(dias);
    elHoras.textContent = doisDigitos(horas);
    elMin.textContent = doisDigitos(minutos);
    elSeg.textContent = doisDigitos(segundos);
  }

  // Só liga o timer se os elementos da contagem existirem nesta
  // página (proteção simples caso este script seja reaproveitado
  // em outra tela no futuro).
  let intervaloContagem = null;
  if (elDias && elHoras && elMin && elSeg) {
    atualizarContagem();
    intervaloContagem = setInterval(atualizarContagem, 1000);
  }

  /* ----------------------------------------------------------
     2) SELEÇÃO DE INGRESSO (combos)
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

  // Formata um número para o padrão monetário brasileiro (R$ 0,00).
  function formatarMoeda(valor) {
    return valor.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
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
     3) ELEMENTOS DOS 3 PASSOS DO FORMULÁRIO
     ---------------------------------------------------------- */

  const telaForm = document.getElementById('formInscricao');
  const telaResumo = document.getElementById('resumoPedido');
  const telaSucesso = document.getElementById('telaSucesso');

  const campoNome = document.getElementById('campoNome');
  const campoEmail = document.getElementById('campoEmail');
  const campoTelefone = document.getElementById('campoTelefone');
  const campoComprovante = document.getElementById('campoComprovante');

  const erroInscricao = document.getElementById('erroInscricao');
  const erroComprovante = document.getElementById('erroComprovante');
  const erroResumo = document.getElementById('erroResumo');

  const btnIrPagamento = document.getElementById('btnIrPagamento');
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
  const qrcodeBox = document.getElementById('qrcodeBox');

  // Tamanho máximo aceito para o comprovante (5 MB) e tipos aceitos.
  const TAMANHO_MAXIMO_ARQUIVO = 5 * 1024 * 1024;
  const TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

  function esconderTodasAsTelas() {
    if (telaForm) telaForm.style.display = 'none';
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
     4) PASSO 1 → PASSO 2: validação dos dados e do comprovante
     ---------------------------------------------------------- */

  function validarPasso1() {
    esconderErro(erroInscricao);
    esconderErro(erroComprovante);

    const nome = campoNome.value.trim();
    const email = campoEmail.value.trim();
    const telefone = campoTelefone.value.trim();
    const arquivo = campoComprovante.files[0];

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

  if (btnIrPagamento) {
    btnIrPagamento.addEventListener('click', function () {
      if (!validarPasso1()) return;

      // Preenche o resumo com os dados já validados.
      resumoNomeTxt.textContent = campoNome.value.trim();
      resumoComboTxt.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso;
      resumoComprovanteTxt.textContent = campoComprovante.files[0].name;
      resumoValorTxt.textContent = formatarMoeda(estadoInscricao.valor);

      esconderTodasAsTelas();
      telaResumo.style.display = 'block';
    });
  }

  if (btnVoltarResumo) {
    btnVoltarResumo.addEventListener('click', function () {
      esconderErro(erroResumo);
      esconderTodasAsTelas();
      telaForm.style.display = 'block';
    });
  }

  /* ----------------------------------------------------------
     5) GERAÇÃO DO CÓDIGO DO INGRESSO
     ---------------------------------------------------------- */

  // Gera um código no formato "FC2026-XXXXXX", usando apenas
  // letras maiúsculas e números para facilitar leitura e digitação
  // manual na portaria, caso o QR code não possa ser lido.
  function gerarCodigoIngresso() {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 (evita confusão visual)
    let sufixo = '';
    for (let i = 0; i < 6; i++) {
      const indice = Math.floor(Math.random() * caracteres.length);
      sufixo += caracteres[indice];
    }
    return 'FC2026-' + sufixo;
  }

  // Remove acentos, espaços e caracteres especiais do nome do
  // arquivo, mantendo a extensão original — importante porque o
  // Storage do Supabase rejeita alguns caracteres em nomes de chave.
  function sanitizarNomeArquivo(nomeOriginal) {
    const partes = nomeOriginal.split('.');
    const extensao = partes.length > 1 ? '.' + partes.pop().toLowerCase() : '';
    const nomeBase = partes
      .join('.')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .toLowerCase()
      .slice(0, 40);
    return (nomeBase || 'comprovante') + extensao;
  }

  /* ----------------------------------------------------------
     6) PASSO 2 → PASSO 3: upload do comprovante + INSERT
     ---------------------------------------------------------- */

  // Faz upload do arquivo para o bucket "comprovantes" e devolve a
  // URL pública do arquivo salvo.
  async function enviarComprovante(arquivo) {
    const nomeArquivoUnico = Date.now() + '-' + sanitizarNomeArquivo(arquivo.name);

    const { error: erroUpload } = await window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .upload(nomeArquivoUnico, arquivo, {
        cacheControl: '3600',
        upsert: false,
      });

    if (erroUpload) {
      throw new Error('Não foi possível enviar o comprovante. Tente novamente.');
    }

    const { data: dadosUrlPublica } = window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .getPublicUrl(nomeArquivoUnico);

    return dadosUrlPublica.publicUrl;
  }

  // Tenta inserir a inscrição no banco. Se o código gerado já
  // existir (colisão, code 23505 = unique_violation), gera um novo
  // código e tenta de novo, até um número máximo de tentativas —
  // isso é extremamente raro (36^6 combinações), mas o código fica
  // preparado para o caso.
  async function inserirInscricaoComRetentativa(dadosBase, tentativasRestantes) {
    const codigo = gerarCodigoIngresso();

    const { data, error } = await window.supabaseClient
      .from('inscricoes')
      .insert([Object.assign({}, dadosBase, { codigo_ingresso: codigo })])
      .select()
      .single();

    if (!error) {
      return data;
    }

    const eraColisaoDeCodigo = error.code === '23505';
    if (eraColisaoDeCodigo && tentativasRestantes > 0) {
      return inserirInscricaoComRetentativa(dadosBase, tentativasRestantes - 1);
    }

    throw new Error('Não foi possível concluir a inscrição. Tente novamente em instantes.');
  }

  // Gera visualmente o QR code do código do ingresso dentro de
  // #qrcodeBox. Precisa limpar o conteúdo anterior porque a
  // biblioteca QRCode.js apenas adiciona elementos, não substitui.
  function gerarQrCode(codigo) {
    if (!qrcodeBox || typeof QRCode === 'undefined') return;
    qrcodeBox.innerHTML = '';
    new QRCode(qrcodeBox, {
      text: codigo,
      width: 140,
      height: 140,
      colorDark: '#053827',
      colorLight: '#FBFAF7',
    });
  }

  if (btnConfirmarInscricao) {
    btnConfirmarInscricao.addEventListener('click', async function () {
      esconderErro(erroResumo);

      const arquivo = campoComprovante.files[0];
      if (!arquivo) {
        // Segurança extra: se por algum motivo o arquivo não estiver
        // mais disponível (ex.: usuário voltou e trocou o campo),
        // manda de volta para o passo 1 em vez de prosseguir.
        mostrarErro(erroResumo, 'O comprovante não foi encontrado. Volte e anexe novamente.');
        return;
      }

      btnConfirmarInscricao.disabled = true;
      const textoOriginalBotao = btnConfirmarInscricao.textContent;
      btnConfirmarInscricao.textContent = 'Enviando...';

      try {
        const urlComprovante = await enviarComprovante(arquivo);

        const dadosInscricao = {
          nome_completo: campoNome.value.trim(),
          email: campoEmail.value.trim(),
          telefone: campoTelefone.value.trim(),
          tipo_ingresso: estadoInscricao.tipoIngresso,
          valor_pago: estadoInscricao.valor,
          status_pagamento: 'pendente',
          checkin_realizado: false,
          comprovante_url: urlComprovante,
        };

        const inscricaoCriada = await inserirInscricaoComRetentativa(dadosInscricao, 5);

        // Preenche e exibe a tela de sucesso.
        nomeSucesso.textContent = campoNome.value.trim().split(' ')[0];
        comboSucesso.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso;
        codigoSucesso.textContent = inscricaoCriada.codigo_ingresso;
        gerarQrCode(inscricaoCriada.codigo_ingresso);

        esconderTodasAsTelas();
        telaSucesso.style.display = 'block';
        telaSucesso.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (erro) {
        mostrarErro(erroResumo, erro.message || 'Ocorreu um erro inesperado. Tente novamente.');
      } finally {
        btnConfirmarInscricao.disabled = false;
        btnConfirmarInscricao.textContent = textoOriginalBotao;
      }
    });
  }

  /* ----------------------------------------------------------
     7) "FAZER OUTRA INSCRIÇÃO": reseta o formulário
     ---------------------------------------------------------- */

  if (btnNovaInscricao) {
    btnNovaInscricao.addEventListener('click', function () {
      campoNome.value = '';
      campoEmail.value = '';
      campoTelefone.value = '';
      campoComprovante.value = '';
      esconderErro(erroInscricao);
      esconderErro(erroComprovante);
      esconderErro(erroResumo);

      if (qrcodeBox) qrcodeBox.innerHTML = '';

      selecionarCombo(comboInicial || listaCombos[0]);

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
      telaForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
});