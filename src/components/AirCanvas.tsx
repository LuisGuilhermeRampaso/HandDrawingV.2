import { useRef, useState, useCallback, useEffect } from 'react';
import { HandLandmarker } from '@mediapipe/tasks-vision';
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { useHandTracker } from '../hooks/useHandTracker';
import type { Point, Stroke } from '../utils/drawingLogic';
import {
  MovingAverage,
  shouldDraw,
  drawIncrementalSmoothStroke,
  finishSmoothStroke,
  replayStroke,
} from '../utils/drawingLogic';

const COLORS = [
  '#ffffff', '#ff4444', '#ff9900', '#ffff00',
  '#44ff44', '#00ccff', '#cc44ff', '#ff44cc',
];

const CANVAS_W = 1280;
const CANVAS_H = 720;
const SKELETON_COLOR = '#00e5ff';
const CLAP_DISTANCE_THRESHOLD = 0.18;
const CLAP_COOLDOWN_MS = 1200;
const STROKE_GLOW_BLUR = 12;
const PARTICLES_PER_SAMPLE = 5;
const PARTICLE_GRAVITY = 180;
const SAFE_SIDE_MARGIN_PX = 28;
const SAFE_TOP_MARGIN_PX = 20;
const SAFE_BOTTOM_MARGIN_PX = 26;
const SAFE_FOOTER_OFFSET_PX = 16;

interface HandState {
  currentStroke: Stroke | null;
  smoother: MovingAverage;
}

