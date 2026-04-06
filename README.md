<h1 align="center">
  ✋ Air Canvas
</h1>

<p align="center">
  Desenhe no ar com as mãos — sem tocar em nada.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/MediaPipe-Hand%20Landmarker-FF6F00?style=flat-square&logo=google&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind%20CSS-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" />
</p>

---

## Sobre o projeto

**Air Canvas** é uma aplicação de desenho controlada por gestos, onde a câmera do computador é usada como entrada. O MediaPipe detecta os landmarks da mão em tempo real e traduz os movimentos do indicador em traços suaves na tela — sem mouse, sem toque.

O projeto suporta **duas mãos simultaneamente**, partículas visuais ao desenhar, efeito de brilho (glow) nos traços e um sistema de gesto para limpar a tela com uma palma.

---

## Funcionalidades

| Gesto / Controle | Ação |
|---|---|
| Indicador levantado | Desenhar |
| Indicador + médio levantados | Pausar traço (mover sem desenhar) |
| Palmas juntas (clap) | Limpar tela |
| `Ctrl + Z` | Desfazer último traço |
| `Ctrl + S` | Salvar canvas como PNG |

- **8 cores** selecionáveis com preview em tempo real  
- **Espessura** do pincel ajustável (2–30 px)  
- **Escurecimento** da câmera (0–100%) para melhor contraste  
- **Partículas** animadas com gravidade ao traçar  
- **Zona segura** visual — indica onde os traços são registrados  
- Export PNG com fundo preto e espelhamento corrigido  

---

## Stack

- **React 19** + **TypeScript 5.9**
- **MediaPipe Tasks Vision** — detecção de 21 landmarks por mão, modo vídeo a 60 fps
- **Tailwind CSS 4** — estilização utilitária
- **Vite 8** — bundler e dev server
- Canvas 2D API — renderização de traços com suavização por média móvel (Bézier incremental)

---

## Como rodar

**Pré-requisito:** Node.js 18+ e câmera disponível no navegador.

```bash
# Clonar o repositório
git clone https://github.com/LuisGuilhermeRampaso/HandDrawingV.2.git
cd HandDrawingV.2

# Instalar dependências
npm install

# Iniciar em modo desenvolvimento
npm run dev
```

Abra `http://localhost:5173` e permita o acesso à câmera quando solicitado.

> O modelo de hand landmark do MediaPipe é carregado remotamente na primeira execução (~10 MB). Após o carregamento, o rastreamento ocorre inteiramente no browser via WebAssembly + GPU.

---

## Build para produção

```bash
npm run build
npm run preview
```

---

## Arquitetura

```
src/
├── components/
│   └── AirCanvas.tsx        # Componente principal — câmera, canvas, UI
├── hooks/
│   └── useHandTracker.ts    # Inicialização do MediaPipe e loop de detecção
└── utils/
    └── drawingLogic.ts      # Suavização de traços, Bézier, replay de histórico
```

- **`useHandTracker`** — encapsula a inicialização do `HandLandmarker`, o acesso à câmera e o `requestAnimationFrame` loop de 60 fps.
- **`drawingLogic`** — `MovingAverage` para suavizar a posição do indicador; `drawIncrementalSmoothStroke` para renderização incremental com curvas Bézier; `replayStroke` para redesenhar o histórico após undo.
- **`AirCanvas`** — gerencia estado de múltiplas mãos, detecção de clap (distância entre pulsos), partículas, zona segura dinâmica e export de imagem.

---

## Licença

MIT © [Luis Guilherme Rampaso](https://github.com/LuisGuilhermeRampaso)
