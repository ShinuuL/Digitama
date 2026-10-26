---
name: sprite-motion
description: Como deixar sprites parados (Digimon World DS, ReArise) fluidos e atuais no Digitama — app Tauri e extensão do VS Code. Use ao criar ou ajustar animações do pet, efeitos (evolução, batalha, comer, sono), partículas ou o processamento de sprites (fundo, recorte, escala, silhueta).
---

# Sprites fluidos no Digitama

Os sprites reais são quadros parados (idle/attack/hit). A sensação de animação
moderna vem de **movimento procedural por cima do pixel art**, nunca de
redesenhar ou interpolar os pixels.

## Pipeline do sprite
1. Fundo sólido → transparente usando a cor do pixel (0,0) só se ele for opaco.
2. Recorte pelo alfa (> 16) para a caixa justa.
3. Silhueta branca (e vermelha, para dano) com `source-in`.
4. Escala **inteira em pixels do dispositivo**: `r = alvo*dpr/h`;
   `k = (r >= 1 ? round(r) : 1/round(1/r)) / dpr`. Nunca escala fracionária
   (pixels desiguais) e sempre `imageSmoothingEnabled = false`.
5. Os sprites do DS olham para a **esquerda**; a orientação é `scale(-face)`.

## Movimento (o que dá a fluidez)
- **Molas** em vez de tweens fixos: `a = -k(x-alvo) - d·v` (k≈180, d≈14).
  Use para esticar/achatar (`sx`, `sy`) e para virar (`face` de -1 a 1 passa
  pelo zero, piso de 0.08 para não sumir).
- **Antecipação e pouso**: antes do pulo `sy=0.78, sx=1.18`; no pouso com
  velocidade alta `sy=0.8, sx=1.2` + poeira. As molas devolvem a 1.
- **Respiração**: `sy *= 1 + sin(t·2.6)·0.022`, `sx` compensa (volume
  constante). Dormindo: mais lenta e mais funda.
- **Caminhada**: saltinho de 55 px/s a cada pico de `sin(passo·π)`, balanço
  em `sx/sy`. Sombra elíptica encolhe com a altura.
- **Passos no app** (`src/pet/walk.ts`): os pés são ilhas de pixels na faixa
  de baixo do sprite e só são *deslocados* (8 quadros); nada é redesenhado.
  Um quadro que deixe menos de 95% do desenho visível e intacto é recusado
  (regra do usuário). Confira com `node scripts/check-walk.mjs`.
- **Artes nossas** (efeitos, rachaduras do ovo, bola de fogo, explosão): a
  fonte é `art/fx/*.aseprite`, com a paleta fixa k/w/x/y; depois de editar no
  Aseprite, `node scripts/export-art.mjs` gera `src/pet/art.gen.ts`.
- **Ícones** (16×16, `art/icons/`) e **fonte** (`art/font/`, `scripts/build-font.py`)
  seguem o mesmo padrão: contorno escuro, sombra embaixo/à direita, luz de
  cima à esquerda. A fonte só fica nítida em 8, 16, 24 px.
- **Miniaturas** (`drawMonFit`): nunca escala abaixo de 1×; o que não cabe vira
  retrato pelo rosto (`PACK_INFO[id].head`).
- **Evolução**: alterna silhuetas brancas do antigo/novo com frequência
  `2 + t²·3`, halo radial crescente, estouro de brilhos e pulo no fim (~3 s).
- **Dano**: flash da silhueta branca (decai 2/s) + tremor de tela.
- Partículas com vida curta (0,8–1,4 s), alfa caindo, gravidade só em
  poeira/migalhas. Corações, z, gotas, brilhos de 4 pontas.

## Regras
- Tudo depende de `dt`, nada de quadros fixos. O pet desenha a 8–30 fps
  (ritmo adaptativo em `src/pet/main.ts`), então o `dt` vai até 250 ms; na
  extensão do VS Code, 50 ms.
- Sprites do DS nunca são alterados: só deslocados, espelhados ou cobertos
  por silhueta/efeito.
- Respeite `prefers-reduced-motion` na interface (CSS); no canvas, reduza
  amplitudes se precisar.
- Sem sprite: desenho de reserva em código (blob com olhos que piscam, ovo
  que balança mais conforme se aproxima de chocar).
- Sprites nunca entram no repositório (ver CLAUDE.md).

Referência viva: `Pendulum/vscode-ext/media/main.js` (outro repositório) e `src/pet/render.ts`.