interface Particle {
  color: string;
  life: number;
  maxLife: number;
  size: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

interface SafeZoneBounds {
  bottom: number;
  bottomPx: number;
  left: number;
  leftPx: number;
  right: number;
  rightPx: number;
  top: number;
  topPx: number;
}

/**
 * Remapeia coordenadas normalizadas do landmark para coordenadas internas do canvas,
 * levando em conta o object-fit:cover do vídeo.
 * Sem isso, em containers não-16:9 (mobile portrait) o esqueleto fica desalinhado.
 */
function landmarkToCanvas(
  nx: number,
  ny: number,
  containerW: number,
  containerH: number,
): { x: number; y: number } {
  const videoAspect = CANVAS_W / CANVAS_H;
  const containerAspect = containerW / containerH;

  let scale: number;
  let offsetX = 0;
  let offsetY = 0;

  if (containerAspect < videoAspect) {
    // Container mais alto que o vídeo → escala pela altura, recorta os lados
    scale = containerH / CANVAS_H;
    offsetX = (containerW - CANVAS_W * scale) / 2;
  } else {
    // Container mais largo que o vídeo → escala pela largura, recorta cima/baixo
    scale = containerW / CANVAS_W;
    offsetY = (containerH - CANVAS_H * scale) / 2;
  }

  const cssPx = nx * CANVAS_W * scale + offsetX;
  const cssPy = ny * CANVAS_H * scale + offsetY;

  return {
    x: cssPx * (CANVAS_W / containerW),
    y: cssPy * (CANVAS_H / containerH),
  };
}

function createHandState(): HandState {
  return {
    currentStroke: null,
    smoother: new MovingAverage(6),
  };
}

function createDefaultSafeZoneBounds(): SafeZoneBounds {
  return {
    bottom: CANVAS_H - 180,
    bottomPx: 180,
    left: 32,
    leftPx: 32,
    right: CANVAS_W - 32,
    rightPx: 32,
    top: 96,
    topPx: 96,
  };
}

function isPointInsideSafeZone(point: Point, safeZone: SafeZoneBounds) {
  return (
    point.x >= safeZone.left &&
    point.x <= safeZone.right &&
    point.y >= safeZone.top &&
    point.y <= safeZone.bottom
  );
}

function drawHandSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number }[],
  containerW: number,
  containerH: number,
  isDrawingMode: boolean,
) {
  const connections = HandLandmarker.HAND_CONNECTIONS;
  const lineColor = isDrawingMode ? '#00e5ff' : '#888888';
  const glowColor = isDrawingMode ? SKELETON_COLOR : '#555555';
  const toCanvas = (lm: { x: number; y: number }) =>
    landmarkToCanvas(lm.x, lm.y, containerW, containerH);

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = isDrawingMode ? 10 : 4;
  ctx.globalAlpha = 0.85;

  for (const conn of connections) {
    const a = toCanvas(landmarks[conn.start]);
    const b = toCanvas(landmarks[conn.end]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 14;
  for (const lm of landmarks) {
    const p = toCanvas(lm);
    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = glowColor;
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const tip = toCanvas(landmarks[8]);
  ctx.beginPath();
  ctx.fillStyle = isDrawingMode ? '#ffff00' : '#aaaaaa';
  ctx.shadowColor = isDrawingMode ? '#ffff00' : '#777777';
  ctx.shadowBlur = 18;
  ctx.arc(tip.x, tip.y, 7, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function spawnParticles(
  particles: Particle[],
  point: Point,
  color: string,
  brushSize: number
) {
  for (let index = 0; index < PARTICLES_PER_SAMPLE; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 30 + Math.random() * 130;
    const life = 0.25 + Math.random() * 0.4;

    particles.push({
      color,
      life,
      maxLife: life,
      size: Math.max(1.5, brushSize * 0.18 + Math.random() * 3),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 20,
      x: point.x,
      y: point.y,
    });
  }
}

function updateAndDrawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  deltaSeconds: number
) {
  if (particles.length === 0) return;

  ctx.save();
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];

    particle.life -= deltaSeconds;
    if (particle.life <= 0) {
      particles.splice(index, 1);
      continue;
    }

    particle.vy += PARTICLE_GRAVITY * deltaSeconds;
    particle.x += particle.vx * deltaSeconds;
    particle.y += particle.vy * deltaSeconds;

    const alpha = particle.life / particle.maxLife;
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = particle.color;
    ctx.shadowColor = particle.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export default function AirCanvas() {
  const rootRef = useRef<HTMLDivElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const handCanvasRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const clapFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClapRef = useRef<number>(0);
  const handsApartRef = useRef<boolean>(true);
  const frameTimeRef = useRef<number | null>(null);
  const handStatesRef = useRef<Record<string, HandState>>({
    Left: createHandState(),
    Right: createHandState(),
  });
  const strokesRef = useRef<Stroke[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const containerDimRef = useRef({ w: CANVAS_W, h: CANVAS_H });

  const [color, setColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(6);
  const [screenDim, setScreenDim] = useState(65);
  const [activeHands, setActiveHands] = useState(0);
  const [clapFlash, setClapFlash] = useState(false);
  const [safeZone, setSafeZone] = useState<SafeZoneBounds>(createDefaultSafeZoneBounds);
  const [strokeCount, setStrokeCount] = useState(0);
  const [showMobileSettings, setShowMobileSettings] = useState(false);

  const colorRef = useRef(color);
  const brushRef = useRef(brushSize);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    brushRef.current = brushSize;
  }, [brushSize]);

  const ensureHandState = useCallback((handKey: string) => {
    const states = handStatesRef.current;
    if (!states[handKey]) {
      states[handKey] = createHandState();
    }
    return states[handKey];
  }, []);

  const resetHandState = useCallback((handKey: string) => {
    const handState = ensureHandState(handKey);
    handState.currentStroke = null;
    handState.smoother.reset();
  }, [ensureHandState]);

  const resetAllHandStates = useCallback(() => {
    for (const handKey of Object.keys(handStatesRef.current)) {
      resetHandState(handKey);
    }
  }, [resetHandState]);

  const redrawFromHistory = useCallback(() => {
    const drawCanvas = drawCanvasRef.current;
    const dCtx = drawCanvas?.getContext('2d');
    if (!drawCanvas || !dCtx) return;

    dCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const stroke of strokesRef.current) {
      dCtx.shadowColor = stroke.color;
      dCtx.shadowBlur = STROKE_GLOW_BLUR;
      replayStroke(dCtx, stroke);
    }
    dCtx.shadowBlur = 0;
  }, []);

  const finalizeStroke = useCallback((handKey: string, ctx: CanvasRenderingContext2D) => {
    const handState = ensureHandState(handKey);
    const stroke = handState.currentStroke;

    if (stroke && stroke.points.length > 0) {
      if (stroke.points.length > 1) {
        ctx.shadowColor = stroke.color;
        ctx.shadowBlur = STROKE_GLOW_BLUR;
        finishSmoothStroke(ctx, stroke.points, stroke.color, stroke.lineWidth);
        ctx.shadowBlur = 0;
      }

      strokesRef.current = [...strokesRef.current, {
        ...stroke,
        points: [...stroke.points],
      }];
      setStrokeCount(strokesRef.current.length);
    }

    resetHandState(handKey);
  }, [ensureHandState, resetHandState]);

  useEffect(() => {
    const draw = drawCanvasRef.current;
    const hand = handCanvasRef.current;
    if (draw) {
      draw.width = CANVAS_W;
      draw.height = CANVAS_H;
    }
    if (hand) {
      hand.width = CANVAS_W;
      hand.height = CANVAS_H;
    }
  }, []);

  const clearCanvas = useCallback(() => {
    const dCtx = drawCanvasRef.current?.getContext('2d');
    const hCtx = handCanvasRef.current?.getContext('2d');

    dCtx?.clearRect(0, 0, CANVAS_W, CANVAS_H);
    hCtx?.clearRect(0, 0, CANVAS_W, CANVAS_H);

    strokesRef.current = [];
    particlesRef.current = [];
    setStrokeCount(0);
    resetAllHandStates();

    setClapFlash(true);
    if (clapFlashRef.current) clearTimeout(clapFlashRef.current);
    clapFlashRef.current = setTimeout(() => setClapFlash(false), 400);
  }, [resetAllHandStates]);

  const undoLastStroke = useCallback(() => {
    if (strokesRef.current.length === 0) return;

    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    particlesRef.current = [];
    resetAllHandStates();
    redrawFromHistory();
  }, [redrawFromHistory, resetAllHandStates]);

  const saveImage = useCallback(() => {
    const sourceCanvas = drawCanvasRef.current;
    if (!sourceCanvas || strokesRef.current.length === 0) return;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = CANVAS_W;
    exportCanvas.height = CANVAS_H;

    const exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) return;

    exportCtx.fillStyle = '#000000';
    exportCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    exportCtx.save();
    exportCtx.translate(CANVAS_W, 0);
    exportCtx.scale(-1, 1);
    exportCtx.drawImage(sourceCanvas, 0, 0);
    exportCtx.restore();

    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `hand-drawing-${timestamp}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        undoLastStroke();
      }

      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        saveImage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveImage, undoLastStroke]);

  const handleResults = useCallback((results: HandLandmarkerResult) => {
    const handCanvas = handCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!handCanvas || !drawCanvas) return;

    const hCtx = handCanvas.getContext('2d');
    const dCtx = drawCanvas.getContext('2d');
    if (!hCtx || !dCtx) return;

    const now = performance.now();
    const deltaSeconds = frameTimeRef.current === null
      ? 1 / 60
      : Math.min((now - frameTimeRef.current) / 1000, 0.05);
    frameTimeRef.current = now;

    hCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    updateAndDrawParticles(hCtx, particlesRef.current, deltaSeconds);

    const count = results.landmarks?.length ?? 0;
    setActiveHands(count);

    if (count === 0) {
      for (const handKey of Object.keys(handStatesRef.current)) {
        const handState = handStatesRef.current[handKey];
        if (handState.currentStroke) {
          finalizeStroke(handKey, dCtx);
        } else {
          resetHandState(handKey);
        }
      }
      handsApartRef.current = true;
      return;
    }

    if (count === 2) {
      const label0 = results.handedness?.[0]?.[0]?.categoryName ?? '';
      const label1 = results.handedness?.[1]?.[0]?.categoryName ?? '';
      const bothRealHands = label0 !== '' && label1 !== '' && label0 !== label1;

      if (bothRealHands) {
        const wrist0 = results.landmarks[0][0];
        const wrist1 = results.landmarks[1][0];
        const dist = Math.sqrt((wrist0.x - wrist1.x) ** 2 + (wrist0.y - wrist1.y) ** 2);
        const clapNow = Date.now();

        if (dist < CLAP_DISTANCE_THRESHOLD) {
          if (handsApartRef.current && clapNow - lastClapRef.current > CLAP_COOLDOWN_MS) {
            lastClapRef.current = clapNow;
            handsApartRef.current = false;
            clearCanvas();
          }
        } else {
          handsApartRef.current = true;
        }
      } else {
        handsApartRef.current = true;
      }
    } else {
      handsApartRef.current = true;
    }

    for (let index = 0; index < count; index += 1) {
      const landmarks = results.landmarks[index];
      const handKey = results.handedness?.[index]?.[0]?.categoryName ?? `hand${index}`;
      const handState = ensureHandState(handKey);
      const drawGestureActive = shouldDraw(landmarks);

      const { w: cw, h: ch } = containerDimRef.current;
      drawHandSkeleton(hCtx, landmarks, cw, ch, drawGestureActive);

      const tip = landmarks[8];
      const mappedTip = landmarkToCanvas(tip.x, tip.y, cw, ch);
      const smoothed = handState.smoother.push(mappedTip.x, mappedTip.y);
      const drawing = drawGestureActive && isPointInsideSafeZone(smoothed, safeZone);

      if (drawing) {
        if (!handState.currentStroke) {
          handState.currentStroke = {
            color: colorRef.current,
            lineWidth: brushRef.current,
            points: [],
          };
        }

        handState.currentStroke.points.push(smoothed);
        dCtx.shadowColor = handState.currentStroke.color;
        dCtx.shadowBlur = STROKE_GLOW_BLUR;
        drawIncrementalSmoothStroke(
          dCtx,
          handState.currentStroke.points,
          handState.currentStroke.color,
          handState.currentStroke.lineWidth
        );
        dCtx.shadowBlur = 0;

        spawnParticles(
          particlesRef.current,
          smoothed,
          handState.currentStroke.color,
          handState.currentStroke.lineWidth
        );
      } else if (handState.currentStroke) {
        finalizeStroke(handKey, dCtx);
      } else {
        handState.smoother.reset();
      }
    }

    const activeKeys = new Set(
      Array.from({ length: count }, (_, index) =>
        results.handedness?.[index]?.[0]?.categoryName ?? `hand${index}`
      )
    );

    for (const handKey of Object.keys(handStatesRef.current)) {
      if (!activeKeys.has(handKey)) {
        const handState = handStatesRef.current[handKey];
        if (handState.currentStroke) {
          finalizeStroke(handKey, dCtx);
        } else {
          resetHandState(handKey);
        }
      }
    }
  }, [clearCanvas, ensureHandState, finalizeStroke, resetHandState, safeZone]);

  const { videoRef, ready, error } = useHandTracker({ onResults: handleResults });

  useEffect(() => {
    const updateSafeZone = () => {
      const rootRect = rootRef.current?.getBoundingClientRect();
      if (!rootRect || rootRect.width === 0 || rootRect.height === 0) return;
      containerDimRef.current = { w: rootRect.width, h: rootRect.height };

      const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0;
      const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 0;

      const topPx = headerHeight + SAFE_TOP_MARGIN_PX;
      const bottomPx = footerHeight + SAFE_FOOTER_OFFSET_PX + SAFE_BOTTOM_MARGIN_PX;
      const leftPx = SAFE_SIDE_MARGIN_PX;
      const rightPx = SAFE_SIDE_MARGIN_PX;

      setSafeZone({
        bottom: CANVAS_H - (bottomPx / rootRect.height) * CANVAS_H,
        bottomPx,
        left: (leftPx / rootRect.width) * CANVAS_W,
        leftPx,
        right: CANVAS_W - (rightPx / rootRect.width) * CANVAS_W,
        rightPx,
        top: (topPx / rootRect.height) * CANVAS_H,
        topPx,
      });
    };

    updateSafeZone();

    const resizeObserver = new ResizeObserver(() => updateSafeZone());
    const root = rootRef.current;
    const header = headerRef.current;
    const footer = footerRef.current;

    if (root) resizeObserver.observe(root);
    if (header) resizeObserver.observe(header);
    if (footer) resizeObserver.observe(footer);

    window.addEventListener('resize', updateSafeZone);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateSafeZone);
    };
  }, [ready]);

  const mirrorStyle = { transform: 'scaleX(-1)' } as const;

  return (
    <div ref={rootRef} className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
        style={mirrorStyle}
      />

      {ready && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: `rgba(0, 0, 0, ${screenDim / 100})` }}
        />
      )}

      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-200"
        style={{ backgroundColor: 'white', opacity: clapFlash ? 0.35 : 0 }}
      />

      <canvas
        ref={drawCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={mirrorStyle}
      />
      <canvas
        ref={handCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={mirrorStyle}
      />

      {ready && (
        <div
          className="pointer-events-none absolute rounded-[32px] border border-dashed border-cyan-300/28 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04),0_0_30px_rgba(34,211,238,0.08)]"
          style={{
            top: safeZone.topPx,
            bottom: safeZone.bottomPx,
            left: safeZone.leftPx,
            right: safeZone.rightPx,
          }}
        >
          <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-cyan-300/20 bg-slate-950/55 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-cyan-100/72">
            Area segura de desenho
          </div>
        </div>
      )}

      {!ready && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/90 text-white">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-cyan-400 border-t-transparent" />
          <p className="text-lg font-medium">Carregando modelo e camera...</p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-red-400">
          <p className="text-2xl font-bold">Erro ao inicializar</p>
          <p className="max-w-md text-center text-sm">{error}</p>
          <p className="mt-2 text-xs text-gray-400">Verifique as permissoes da camera e recarregue a pagina.</p>
        </div>
      )}

      {ready && (
        <div ref={headerRef} className="absolute top-0 left-0 right-0 border-b border-white/10 bg-black/60 backdrop-blur-sm">
          {/* ── Linha principal ── */}
          <div className="flex items-center gap-2 px-3 py-2 md:gap-4 md:px-6 md:py-3">
            {/* Status */}
            <div className={`flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors md:px-3 md:text-sm ${
              activeHands > 0
                ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-300'
                : 'border-gray-500/40 bg-gray-500/20 text-gray-400'
            }`}>
              <span className={`h-2 w-2 rounded-full ${activeHands > 0 ? 'bg-cyan-400 animate-pulse' : 'bg-gray-500'}`} />
              <span className="hidden sm:inline">
                {activeHands === 0 ? 'Sem mao' : activeHands === 1 ? '1 mao detectada' : '2 maos detectadas'}
              </span>
              <span className="sm:hidden">
                {activeHands === 0 ? 'Sem mao' : activeHands === 1 ? '1 mao' : '2 maos'}
              </span>
            </div>

            <div className="hidden h-5 w-px bg-white/20 md:block" />

            {/* Cores */}
            <div className="flex gap-1">
              {COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 md:h-6 md:w-6"
                  style={{
                    backgroundColor: swatch,
                    borderColor: color === swatch ? '#fff' : 'transparent',
                    boxShadow: color === swatch ? `0 0 8px ${swatch}` : 'none',
                    transform: color === swatch ? 'scale(1.2)' : undefined,
                  }}
                />
              ))}
            </div>

            <div className="flex-1" />

            {/* Botões de ação */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={undoLastStroke}
                disabled={strokeCount === 0}
                title="Desfazer (Ctrl+Z)"
                className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-white/10 md:px-4 md:text-sm"
              >
                <span className="hidden md:inline">Desfazer</span>
                <span className="md:hidden">↩</span>
              </button>
              <button
                type="button"
                onClick={saveImage}
                disabled={strokeCount === 0}
                title="Salvar PNG (Ctrl+S)"
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-2.5 py-1.5 text-xs font-medium text-emerald-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-emerald-500/30 md:px-4 md:text-sm"
              >
                <span className="hidden md:inline">Salvar PNG</span>
                <span className="md:hidden">PNG</span>
              </button>
              <button
                type="button"
                onClick={clearCanvas}
                title="Limpar Tela"
                className="rounded-lg border border-red-500/50 bg-red-600/80 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 md:px-4 md:text-sm"
              >
                <span className="hidden md:inline">Limpar Tela</span>
                <span className="md:hidden">✕</span>
              </button>
              {/* Botão de configurações */}
              <button
                type="button"
                onClick={() => setShowMobileSettings((v) => !v)}
                title="Configurações"
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors hover:bg-white/10 ${showMobileSettings ? 'border-cyan-400/50 text-cyan-300' : 'border-white/15 text-white/70'}`}
              >
                ⚙
              </button>
            </div>
          </div>

          {/* ── Sliders: colapsáveis via engrenagem ── */}
          <div className={`${showMobileSettings ? 'flex' : 'hidden'} flex-wrap items-center gap-3 border-t border-white/5 px-3 pb-2.5 pt-2 md:gap-4 md:px-6 md:pb-3`}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50">Espessura</span>
              <input
                type="range"
                min={2}
                max={30}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
                className="w-24 accent-cyan-400"
              />
              <span className="w-5 text-center text-xs text-white/70">{brushSize}</span>
            </div>
            <div className="hidden h-5 w-px bg-white/20 md:block" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50">Escurecer</span>
              <input
                type="range"
                min={0}
                max={100}
                value={screenDim}
                onChange={(event) => setScreenDim(Number(event.target.value))}
                className="w-28 accent-cyan-400"
              />
              <span className="w-9 text-center text-xs text-white/70">{screenDim}%</span>
            </div>
          </div>
        </div>
      )}

      {ready && (
        <div ref={footerRef} className="absolute right-0 bottom-4 left-0 hidden justify-center px-4 md:flex">
          <div className="w-full max-w-4xl rounded-3xl border border-white/12 bg-gradient-to-r from-black/72 via-slate-950/78 to-black/72 px-4 py-4 shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-md">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">Air Canvas</p>
                <p className="text-sm font-semibold text-white">Controles rapidos</p>
                <a
                  href="https://github.com/LuisGuilhermeRampaso"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-white/35 transition-colors hover:text-cyan-300/70"
                >
                  dev. Guilherme Rampaso
                </a>
              </div>
              <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] text-cyan-100/80">
                Desenhe dentro da moldura para nao encostar no painel
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 text-left sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-200/70">Desenhar</p>
                <p className="mt-1 text-sm text-white">Indicador levantado</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-amber-200/70">Pausar</p>
                <p className="mt-1 text-sm text-white">Indicador + medio</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-rose-200/70">Limpar</p>
                <p className="mt-1 text-sm text-white">Palmas juntas</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-emerald-200/70">Desfazer</p>
                <p className="mt-1 text-sm text-white">Ctrl+Z</p>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-fuchsia-200/70">Salvar</p>
                <p className="mt-1 text-sm text-white">Ctrl+S ou botao</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
