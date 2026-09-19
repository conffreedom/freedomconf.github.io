  /* ----------------------------------------------------------
     1.1) LOTE ATIVO: preços e chaves Pix (uma por tipo) vindos
          do Supabase
     ---------------------------------------------------------- */

  function lerValorNumerico(valorBruto) {
    if (valorBruto === null || valorBruto === undefined) return NaN;
    const texto = String(valorBruto).trim().replace(',', '.');
    if (texto === '') return NaN;
    const numero = Number(texto);
    return isFinite(numero) ? numero : NaN;
  }

  // Atualiza UM card: o atributo data-preco (fonte de verdade para o
  // JS) e o texto visível dentro de .preco.
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
      console.error('[inscricao.js] carregarLoteAtivo: window.supabaseClient não existe ainda.');
      return;
    }

    const { data, error } = await window.supabaseClient
      .from('lotes')
      .select('preco_sexta, preco_sabado, preco_combo, chave_pix_sexta, chave_pix_sabado, chave_pix_combo')
      .eq('ativo', true)
      .limit(1)
      .maybeSingle();

    console.log('[inscricao.js] carregarLoteAtivo -> resposta do Supabase:', { data, error });

    if (error) {
      console.error('[inscricao.js] Erro ao consultar a tabela "lotes":', error.message || error);
      return;
    }
    if (!data) {
      console.warn('[inscricao.js] Nenhuma linha em "lotes" com ativo = true.');
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
    // preço, o #totalValor e a chave Pix corretos do lote.
    const comboSelecionado = document.querySelector('#combos .combo[data-selected="true"]') || comboInicial;
    if (comboSelecionado) {
      selecionarCombo(comboSelecionado);
    }
  }

  carregarLoteAtivo();
