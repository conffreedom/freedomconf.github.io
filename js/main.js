/* ============================================================
   js/main.js
   ------------------------------------------------------------
   Lógica do SITE PÚBLICO (index.html):
     1) Contagem regressiva viva até o evento;
     2) Seleção de ingresso (Sexta / Sábado / Combo);
     3) Máscara de telefone e validação do formulário;
     4) Botão "Copiar Chave Pix";
     5) Checagem de inscrição duplicada (mesmo nome + e-mail);
     6) Upload do comprovante de Pix para o Supabase Storage;
     7) Geração do código único do ingresso e INSERT na tabela
        "inscricoes" do Supabase;
     8) Tela de sucesso com status "Aguardando Validação do Pix".

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient e
       window.SUPABASE_COMPROVANTES_BUCKET), carregado ANTES
       deste arquivo.
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
     4) MÁSCARA DE TELEFONE
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

    // Até 10 dígitos no total (2 do DDD + 8 do número): formato de
    // telefone fixo, bloco de 4 + 4. Com 11 dígitos: celular, 5 + 4.
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
     5) BOTÃO "COPIAR CHAVE PIX"
     ---------------------------------------------------------- */

  const btnCopiarPix = document.getElementById('btnCopiarPix');
  const chavePixTexto = document.getElementById('chavePixTexto');

  // Copia o texto para a área de transferência. Tenta primeiro a
  // Clipboard API moderna; se o navegador não suportar (ou a
  // permissão for negada), cai para o método antigo via
  // document.execCommand, que funciona em praticamente qualquer
  // navegador dentro de um clique do usuário.
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
     6) PASSO 1 → PASSO 2: validação dos dados e do comprovante
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
     7) CHECAGEM DE INSCRIÇÃO DUPLICADA
     ---------------------------------------------------------- */

  // Considera duplicidade apenas quando NOME COMPLETO e E-MAIL são
  // ambos exatamente iguais a uma inscrição já existente. Se o
  // e-mail se repetir com um nome diferente (ex.: alguém inscrevendo
  // um familiar com o mesmo e-mail de contato), a inscrição segue
  // normalmente — só o par (nome, e-mail) precisa ser único.
  async function existeInscricaoDuplicada(nomeCompleto, email) {
    const { data, error } = await window.supabaseClient
      .from('inscricoes')
      .select('id')
      .eq('nome_completo', nomeCompleto)
      .eq('email', email)
      .limit(1);

    if (error) {
      // Se a checagem em si falhar (ex.: instabilidade de rede),
      // não travamos a inscrição por causa disso — deixamos seguir
      // e uma eventual duplicidade é tratada manualmente pela
      // equipe no painel administrativo.
      console.error('[main.js] Erro ao checar duplicidade:', error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  /* ----------------------------------------------------------
     8) GERAÇÃO DO CÓDIGO DO INGRESSO
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

  // Simplifica a extração da extensão do arquivo — mantém a
  // extensão original (em minúsculas) ou usa ".png" como
  // fallback caso o arquivo não tenha extensão reconhecível.
  function obterExtensao(nomeOriginal) {
    const partes = nomeOriginal.split('.');
    return partes.length > 1 ? '.' + partes.pop().toLowerCase() : '.png';
  }

  /* ----------------------------------------------------------
     9) PASSO 2 → PASSO 3: upload do comprovante + INSERT
     ---------------------------------------------------------- */

  // Faz upload do arquivo para o bucket "comprovantes" e devolve a
  // URL pública do arquivo salvo. O nome do arquivo é gerado só com
  // carimbo de data/hora + número aleatório + extensão — sem
  // depender de normalizar o nome original — o que evita hífens
  // repetidos e caracteres que o Storage do Supabase rejeita em
  // alguns navegadores/idiomas. "upsert: true" evita erro 400 em
  // caso de qualquer conflito de nome (colisão extremamente rara,
  // já que o nome já é único por natureza).
  async function enviarComprovante(arquivo) {
    const extensao = obterExtensao(arquivo.name);
    const nomeArquivoUnico = `comprovante_${Date.now()}_${Math.floor(Math.random() * 10000)}${extensao}`;

    const { error: erroUpload } = await window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .upload(nomeArquivoUnico, arquivo, {
        cacheControl: '3600',
        upsert: true,
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

      const nomeCompleto = campoNome.value.trim();
      const email = campoEmail.value.trim();

      btnConfirmarInscricao.disabled = true;
      const textoOriginalBotao = btnConfirmarInscricao.textContent;

      try {
        // Checa duplicidade ANTES de subir o arquivo e gravar
        // qualquer coisa no banco — evita upload desnecessário.
        btnConfirmarInscricao.textContent = 'Verificando...';
        const duplicada = await existeInscricaoDuplicada(nomeCompleto, email);
        if (duplicada) {
          mostrarErro(erroResumo, 'Já existe uma inscrição realizada com este Nome e E-mail.');
          return;
        }

        btnConfirmarInscricao.textContent = 'Enviando...';
        const urlComprovante = await enviarComprovante(arquivo);

        const dadosInscricao = {
          nome_completo: nomeCompleto,
          email: email,
          telefone: campoTelefone.value.trim(),
          tipo_ingresso: estadoInscricao.tipoIngresso,
          valor_pago: estadoInscricao.valor,
          status_pagamento: 'pendente',
          checkin_realizado: false,
          comprovante_url: urlComprovante,
        };

        const inscricaoCriada = await inserirInscricaoComRetentativa(dadosInscricao, 5);

        // Preenche e exibe a tela de sucesso. O pagamento ainda
        // depende de conferência manual, então nenhum QR code é
        // gerado aqui — só o código em texto, como referência.
        nomeSucesso.textContent = nomeCompleto.split(' ')[0];
        comboSucesso.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso;
        codigoSucesso.textContent = inscricaoCriada.codigo_ingresso;

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
     10) "FAZER OUTRA INSCRIÇÃO": reseta o formulário
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

      selecionarCombo(comboInicial || listaCombos[0]);

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
      telaForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
});
