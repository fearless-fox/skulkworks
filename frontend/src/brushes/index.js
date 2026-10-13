import { getStroke } from 'perfect-freehand';

/**
 * Skulkworks brush engine.
 *
 * A brush is a DETERMINISTIC function of (points, params, seed) -> pixels.
 * Every client, the SVG archiver, and the timelapse renderer must produce
 * identical output for the same inputs. No Date.now(), no Math.random()
 * inside render() — use the seeded PRNG.
 *
 * Brush shape:
 *   { id, name, category, tier: 'free'|'premium'|'ad', description,
 *     render(ctx, pts, params, seed) }
 * pts are tile-local [{x, y, pressure, tiltX, tiltY}], params = {size, color, opacity}.
 */

// ---------- helpers ----------

function rgba(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function toInput(pts) {
  return pts.map((p) => [p.x, p.y, p.pressure ?? 0.5]);
}

function strokeOptions(params, overrides = {}) {
  return {
    size: params.size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    ...overrides,
  };
}

/** Filled freehand polygon — the workhorse for ink-like brushes. */
function fillPoly(ctx, pts, params, opts = {}) {
  const outline = getStroke(toInput(pts), strokeOptions(params, opts.stroke));
  if (!outline.length) return outline;
  ctx.save();
  ctx.globalAlpha = opts.opacity ?? params.opacity ?? 1;
  if (opts.glow) {
    ctx.shadowColor = params.color;
    ctx.shadowBlur = opts.glow;
  }
  ctx.fillStyle = opts.color || params.color || '#ffffff';
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  return outline;
}

// ---------- brushes ----------

const brushes = new Map();

function defineBrush(def) {
  brushes.set(def.id, def);
  return def;
}

defineBrush({
  id: 'ink',
  name: 'Ink Pen',
  category: 'ink',
  tier: 'free',
  description: 'Crisp pressure-sensitive ink.',
  render(ctx, pts, params) {
    fillPoly(ctx, pts, params, { stroke: { thinning: 0.75 } });
  },
});

defineBrush({
  id: 'marker',
  name: 'Marker',
  category: 'ink',
  tier: 'free',
  description: 'Bold, even marker with slight transparency.',
  render(ctx, pts, params) {
    fillPoly(ctx, pts, params, { stroke: { thinning: 0.2 }, opacity: (params.opacity ?? 1) * 0.85 });
  },
});

defineBrush({
  id: 'calligraphy',
  name: 'Calligraphy',
  category: 'ink',
  tier: 'free',
  description: 'Dramatic thick-thin strokes.',
  render(ctx, pts, params) {
    fillPoly(ctx, pts, params, { stroke: { thinning: 0.95, smoothing: 0.25 } });
  },
});

defineBrush({
  id: 'neon',
  name: 'Neon',
  category: 'fx',
  tier: 'free',
  description: 'Glowing neon tube.',
  render(ctx, pts, params) {
    fillPoly(ctx, pts, params, { stroke: { thinning: 0.55 }, glow: params.size * 2.5 });
    fillPoly(ctx, pts, params, {
      stroke: { thinning: 0.55 },
      color: '#ffffff',
      opacity: 0.85,
    });
  },
});

defineBrush({
  id: 'airbrush',
  name: 'Airbrush',
  category: 'paint',
  tier: 'free',
  description: 'Soft spray build-up.',
  render(ctx, pts, params) {
    ctx.save();
    for (let i = 0; i < pts.length; i += 2) {
      const pt = pts[i];
      const pressure = pt.pressure ?? 0.5;
      const r = Math.max(1, params.size * (0.4 + pressure));
      const a = 0.055 * pressure * (params.opacity ?? 1);
      const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
      g.addColorStop(0, rgba(params.color, Math.min(1, a * 2.5)));
      g.addColorStop(1, rgba(params.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'charcoal',
  name: 'Charcoal',
  category: 'dry',
  tier: 'free',
  description: 'Gritty charcoal with grain.',
  render(ctx, pts, params, seed) {
    const outline = fillPoly(ctx, pts, params, {
      stroke: { thinning: 0.7 },
      opacity: (params.opacity ?? 1) * 0.82,
    });
    if (!outline || !outline.length) return;
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rand = mulberry32(seed);
    const count = Math.min(4000, Math.floor(pts.length * 6));
    ctx.save();
    ctx.fillStyle = rgba('#000000', 0.22);
    for (let i = 0; i < count; i++) {
      const x = minX + rand() * (maxX - minX);
      const y = minY + rand() * (maxY - minY);
      if (pointInPolygon(x, y, outline)) ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'eraser',
  name: 'Eraser',
  category: 'tool',
  tier: 'free',
  description: 'Paints back to canvas ground.',
  render(ctx, pts) {
    fillPoly(ctx, pts, { size: 24, color: '#0a0a0a', opacity: 1 }, { stroke: { thinning: 0.5 } });
  },
});

// ---------- registry ----------

export function getBrush(id) {
  return brushes.get(id) || null;
}

export function listBrushes() {
  return [...brushes.values()];
}

export function listBrushesByTier(tier) {
  return listBrushes().filter((b) => b.tier === tier);
}

/**
 * Render a stroke to an offscreen tile canvas.
 * Returns { canvas, offsetX, offsetY } for placement as a fabric.Image.
 */
export function renderStrokeToCanvas(brush, pts, params, bounds) {
  const pad = Math.ceil((params.size || 12) * 3) + 8;
  const w = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
  const h = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
  const c = document.createElement('canvas');
  c.width = w + pad * 2;
  c.height = h + pad * 2;
  const ctx = c.getContext('2d');
  const local = pts.map((p) => ({
    ...p,
    x: p.x - bounds.minX + pad,
    y: p.y - bounds.minY + pad,
  }));
  const seed = Math.round(bounds.minX * 13.7 + bounds.minY * 7.31);
  brush.render(ctx, local, params, seed);
  return { canvas: c, offsetX: bounds.minX - pad, offsetY: bounds.minY - pad };
}
