export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  color: string;
  lineWidth: number;
  points: Point[];
}

// Moving average filter to smooth coordinates
export class MovingAverage {
  private windowSize: number;
  private xBuffer: number[] = [];
  private yBuffer: number[] = [];

  constructor(windowSize = 5) {
    this.windowSize = windowSize;
  }

  push(x: number, y: number): Point {
    this.xBuffer.push(x);
    this.yBuffer.push(y);

    if (this.xBuffer.length > this.windowSize) {
      this.xBuffer.shift();
      this.yBuffer.shift();
    }

    const avgX = this.xBuffer.reduce((a, b) => a + b, 0) / this.xBuffer.length;
    const avgY = this.yBuffer.reduce((a, b) => a + b, 0) / this.yBuffer.length;

    return { x: avgX, y: avgY };
  }

  reset() {
    this.xBuffer = [];
    this.yBuffer = [];
  }
}

// Euclidean distance between two landmarks (normalized 0-1 coords)
export function landmarkDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Detects if we should draw.
 * Draw when: index finger (8) is up AND middle finger (12) is NOT up.
 * "Up" = tip y < pip y (finger extended upward in image coords).
 *
 * Landmarks used:
 *   4  = thumb tip
 *   5  = index MCP
 *   6  = index PIP
 *   8  = index tip
 *   10 = middle MCP
 *   11 = middle PIP
 *   12 = middle tip
 */
export function shouldDraw(landmarks: { x: number; y: number }[]): boolean {
  if (!landmarks || landmarks.length < 21) return false;

  const indexTip = landmarks[8];
  const indexPip = landmarks[6];
  const middleTip = landmarks[12];
  const middlePip = landmarks[10];

  const indexUp = indexTip.y < indexPip.y;
  const middleUp = middleTip.y < middlePip.y;

  // Draw only when index is up and middle is down
  return indexUp && !middleUp;
}

export function drawStroke(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  lineWidth: number
) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function applyStrokeStyle(
  ctx: CanvasRenderingContext2D,
  color: string,
  lineWidth: number
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

export function drawStrokePoint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  lineWidth: number
) {
  applyStrokeStyle(ctx, color, lineWidth);
  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(lineWidth / 2, 1), 0, Math.PI * 2);
  ctx.fill();
}

export function drawIncrementalSmoothStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  lineWidth: number
) {
  if (points.length === 0) return;

  applyStrokeStyle(ctx, color, lineWidth);

  if (points.length === 1) {
    drawStrokePoint(ctx, points[0], color, lineWidth);
    return;
  }

  if (points.length === 2) {
    const first = points[0];
    const second = points[1];
    const firstMid = midpoint(first, second);

    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(firstMid.x, firstMid.y);
    ctx.stroke();
    return;
  }

  const previous = points[points.length - 3];
  const current = points[points.length - 2];
  const next = points[points.length - 1];
  const start = midpoint(previous, current);
  const end = midpoint(current, next);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.quadraticCurveTo(current.x, current.y, end.x, end.y);
  ctx.stroke();
}

export function finishSmoothStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  lineWidth: number
) {
  if (points.length < 2) return;

  applyStrokeStyle(ctx, color, lineWidth);

  const secondLast = points[points.length - 2];
  const last = points[points.length - 1];
  const start = midpoint(secondLast, last);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function replayStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke
) {
  const { color, lineWidth, points } = stroke;

  if (points.length === 0) return;

  applyStrokeStyle(ctx, color, lineWidth);

  if (points.length === 1) {
    drawStrokePoint(ctx, points[0], color, lineWidth);
    return;
  }

  if (points.length === 2) {
    drawStroke(ctx, points[0], points[1], color, lineWidth);
    return;
  }

  const firstMid = midpoint(points[0], points[1]);

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  ctx.lineTo(firstMid.x, firstMid.y);

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const nextMid = midpoint(current, points[index + 1]);
    ctx.quadraticCurveTo(current.x, current.y, nextMid.x, nextMid.y);
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function replayStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[]
) {
  for (const stroke of strokes) {
    replayStroke(ctx, stroke);
  }
}
