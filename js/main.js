/* ============================================================
   js/main.js
   ------------------------------------------------------------
   Lógica da LANDING PAGE institucional (index.html):
     1) Contagem regressiva viva até o evento;
     2) Menu mobile (abre/fecha o menu em telas estreitas);
     3) Scroll Reveal — animação sutil de aparecimento (fade-in)
        das seções conforme o usuário rola a página, usando
        IntersectionObserver.
     4) Versículo João 8:36 — animação de digitação (typewriter),
        disparada uma única vez quando a seção entra na tela.

   O formulário de inscrição, a consulta por e-mail/código e a
   geração do QR code da credencial NÃO estão mais aqui — essa
   lógica foi para js/inscricao.js, que roda em inscricao.html.
   Este arquivo não depende do Supabase nem do QRCode.js.
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
     2) MENU MOBILE
     ---------------------------------------------------------- */

  const menuToggle = document.getElementById('menuToggle');
  const menuNav = document.getElementById('menuNav');

  function fecharMenuMobile() {
    if (!menuToggle || !menuNav) return;
    menuToggle.classList.remove('aberto');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuNav.classList.remove('aberto');
  }

  if (menuToggle && menuNav) {
    menuToggle.addEventListener('click', function () {
      const vaiAbrir = !menuNav.classList.contains('aberto');
      menuToggle.classList.toggle('aberto', vaiAbrir);
      menuToggle.setAttribute('aria-expanded', String(vaiAbrir));
      menuNav.classList.toggle('aberto', vaiAbrir);
    });

    // Clicar em qualquer link do menu (âncora da própria página ou
    // para inscricao.html) fecha o menu mobile antes de navegar —
    // evita que ele fique aberto "por cima" da próxima tela.
    menuNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', fecharMenuMobile);
    });

    // Se a pessoa girar o aparelho ou redimensionar a janela para o
    // layout desktop com o menu mobile aberto, fecha automaticamente
    // para não ficar um menu "solto" sobre o conteúdo.
    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) fecharMenuMobile();
    });
  }

  /* ----------------------------------------------------------
     3) SCROLL REVEAL (fade-in ao rolar a página)
     ---------------------------------------------------------- */

  // Cada elemento com a classe ".fade-in-section" começa "invisível"
  // (ver css/styles.css) e ganha a classe ".visivel" assim que entra
  // na área visível da tela — o CSS cuida da transição suave.
  const elementosParaRevelar = document.querySelectorAll('.fade-in-section');

  if (elementosParaRevelar.length > 0 && 'IntersectionObserver' in window) {
    const observadorRevelacao = new IntersectionObserver(
      function (entradas, observador) {
        entradas.forEach(function (entrada) {
          if (!entrada.isIntersecting) return;
          entrada.target.classList.add('visivel');
          // Revela uma vez só — depois de aparecer, não precisa mais
          // ser observado (evita custo desnecessário ao rolar).
          observador.unobserve(entrada.target);
        });
      },
      {
        threshold: 0.15,
        rootMargin: '0px 0px -60px 0px',
      }
    );

    elementosParaRevelar.forEach(function (elemento) {
      observadorRevelacao.observe(elemento);
    });
  } else {
    // Navegador sem suporte a IntersectionObserver (raro hoje em
    // dia): revela tudo de uma vez, para o conteúdo nunca ficar
    // preso em opacity:0 por falta de suporte da API.
    elementosParaRevelar.forEach(function (elemento) {
      elemento.classList.add('visivel');
    });
  }

  /* ----------------------------------------------------------
     4) VERSÍCULO — ANIMAÇÃO DE DIGITAÇÃO (typewriter)
     ---------------------------------------------------------- */

  // Como funciona (ver ".verse-*" em css/styles.css):
  //   • #versiculoTexto (fantasma) guarda o texto completo e reserva
  //     a altura final — é dele que o JS lê o texto a digitar;
  //   • na camada visível, o texto completo é dividido em duas partes:
  //     "digitado" (visível) + "resto" (transparente). Assim cada letra
  //     aparece exatamente onde ficará no final, sem deslocar linhas;
  //   • as classes "digitando", "concluido" e "cursor-fim" em #versiculo
  //     controlam cursor e referência (a animação em si está no CSS).
  const versiculo = document.getElementById('versiculo');
  const elVersiculoTexto = document.getElementById('versiculoTexto');
  const elVersiculoDigitado = document.getElementById('versiculoDigitado');
  const elVersiculoCursor = document.getElementById('versiculoCursor');

  if (versiculo && elVersiculoTexto && elVersiculoDigitado && elVersiculoCursor) {
    const textoVersiculo = elVersiculoTexto.textContent.trim();
    const letras = Array.from(textoVersiculo);

    // Cadência (milissegundos)
    const ATRASO_INICIAL = 400;   // cursor pisca um instante antes da 1ª letra
    const ATRASO_LETRA = 55;      // tempo médio entre letras
    const VARIACAO_LETRA = 30;    // sorteio de ±(metade) para soar humano
    const ATRASO_VIRGULA = 420;   // pausa depois de cada vírgula
    const CURSOR_APOS_FIM = 3000; // cursor segue piscando após terminar
    const DURACAO_FADE_CURSOR = 800; // igual a "verse-sumir" no CSS

    // Parte ainda não digitada: começa com o texto inteiro (invisível),
    // logo depois do cursor.
    const elResto = document.createElement('span');
    elResto.className = 'verse-resto';
    elResto.textContent = textoVersiculo;
    elVersiculoCursor.after(elResto);

    // Mostra o versículo completo de uma vez (sem animação).
    function mostrarVersiculoCompleto() {
      elVersiculoDigitado.textContent = textoVersiculo;
      elResto.textContent = '';
      versiculo.classList.add('concluido');
    }

    function digitarVersiculo() {
      versiculo.classList.add('digitando');
      let indice = 0;

      function proximaLetra() {
        indice += 1;
        elVersiculoDigitado.textContent = letras.slice(0, indice).join('');
        elResto.textContent = letras.slice(indice).join('');

        // Terminou: mostra a referência, deixa o cursor piscar mais
        // um pouco e depois o apaga com fade-out.
        if (indice >= letras.length) {
          versiculo.classList.add('concluido');
          setTimeout(function () {
            versiculo.classList.add('cursor-fim');
            setTimeout(function () {
              versiculo.classList.remove('digitando');
            }, DURACAO_FADE_CURSOR + 100);
          }, CURSOR_APOS_FIM);
          return;
        }

        // Atraso até a próxima letra: maior depois de vírgula.
        const ultima = letras[indice - 1];
        const atraso = ultima === ','
          ? ATRASO_VIRGULA
          : ATRASO_LETRA + (Math.random() - 0.5) * VARIACAO_LETRA;
        setTimeout(proximaLetra, atraso);
      }

      setTimeout(proximaLetra, ATRASO_INICIAL);
    }

    const prefereMenosMovimento =
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefereMenosMovimento) {
      // Quem pediu menos movimento vê o versículo pronto.
      mostrarVersiculoCompleto();
    } else if ('IntersectionObserver' in window) {
      // Gatilho de scroll: começa quando o versículo entra na tela,
      // uma única vez (o observador se desliga logo em seguida).
      const observadorVersiculo = new IntersectionObserver(
        function (entradas, observador) {
          entradas.forEach(function (entrada) {
            if (!entrada.isIntersecting) return;
            observador.disconnect();
            digitarVersiculo();
          });
        },
        {
          threshold: 0.5,
          rootMargin: '0px 0px -60px 0px',
        }
      );
      observadorVersiculo.observe(versiculo);
    } else {
      // Navegador sem IntersectionObserver: mostra tudo de uma vez.
      mostrarVersiculoCompleto();
    }
  }
});
