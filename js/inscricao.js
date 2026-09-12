/* ============================================================
   js/inscricao.js
   ------------------------------------------------------------
   Lógica do PORTAL DE INSCRIÇÃO & CREDENCIAL (inscricao.html):
     1) Seleção de ingresso (Sexta / Sábado / Combo);
     2) Máscara de telefone e validação do formulário;
     3) Botão "Copiar Chave Pix";
     4) Checagem de inscrição duplicada (mesmo nome + e-mail);
     5) Upload do comprovante de Pix para o Supabase Storage;
     6) Geração do código único do ingresso e INSERT na tabela
        "inscricoes" do Supabase;
     7) Tela de sucesso com status "Aguardando Validação do Pix";
     8) Consulta por e-mail/código e exibição da credencial com
        o QR code de entrada (para inscrições aprovadas).

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient e
       window.SUPABASE_COMPROVANTES_BUCKET), carregado ANTES
       deste arquivo;
     - biblioteca QRCode.js (window.QRCode), carregada no <head>
       do inscricao.html.

   A contagem regressiva, o menu mobile e o scroll reveal da
   Landing Page NÃO estão mais aqui — ver js/main.js.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

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
     2) ELEMENTOS DOS 3 PASSOS DO FORMULÁRIO
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
     4) BOTÃO "COPIAR CHAVE PIX"
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
     5) PASSO 1 → PASSO 2: validação dos dados e do comprovante
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
     6) CHECAGEM DE INSCRIÇÃO DUPLICADA
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
      console.error('[inscricao.js] Erro ao checar duplicidade:', error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  /* ----------------------------------------------------------
     7) GERAÇÃO DO CÓDIGO DO INGRESSO
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

  // Extrai a melhor mensagem de diagnóstico disponível de um erro,
  // seja ele um Error do JavaScript ou um objeto de erro retornado
  // pelo Supabase (que às vezes usa "message" e às vezes
  // "error_description"). Sempre retorna uma string, nunca undefined.
  function obterMensagemErro(erro, fallback) {
    if (!erro) return fallback;
    if (typeof erro === 'string') return erro;
    return erro.message || erro.error_description || fallback;
  }

  // Lê o arquivo como ArrayBuffer antes do upload. Isso evita uma
  // falha conhecida em navegadores mobile (principalmente Safari no
  // iOS e alguns WebViews no Android): quando o objeto File é
  // repassado diretamente para o upload, o corpo da requisição às
  // vezes não é lido corretamente pelo fetch/stream interno desses
  // navegadores, e a chamada fica "pendurada" por vários segundos
  // até falhar. Convertendo para ArrayBuffer, o conteúdo do arquivo
  // já está todo em memória antes do envio, então o upload passa a
  // se comportar da mesma forma em desktop e em mobile.
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
     8) PASSO 2 → PASSO 3: upload do comprovante + INSERT
     ---------------------------------------------------------- */

  // Faz upload do arquivo para o bucket "comprovantes" e devolve a
  // URL pública do arquivo salvo. O nome do arquivo é gerado só com
  // carimbo de data/hora + número aleatório + extensão — sem
  // depender de normalizar o nome original — o que evita hífens
  // repetidos e caracteres que o Storage do Supabase rejeita em
  // alguns navegadores/idiomas. "upsert: true" evita erro 400 em
  // caso de qualquer conflito de nome (colisão extremamente rara,
  // já que o nome já é único por natureza). O conteúdo é enviado
  // como ArrayBuffer (ver lerArquivoComoArrayBuffer acima) para
  // manter compatibilidade com navegadores mobile; como o
  // ArrayBuffer sozinho não carrega o tipo MIME, "contentType" é
  // informado explicitamente a partir do arquivo original.
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

    throw new Error('Falha ao salvar a inscrição: ' + obterMensagemErro(error, 'erro desconhecido ao gravar no banco.'));
  }

  if (btnConfirmarInscricao) {
    btnConfirmarInscricao.addEventListener('click', async function (evento) {
      // Dispara de forma síncrona, ANTES de qualquer código
      // assíncrono: evita que o clique acione algum comportamento
      // padrão do navegador (relevante sobretudo em mobile, onde
      // toques podem disparar eventos extras) e garante que o botão
      // já nasça bloqueado antes de qualquer "await" rodar.
      if (evento && typeof evento.preventDefault === 'function') {
        evento.preventDefault();
      }

      // Se o botão já está desabilitado, uma segunda batida de dedo
      // (comum em telas sensíveis, ou no delay de ~300ms de alguns
      // navegadores mobile) é ignorada — impede disparar duas
      // inscrições/uploads em paralelo para o mesmo clique.
      if (btnConfirmarInscricao.disabled) return;
      btnConfirmarInscricao.disabled = true;
      const textoOriginalBotao = btnConfirmarInscricao.textContent;

      esconderErro(erroResumo);

      const arquivo = campoComprovante.files[0];
      if (!arquivo) {
        // Segurança extra: se por algum motivo o arquivo não estiver
        // mais disponível (ex.: usuário voltou e trocou o campo),
        // manda de volta para o passo 1 em vez de prosseguir.
        mostrarErro(erroResumo, 'O comprovante não foi encontrado. Volte e anexe novamente.');
        btnConfirmarInscricao.disabled = false;
        return;
      }

      const nomeCompleto = campoNome.value.trim();
      const email = campoEmail.value.trim();

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
        // Mostra a mensagem REAL do erro (não uma genérica), para
        // diagnosticar problemas específicos de dispositivo/rede
        // relatados pelos usuários em campo.
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
      esconderErro(erroInscricao);
      esconderErro(erroComprovante);
      esconderErro(erroResumo);

      selecionarCombo(comboInicial || listaCombos[0]);

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
      telaForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ----------------------------------------------------------
     10) CONSULTAR MINHA INSCRIÇÃO / CREDENCIAL
     ---------------------------------------------------------- */

  const campoBuscaInscricao = document.getElementById('campoBuscaInscricao');
  const btnBuscarInscricao = document.getElementById('btnBuscarInscricao');
  const erroBuscaInscricao = document.getElementById('erroBuscaInscricao');

  const resultadoConsulta = document.getElementById('resultadoConsulta');
  const resultadoPendente = document.getElementById('resultadoPendente');
  const resultadoRecusado = document.getElementById('resultadoRecusado');
  const resultadoAprovado = document.getElementById('resultadoAprovado');
  const resultadoNaoEncontrado = document.getElementById('resultadoNaoEncontrado');

  const pendenteNome = document.getElementById('pendenteNome');
  const pendenteCombo = document.getElementById('pendenteCombo');
  const pendenteCodigo = document.getElementById('pendenteCodigo');

  const recusadoNome = document.getElementById('recusadoNome');
  const recusadoCodigo = document.getElementById('recusadoCodigo');

  const aprovadoNome = document.getElementById('aprovadoNome');
  const aprovadoCombo = document.getElementById('aprovadoCombo');
  const aprovadoCodigo = document.getElementById('aprovadoCodigo');
  const aprovadoQrcodeBox = document.getElementById('aprovadoQrcodeBox');

  // Decide se o texto digitado deve ser buscado como e-mail ou como
  // código de inscrição — nunca como CPF, que não existe em lugar
  // nenhum deste sistema. A regra é simples: se tem "@", é e-mail;
  // caso contrário, tratamos como código (normalizado em maiúsculas,
  // já que é assim que ele é gerado e exibido ao participante).
  function detectarTipoBusca(valorDigitado) {
    const valor = valorDigitado.trim();
    if (valor.includes('@')) {
      return { campo: 'email', valor: valor };
    }
    return { campo: 'codigo_ingresso', valor: valor.toUpperCase() };
  }

  // Esconde os 4 possíveis cartões de resultado e mostra só o
  // indicado (ou nenhum, se idEstado for null — usado para "resetar"
  // antes de uma nova busca).
  function mostrarEstadoConsulta(idEstado) {
    [resultadoPendente, resultadoRecusado, resultadoAprovado, resultadoNaoEncontrado].forEach(function (cartao) {
      if (cartao) cartao.style.display = 'none';
    });
    if (idEstado) {
      idEstado.style.display = 'block';
    }
    resultadoConsulta.style.display = 'block';
    resultadoConsulta.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Gera o QR code do código de entrada dentro de #aprovadoQrcodeBox.
  // Precisa limpar o conteúdo anterior porque a biblioteca QRCode.js
  // só adiciona elementos, nunca substitui os que já existem — sem
  // isso, cada nova busca aprovada empilharia um QR code em cima do
  // outro.
  function gerarQrCodeConsulta(codigo) {
    if (!aprovadoQrcodeBox || typeof QRCode === 'undefined') return;
    aprovadoQrcodeBox.innerHTML = '';
    new QRCode(aprovadoQrcodeBox, {
      text: codigo,
      width: 140,
      height: 140,
      colorDark: '#053827',
      colorLight: '#FBFAF7',
    });
  }

  async function buscarInscricao() {
    esconderErro(erroBuscaInscricao);

    const valorDigitado = campoBuscaInscricao.value.trim();
    if (!valorDigitado) {
      mostrarErro(erroBuscaInscricao, 'Digite seu e-mail ou o código da inscrição.');
      return;
    }

    const { campo, valor } = detectarTipoBusca(valorDigitado);

    btnBuscarInscricao.disabled = true;
    const textoOriginalBotao = btnBuscarInscricao.textContent;
    btnBuscarInscricao.textContent = 'Buscando...';

    try {
      // Por e-mail: uma mesma pessoa pode ter mais de uma inscrição
      // (ex.: comprou para si e depois para um familiar com o mesmo
      // e-mail de contato) — nesse caso, mostramos a mais recente.
      // Por código: o valor já é único por natureza, então "limit(1)"
      // aqui é só uma garantia extra, nunca deveria haver mais de um.
      const { data, error } = await window.supabaseClient
        .from('inscricoes')
        .select('*')
        .eq(campo, valor)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        mostrarErro(erroBuscaInscricao, obterMensagemErro(error, 'Não foi possível concluir a busca. Tente novamente.'));
        return;
      }

      if (!data) {
        mostrarEstadoConsulta(resultadoNaoEncontrado);
        return;
      }

      const primeiroNome = (data.nome_completo || '').split(' ')[0];
      const nomeComboExibicao = NOMES_COMBO[data.tipo_ingresso] || data.tipo_ingresso;

      if (data.status_pagamento === 'aprovado') {
        aprovadoNome.textContent = primeiroNome;
        aprovadoCombo.textContent = nomeComboExibicao;
        aprovadoCodigo.textContent = data.codigo_ingresso;
        gerarQrCodeConsulta(data.codigo_ingresso);
        mostrarEstadoConsulta(resultadoAprovado);
      } else if (data.status_pagamento === 'recusado') {
        recusadoNome.textContent = primeiroNome;
        recusadoCodigo.textContent = data.codigo_ingresso;
        mostrarEstadoConsulta(resultadoRecusado);
      } else {
        // Qualquer outro valor (na prática, "pendente") cai aqui.
        pendenteNome.textContent = primeiroNome;
        pendenteCombo.textContent = nomeComboExibicao;
        pendenteCodigo.textContent = data.codigo_ingresso;
        mostrarEstadoConsulta(resultadoPendente);
      }
    } catch (erro) {
      console.error('[inscricao.js] Erro ao buscar inscrição:', erro);
      mostrarErro(erroBuscaInscricao, obterMensagemErro(erro, 'Ocorreu um erro inesperado. Tente novamente.'));
    } finally {
      btnBuscarInscricao.disabled = false;
      btnBuscarInscricao.textContent = textoOriginalBotao;
    }
  }

  if (btnBuscarInscricao) {
    btnBuscarInscricao.addEventListener('click', buscarInscricao);
  }

  if (campoBuscaInscricao) {
    campoBuscaInscricao.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter') buscarInscricao();
    });
  }

  /* ----------------------------------------------------------
     11) ABERTURA DIRETA VIA #buscar (link "Já tenho inscrição"
         da Landing Page) — foca o campo de busca automaticamente
         para o usuário já poder digitar, sem precisar clicar.
     ---------------------------------------------------------- */

  if (window.location.hash === '#buscar' && campoBuscaInscricao) {
    campoBuscaInscricao.focus();
  }
});