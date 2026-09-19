/* ============================================================
   js/inscricao.js
   ------------------------------------------------------------
   Lógica do PORTAL DE INSCRIÇÃO (inscricao.html):
     1) Seleção de ingresso (Sexta / Sábado / Combo), com preço e
        chave Pix por tipo de ingresso atualizados dinamicamente a
        partir do lote ativo (tabela "lotes" do Supabase);
     2) Máscara de telefone e validação do formulário;
     3) Botão "Copiar Chave Pix";
     4) Checagem de inscrição duplicada (mesmo nome + e-mail);
     5) PIN de segurança de 4 dígitos: máscara, dupla validação no
        Passo 2 (precisa bater com a confirmação) e envio junto com
        a inscrição, mapeado para a coluna "pin_seguranca";
     6) Upload do comprovante de Pix para o Supabase Storage;
     7) Geração do código único do ingresso e INSERT na tabela
        "inscricoes" do Supabase (incluindo o PIN e o tipo de
        ingresso normalizado/validado);
     8) Tela de sucesso com status "Aguardando Validação do Pix" e
        exibição do PIN cadastrado.

   Depende de:
     - js/supabase-client.js (expõe window.supabaseClient e
       window.SUPABASE_COMPROVANTES_BUCKET), carregado ANTES
       deste arquivo.

   A contagem regressiva, o menu mobile e o scroll reveal da
   Landing Page NÃO estão mais aqui — ver js/main.js. A consulta de
   credencial (busca por e-mail/PIN, QR code, download em PNG)
   também NÃO está mais aqui — foi para js/buscar.js, que roda em
   buscar.html. Este arquivo não depende do QRCode.js.

   Nenhuma troca de passo/tela neste arquivo dispara rolagem
   automática (scrollIntoView) nem depende de âncoras "#" — a
   navegação entre Passo 1 → 2 → 3 é feita só alternando
   display:block/none, sem mover o scroll do usuário.
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
  const chavePixTextoEl = document.getElementById('chavePixTexto');

  // Estado da inscrição em andamento. É atualizado conforme o
  // usuário navega pelos passos do formulário.
  const estadoInscricao = {
    tipoIngresso: 'COMBO',
    valor: 25.0,
  };

  // Chave Pix de cada tipo de ingresso, preenchida pelo
  // carregarLoteAtivo() (seção 1.1) assim que a resposta do Supabase
  // chega. Começa vazio de propósito: enquanto isso não acontece,
  // selecionarCombo() simplesmente não mexe no texto da chave Pix,
  // mantendo o valor estático do HTML até o lote carregar.
  let chavesPixPorCombo = {};

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
  // ao aplicar os preços do lote (1.1) quanto ao sincronizar o
  // estado antes do resumo/confirmação (seções 5 e 8).
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

    // Troca a chave Pix exibida conforme o ingresso escolhido — cada
    // tipo tem sua própria chave (chave_pix_sexta/sabado/combo). Só
    // atualiza quando já tivermos essa informação do lote ativo;
    // antes disso, o texto estático do HTML permanece.
    const chavePixDoCombo = chavesPixPorCombo[estadoInscricao.tipoIngresso];
    if (chavePixTextoEl && chavePixDoCombo) {
      chavePixTextoEl.textContent = chavePixDoCombo;
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
     1.1) LOTE ATIVO: preços e chaves Pix (uma por tipo) vindos
          do Supabase
     ---------------------------------------------------------- */

  // Atualiza UM card: o atributo data-preco (fonte de verdade para o
  // JS) e o texto visível dentro de .preco. O <small>/pessoa</small>
  // é reconstruído junto para não se perder ao trocar o conteúdo.
  function aplicarPrecoNoCard(comboEl, preco) {
    const valor = lerValorNumerico(preco);
    if (isNaN(valor)) return false;

    comboEl.setAttribute('data-preco', valor.toFixed(2));
    const precoEl = comboEl.querySelector('.preco');
    if (precoEl) {
      precoEl.innerHTML = formatarMoeda(valor) + '<small>/pessoa</small>';
    }
    return true;
  }

  // Cada tipo de ingresso tem sua PRÓPRIA coluna de preço E de chave
  // Pix na tabela "lotes" — não existe uma "chave_pix" genérica.
  const MAPA_CARDS_LOTE = {
    SEXTA: { seletor: '.combo[data-id="SEXTA"]', colunaPreco: 'preco_sexta', colunaPix: 'chave_pix_sexta' },
    SABADO: { seletor: '.combo[data-id="SABADO"]', colunaPreco: 'preco_sabado', colunaPix: 'chave_pix_sabado' },
    COMBO: { seletor: '.combo[data-id="COMBO"]', colunaPreco: 'preco_combo', colunaPix: 'chave_pix_combo' },
  };

  async function carregarLoteAtivo() {
    if (!window.supabaseClient) {
      console.error('[inscricao.js] carregarLoteAtivo: window.supabaseClient não existe ainda — verifique a ordem dos <script> no HTML.');
      return;
    }

    const { data, error } = await window.supabaseClient
      .from('lotes')
      .select('preco_sexta, preco_sabado, preco_combo, chave_pix_sexta, chave_pix_sabado, chave_pix_combo')
      .eq('ativo', true)
      .limit(1)
      .maybeSingle();

    // Diagnóstico: mostra exatamente o que o Supabase devolveu, para
    // facilitar identificar RLS bloqueando SELECT, ausência de lote
    // ativo, ou nome de coluna incorreto sem precisar depurar às
    // cegas.
    console.log('[inscricao.js] carregarLoteAtivo -> resposta do Supabase:', { data, error });

    if (error) {
      console.error(
        '[inscricao.js] Erro ao consultar a tabela "lotes" (provável causa: RLS bloqueando SELECT para o papel "anon"). Detalhe:',
        error.message || error
      );
      return;
    }
    if (!data) {
      console.warn('[inscricao.js] Nenhuma linha em "lotes" com ativo = true. Confira no painel do Supabase se existe um lote marcado como ativo.');
      return;
    }

    Object.keys(MAPA_CARDS_LOTE).forEach(function (idCombo) {
      const { seletor, colunaPreco, colunaPix } = MAPA_CARDS_LOTE[idCombo];
      const comboEl = document.querySelector(seletor);

      if (!comboEl) {
        console.error('[inscricao.js] Card não encontrado no DOM para o seletor:', seletor);
        return;
      }

      const precoAplicado = aplicarPrecoNoCard(comboEl, data[colunaPreco]);
      if (!precoAplicado) {
        console.error(
          '[inscricao.js] Coluna "' + colunaPreco + '" veio inválida/ausente para o card ' + idCombo + ':',
          JSON.stringify(data[colunaPreco])
        );
      }

      const chavePixDoCard = data[colunaPix];
      if (chavePixDoCard) {
        chavesPixPorCombo[idCombo] = chavePixDoCard;
      } else {
        console.warn(
          '[inscricao.js] Coluna "' + colunaPix + '" veio vazia/nula para o card ' + idCombo +
          ' — mantendo a chave Pix estática do HTML para esse ingresso.'
        );
      }
    });

    // Re-seleciona o card já marcado: agora que chavesPixPorCombo e
    // os data-preco foram atualizados, isso aplica de uma vez o
    // preço, o #totalValor e a chave Pix corretos do lote (a seleção
    // inicial, lá em cima, rodou antes desta consulta terminar).
    const comboSelecionado = document.querySelector('#combos .combo[data-selected="true"]') || comboInicial;
    if (comboSelecionado) {
      selecionarCombo(comboSelecionado);
    }
  }

  carregarLoteAtivo();

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

  // Campos do PIN de segurança de 4 dígitos, preenchidos no Passo 2
  // (tela de resumo) junto com a confirmação da inscrição.
  const campoPin = document.getElementById('campoPin');
  const campoPinConfirma = document.getElementById('campoPinConfirma');

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
  const pinSucesso = document.getElementById('pinSucesso');

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
     3.1) MÁSCARA DO PIN DE SEGURANÇA (4 dígitos numéricos)
     ---------------------------------------------------------- */

  // Mesmo princípio da máscara de telefone: descarta qualquer
  // caractere que não seja dígito e trava em 4 posições, nos dois
  // campos (PIN e confirmação), para o usuário nunca conseguir
  // digitar letra ou um PIN maior que o esperado.
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

  // Relê o card marcado como selecionado na hora de montar o resumo
  // (ou de confirmar, na seção 8), em vez de confiar apenas no
  // estadoInscricao já guardado. Isso cobre o caso em que os preços
  // do lote (seção 1.1) chegaram do Supabase depois da seleção
  // inicial, e garante que #resumoValorTxt e valor_pago usem
  // exatamente o mesmo número exibido no card. Cascata de segurança
  // no valor: preço do card → último valor válido já guardado no
  // estado → 0. Nunca deixa NaN chegar na tela nem no banco.
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

  if (btnIrPagamento) {
    btnIrPagamento.addEventListener('click', function () {
      if (!validarPasso1()) return;

      // Garante que tipo e valor estão alinhados com o card visível
      // antes de escrever qualquer coisa no resumo.
      sincronizarEstadoComCardSelecionado();

      const arquivoComprovante = campoComprovante.files[0];

      // Preenche o resumo com os dados já validados.
      resumoNomeTxt.textContent = campoNome.value.trim();
      resumoComboTxt.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso || '—';
      resumoComprovanteTxt.textContent = arquivoComprovante ? arquivoComprovante.name : 'anexado';
      resumoValorTxt.textContent = formatarMoeda(estadoInscricao.valor);

      esconderTodasAsTelas();
      telaResumo.style.display = 'block';
      // Sem scrollIntoView: a troca de passo só alterna qual card
      // está visível, mantendo a posição de rolagem do usuário.
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
     7.1) PIN DE SEGURANÇA: dupla validação (Passo 2)
     ---------------------------------------------------------- */

  // Confere se o PIN tem exatamente 4 dígitos numéricos e se os
  // dois campos (PIN e confirmação) são idênticos. Retorna o PIN
  // validado (string) em caso de sucesso, ou null se houver erro —
  // já mostrando a mensagem correspondente em #erroResumo e focando
  // o campo problemático, para o botão "Confirmar inscrição" poder
  // simplesmente checar "if (!pin) return;".
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
     7.2) TIPO DE INGRESSO: normalização antes do INSERT
     ---------------------------------------------------------- */

  // Os únicos valores que a coluna "tipo_ingresso" aceita no banco.
  const TIPOS_INGRESSO_VALIDOS = ['SEXTA', 'SABADO', 'COMBO'];

  // Normaliza o tipo antes de gravar: tira espaços, força maiúsculas
  // e confere contra a lista acima. Devolve null se o valor não for
  // um dos três — assim a inscrição é abortada com uma mensagem
  // clara em vez de estourar um erro de constraint do Postgres.
  function normalizarTipoIngresso(valorBruto) {
    const tipo = String(valorBruto || '').trim().toUpperCase();
    return TIPOS_INGRESSO_VALIDOS.includes(tipo) ? tipo : null;
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

      esconderErro(erroResumo);

      // Valida o PIN ANTES de desabilitar o botão/travar a tela: se
      // estiver errado, a pessoa corrige e clica de novo sem nenhum
      // upload ou chamada ao Supabase ter sido feita.
      const pinValidado = validarPin();
      if (!pinValidado) return;

      // Relê o card selecionado uma última vez, já que o usuário
      // pode ter voltado ao Passo 1 e trocado de ingresso antes de
      // confirmar. Garante que tipo e valor gravados são os mesmos
      // que ele acabou de ver no resumo.
      sincronizarEstadoComCardSelecionado();

      const tipoIngressoValidado = normalizarTipoIngresso(estadoInscricao.tipoIngresso);
      if (!tipoIngressoValidado) {
        console.error(
          '[inscricao.js] tipo_ingresso inválido no momento do INSERT:',
          estadoInscricao.tipoIngresso
        );
        mostrarErro(erroResumo, 'Não foi possível identificar o ingresso selecionado. Volte e escolha a opção novamente.');
        return;
      }

      btnConfirmarInscricao.disabled = true;
      const textoOriginalBotao = btnConfirmarInscricao.textContent;

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
          tipo_ingresso: tipoIngressoValidado,
          valor_pago: Number(estadoInscricao.valor),
          status_pagamento: 'pendente',
          checkin_realizado: false,
          comprovante_url: urlComprovante,
          pin_seguranca: pinValidado,
        };

        const inscricaoCriada = await inserirInscricaoComRetentativa(dadosInscricao, 5);

        // IMPORTANTE: exibe o PIN que VOLTOU do banco
        // (inscricaoCriada.pin_seguranca), não o valor digitado no
        // formulário. Mostrar sempre "pinValidado" aqui mascararia
        // silenciosamente qualquer problema de gravação — a pessoa
        // veria o PIN certo na tela mesmo que, por algum motivo do
        // lado do banco (RLS, trigger, nome de coluna), o valor
        // salvo tivesse ficado null. Registrar essa divergência no
        // console também ajuda a equipe a flagrar o problema cedo.
        if (inscricaoCriada.pin_seguranca !== pinValidado) {
          console.error(
            '[inscricao.js] PIN divergente após salvar a inscrição — enviado:',
            pinValidado,
            '| retornado pelo Supabase:',
            inscricaoCriada.pin_seguranca
          );
        }

        // Mesma checagem de divergência, agora para o tipo de
        // ingresso — uma discrepância aqui apontaria para algo do
        // lado do banco (trigger, default, RLS), não do formulário.
        if (inscricaoCriada.tipo_ingresso !== tipoIngressoValidado) {
          console.error(
            '[inscricao.js] tipo_ingresso divergente após salvar — enviado:',
            tipoIngressoValidado,
            '| retornado pelo Supabase:',
            inscricaoCriada.tipo_ingresso
          );
        }

        // Preenche e exibe a tela de sucesso. O pagamento ainda
        // depende de conferência manual, então nenhum QR code é
        // gerado aqui — só o código em texto e o PIN cadastrado,
        // como referência.
        nomeSucesso.textContent = nomeCompleto.split(' ')[0];
        comboSucesso.textContent = NOMES_COMBO[estadoInscricao.tipoIngresso] || estadoInscricao.tipoIngresso;
        codigoSucesso.textContent = inscricaoCriada.codigo_ingresso;
        if (pinSucesso) pinSucesso.textContent = inscricaoCriada.pin_seguranca;

        esconderTodasAsTelas();
        telaSucesso.style.display = 'block';
        // Sem scrollIntoView: mantém a posição de rolagem do
        // usuário ao trocar para a tela de sucesso.
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
      if (campoPin) campoPin.value = '';
      if (campoPinConfirma) campoPinConfirma.value = '';
      esconderErro(erroInscricao);
      esconderErro(erroComprovante);
      esconderErro(erroResumo);

      selecionarCombo(comboInicial || listaCombos[0]);

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
      // Sem scrollIntoView: volta para o Passo 1 sem forçar rolagem.
    });
  }
});
