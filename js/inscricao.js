/* ============================================================
   js/inscricao.js - Unificado e Corrigido
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // ==========================================
  // ESTADO GLOBAL DA INSCRIÇÃO
  // ==========================================
  let loteAtivoAtual = null;
  let opcaoSelecionada = 'combo'; // 'sexta', 'sabado' ou 'combo'

  const NOMES_OPCAO = {
    sexta: 'Sexta-feira (30/10)',
    sabado: 'Sábado (31/10)',
    combo: 'Sexta + Sábado'
  };

  // Elementos das telas
  const telaForm = document.getElementById('formInscricao');
  const telaResumo = document.getElementById('resumoPedido');
  const telaSucesso = document.getElementById('telaSucesso');

  // Campos do Formulário
  const campoNome = document.getElementById('campoNome');
  const campoEmail = document.getElementById('campoEmail');
  const campoTelefone = document.getElementById('campoTelefone');
  const campoComprovante = document.getElementById('campoComprovante');

  // PIN
  const campoPin = document.getElementById('campoPin');
  const campoPinConfirma = document.getElementById('campoPinConfirma');

  // Erros e Botões
  const erroInscricao = document.getElementById('erroInscricao');
  const erroComprovante = document.getElementById('erroComprovante');
  const erroResumo = document.getElementById('erroResumo');

  const btnIrPagamento = document.getElementById('btnIrPagamento');
  const btnVoltarResumo = document.getElementById('btnVoltarResumo');
  const btnConfirmarInscricao = document.getElementById('btnConfirmarInscricao');
  const btnNovaInscricao = document.getElementById('btnNovaInscricao');

  // Resumo (Passo 2)
  const resumoNomeTxt = document.getElementById('resumoNomeTxt');
  const resumoComboTxt = document.getElementById('resumoComboTxt');
  const resumoComprovanteTxt = document.getElementById('resumoComprovanteTxt');
  const resumoValorTxt = document.getElementById('resumoValorTxt');

  // Sucesso (Passo 3)
  const nomeSucesso = document.getElementById('nomeSucesso');
  const comboSucesso = document.getElementById('comboSucesso');
  const codigoSucesso = document.getElementById('codigoSucesso');
  const pinSucesso = document.getElementById('pinSucesso');

  const TAMANHO_MAXIMO_ARQUIVO = 5 * 1024 * 1024;
  const TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

  function formatarMoeda(valor) {
    return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function esconderTodasAsTelas() {
    if (telaForm) telaForm.style.display = 'none';
    if (telaResumo) telaResumo.style.display = 'none';
    if (telaSucesso) telaSucesso.style.display = 'none';
  }

  function mostrarErro(elemento, msg) {
    if (!elemento) return;
    elemento.textContent = msg;
    elemento.style.display = 'block';
  }

  function esconderErro(elemento) {
    if (!elemento) return;
    elemento.style.display = 'none';
    elemento.textContent = '';
  }

  // ==========================================
  // 1. CARREGAR LOTE ATIVO DO SUPABASE
  // ==========================================
  async function carregarLoteAtivo() {
    try {
      const { data: lote, error } = await window.supabaseClient
        .from('lotes')
        .select('*')
        .eq('ativo', true)
        .single();

      const containerPix = document.getElementById('containerPix');
      const msgEsgotado = document.getElementById('mensagemEsgotado');

      if (error || !lote) {
        console.warn('Nenhum lote ativo encontrado:', error);
        if (containerPix) containerPix.style.display = 'none';
        if (msgEsgotado) msgEsgotado.style.display = 'block';
        return;
      }

      loteAtivoAtual = lote;

      const elNome = document.getElementById('nomeLoteExibicao');
      if (elNome) elNome.textContent = lote.nome;

      const cardSelecionado = document.querySelector('.combo.selecionado') || document.querySelector('.combo');
      const tipoInicial = cardSelecionado ? cardSelecionado.getAttribute('data-tipo') : 'combo';

      atualizarDetalhesIngresso(tipoInicial);
      configurarSelecaoDeCombos();

    } catch (err) {
      console.error('Erro ao carregar lote ativo:', err);
    }
  }

  function obterValorAtual() {
    if (!loteAtivoAtual) return 25.0;
    if (opcaoSelecionada === 'sexta') return parseFloat(loteAtivoAtual.preco_sexta ?? loteAtivoAtual.preco_combo ?? 0);
    if (opcaoSelecionada === 'sabado') return parseFloat(loteAtivoAtual.preco_sabado ?? loteAtivoAtual.preco_combo ?? 0);
    return parseFloat(loteAtivoAtual.preco_combo ?? 0);
  }

  function atualizarDetalhesIngresso(tipo) {
    opcaoSelecionada = tipo || 'combo';
    const valor = obterValorAtual();

    let chavePix = '';
    if (loteAtivoAtual) {
      if (opcaoSelecionada === 'sexta') chavePix = loteAtivoAtual.chave_pix_sexta || loteAtivoAtual.chave_pix_combo;
      else if (opcaoSelecionada === 'sabado') chavePix = loteAtivoAtual.chave_pix_sabado || loteAtivoAtual.chave_pix_combo;
      else chavePix = loteAtivoAtual.chave_pix_combo;
    }

    const totalValorEl = document.getElementById('totalValor');
    if (totalValorEl) totalValorEl.textContent = formatarMoeda(valor);

    const elPix = document.getElementById('chavePixTexto');
    if (elPix && chavePix) elPix.textContent = chavePix;
  }

  function configurarSelecaoDeCombos() {
    const combos = document.querySelectorAll('.combo');
    combos.forEach(combo => {
      combo.addEventListener('click', () => {
        combos.forEach(c => c.classList.remove('selecionado'));
        combo.add
        combo.classList.add('selecionado');
        atualizarDetalhesIngresso(combo.getAttribute('data-tipo'));
      });
    });
  }

  // ==========================================
  // 2. MÁSCARAS E VALIDAÇÕES
  // ==========================================
  if (campoTelefone) {
    campoTelefone.addEventListener('input', function (e) {
      let digitos = e.target.value.replace(/\D/g, '').slice(0, 11);
      if (digitos.length <= 2) e.target.value = digitos ? '(' + digitos : '';
      else if (digitos.length <= 6) e.target.value = '(' + digitos.slice(0, 2) + ') ' + digitos.slice(2);
      else if (digitos.length <= 10) e.target.value = '(' + digitos.slice(0, 2) + ') ' + digitos.slice(2, 6) + '-' + digitos.slice(6);
      else e.target.value = '(' + digitos.slice(0, 2) + ') ' + digitos.slice(2, 7) + '-' + digitos.slice(7);
    });
  }

  [campoPin, campoPinConfirma].forEach(campo => {
    if (campo) {
      campo.addEventListener('input', e => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
      });
    }
  });

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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      mostrarErro(erroInscricao, 'Informe um e-mail válido.');
      campoEmail.focus();
      return false;
    }

    if (telefone.replace(/\D/g, '').length < 10) {
      mostrarErro(erroInscricao, 'Informe um telefone válido com DDD.');
      campoTelefone.focus();
      return false;
    }

    if (!arquivo) {
      mostrarErro(erroComprovante, 'Anexe o comprovante do Pix para continuar.');
      return false;
    }

    if (!TIPOS_ACEITOS.includes(arquivo.type)) {
      mostrarErro(erroComprovante, 'Formato inválido. Envie imagem (PNG/JPG) ou PDF.');
      return false;
    }

    if (arquivo.size > TAMANHO_MAXIMO_ARQUIVO) {
      mostrarErro(erroComprovante, 'O arquivo deve ter até 5 MB.');
      return false;
    }

    return true;
  }

  function validarPin() {
    const pin = campoPin ? campoPin.value.trim() : '';
    const pinConfirma = campoPinConfirma ? campoPinConfirma.value.trim() : '';

    if (!/^\d{4}$/.test(pin)) {
      mostrarErro(erroResumo, 'Crie um PIN de segurança com exatamente 4 números.');
      if (campoPin) campoPin.focus();
      return null;
    }

    if (pin !== pinConfirma) {
      mostrarErro(erroResumo, 'Os dois PINs digitados não coincidem.');
      if (campoPinConfirma) campoPinConfirma.focus();
      return null;
    }

    return pin;
  }

  // ==========================================
  // 3. TRANSIÇÃO DE PASSOS
  // ==========================================
  if (btnIrPagamento) {
    btnIrPagamento.addEventListener('click', function () {
      if (!validarPasso1()) return;

      // Preenche o resumo no Passo 2
      if (resumoNomeTxt) resumoNomeTxt.textContent = campoNome.value.trim();
      if (resumoComboTxt) resumoComboTxt.textContent = NOMES_OPCAO[opcaoSelecionada] || opcaoSelecionada;
      if (resumoComprovanteTxt) resumoComprovanteTxt.textContent = campoComprovante.files[0].name;
      if (resumoValorTxt) resumoValorTxt.textContent = formatarMoeda(obterValorAtual());

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

  // ==========================================
  // 4. ENVIO FINAL PARA O SUPABASE
  // ==========================================
  function gerarCodigoIngresso() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let sufixo = '';
    for (let i = 0; i < 6; i++) sufixo += chars[Math.floor(Math.random() * chars.length)];
    return 'FC2026-' + sufixo;
  }

  async function enviarComprovante(arquivo) {
    const ext = arquivo.name.split('.').pop().toLowerCase();
    const nomeArquivo = `comprovante_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;

    const { error } = await window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .upload(nomeArquivo, arquivo, { cacheControl: '3600', upsert: true });

    if (error) throw new Error('Falha ao enviar comprovante: ' + error.message);

    return window.supabaseClient.storage
      .from(window.SUPABASE_COMPROVANTES_BUCKET)
      .getPublicUrl(nomeArquivo).data.publicUrl;
  }

  if (btnConfirmarInscricao) {
    btnConfirmarInscricao.addEventListener('click', async function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (btnConfirmarInscricao.disabled) return;

      esconderErro(erroResumo);
      const pinValidado = validarPin();
      if (!pinValidado) return;

      btnConfirmarInscricao.disabled = true;
      btnConfirmarInscricao.textContent = 'Enviando...';

      try {
        const arquivo = campoComprovante.files[0];
        const urlComprovante = await enviarComprovante(arquivo);

        const dadosInscricao = {
          nome_completo: campoNome.value.trim(),
          email: campoEmail.value.trim(),
          telefone: campoTelefone.value.trim(),
          tipo_ingresso: opcaoSelecionada, // <-- Envia exatamente 'sexta', 'sabado' ou 'combo'
          valor_pago: obterValorAtual(),
          status_pagamento: 'pendente',
          checkin_realizado: false,
          comprovante_url: urlComprovante,
          pin_seguranca: pinValidado,
          codigo_ingresso: gerarCodigoIngresso(),
          lote_id: loteAtivoAtual ? loteAtivoAtual.id : null
        };

        const { data, error } = await window.supabaseClient
          .from('inscricoes')
          .insert([dadosInscricao])
          .select()
          .single();

        if (error) throw new Error('Falha ao salvar inscrição: ' + error.message);

        // Preenche tela de sucesso
        if (nomeSucesso) nomeSucesso.textContent = dadosInscricao.nome_completo.split(' ')[0];
        if (comboSucesso) comboSucesso.textContent = NOMES_OPCAO[opcaoSelecionada] || opcaoSelecionada;
        if (codigoSucesso) codigoSucesso.textContent = data.codigo_ingresso;
        if (pinSucesso) pinSucesso.textContent = data.pin_seguranca;

        esconderTodasAsTelas();
        telaSucesso.style.display = 'block';

      } catch (err) {
        console.error('Erro no processo de inscrição:', err);
        mostrarErro(erroResumo, err.message || 'Erro ao processar inscrição.');
      } finally {
        btnConfirmarInscricao.disabled = false;
        btnConfirmarInscricao.textContent = '💠 Confirmar inscrição';
      }
    });
  }

  if (btnNovaInscricao) {
    btnNovaInscricao.addEventListener('click', function () {
      campoNome.value = '';
      campoEmail.value = '';
      campoTelefone.value = '';
      campoComprovante.value = '';
      if (campoPin) campoPin.value = '';
      if (campoPinConfirma) campoPinConfirma.value = '';

      esconderTodasAsTelas();
      telaForm.style.display = 'block';
    });
  }

  // ==========================================
  // INICIALIZAÇÃO
  // ==========================================
  carregarLoteAtivo();
});
