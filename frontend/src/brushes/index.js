import { getStroke } from 'perfect-freehand';
import manifestData from '../../shared/brushes.json';

/**
 * Skulkworks brush engine.
 *
 * A brush is a DETERMINISTIC function of (points, params, seed) -> pixels.
 * Every client, the SVG archiver, and the timelapse renderer must produce
 * identical output for the same inputs. No Date.now(), no Math.random()
 * inside render() — use the seeded PRNG.
 *
 * Metadata (name/tier/price) comes from shared/brushes.json — the single
 * source of truth, shared with the backend entitlement checks.
 * Render functions are registered here by brush id.
 *
 * Brush shape after registration:
 *   { id, name, category, tier: 'free'|'premium'|'ad', priceCents,
 *     description, render(ctx, pts, params, seed) }
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

/** Evenly resample a polyline every `spacing` px — for dot/particle brushes. */
function resample(pts, spacing) {
  const out = [];
  if (pts.length < 2 || spacing <= 0) return out;
  let prev = pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    let sx = prev.x, sy = prev.y;
    let sp = prev.pressure ?? 0.5;
    const cp = cur.pressure ?? 0.5;
    let segLen = Math.hypot(cur.x - sx, cur.y - sy);
    while (acc + segLen >= spacing && segLen > 0) {
      const t = (spacing - acc) / segLen;
      const nx = sx + (cur.x - sx) * t;
      const ny = sy + (cur.y - sy) * t;
      const np = sp + (cp - sp) * t;
      out.push({ x: nx, y: ny, pressure: np });
      sx = nx; sy = ny; sp = np;
      segLen = Math.hypot(cur.x - sx, cur.y - sy);
      acc = 0;
    }
    acc += segLen;
    prev = cur;
  }
  return out;
}

/** Trace a polyline path on ctx. */
function pathFromPts(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
}

// ---------- stamped brushes (ABR-extracted tips) ----------
// Tips live in frontend/public/brush-tips/*.png (NOT pushed via the github
// connector — it mangles binaries; tips ship to the repo from his machine).
// Each stamped brush def carries { tip, dynamics }; render via stampBrush().
const tipImages = new Map(); // file -> HTMLImageElement | null (failed)
const tintCache = new Map(); // `${file}|${color}` -> tinted canvas

/** Preload tip PNGs. Safe to call repeatedly; failures resolve as null. */
export function preloadTips(files) {
  const base =
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return Promise.all(
    files.map(
      (f) =>
        new Promise((resolve) => {
          if (tipImages.has(f)) return resolve(tipImages.get(f));
          const img = new Image();
          img.onload = () => {
            tipImages.set(f, img);
            resolve(img);
          };
          img.onerror = () => {
            tipImages.set(f, null);
            resolve(null);
          };
          img.src = `${base}brush-tips/${f}`;
        })
    )
  );
}

function getTintedTip(file, color) {
  const key = `${file}|${color}`;
  if (tintCache.has(key)) return tintCache.get(key);
  const img = tipImages.get(file);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}

/**
 * Stamp a grayscale tip along the path, Photoshop-style.
 * dynamics: { spacing (fraction of size), scatter (fraction of size),
 *             sizeJitter (0..1), rotationJitter (radians), opacityJitter (0..1) }
 * Deterministic in (points, params, seed).
 */
export function stampBrush(ctx, pts, params, seed, file, dynamics = {}) {
  const tip = getTintedTip(file, params.color || '#ffffff');
  if (!tip || pts.length === 0) return;
  const rand = mulberry32(seed);
  const size = params.size || 24;
  const spacing = Math.max(2, size * (dynamics.spacing ?? 0.35));
  const dots = resample(pts, spacing);
  const alpha = params.opacity ?? 1;
  const scatter = (dynamics.scatter ?? 0) * size;
  ctx.save();
  for (const d of dots) {
    const p = d.pressure ?? 0.5;
    const jz = dynamics.sizeJitter ? 1 + (rand() * 2 - 1) * dynamics.sizeJitter : 1;
    const s = Math.max(1, size * (0.55 + p * 0.7) * jz);
    const rot = dynamics.rotationJitter ? (rand() * 2 - 1) * dynamics.rotationJitter : 0;
    const ox = scatter ? (rand() * 2 - 1) * scatter : 0;
    const oy = scatter ? (rand() * 2 - 1) * scatter : 0;
    const a = alpha * (dynamics.opacityJitter ? 1 - rand() * dynamics.opacityJitter : 1);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    ctx.setTransform(cos, sin, -sin, cos, d.x + ox, d.y + oy);
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.drawImage(tip, -s / 2, -s / 2, s, s);
  }
  ctx.restore();
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
const MANIFEST = new Map((manifestData.brushes || []).map((b) => [b.id, b]));

function defineBrush(def) {
  // Manifest is the source of truth for name/tier/price/category/description.
  const meta = MANIFEST.get(def.id) || {};
  brushes.set(def.id, {
    id: def.id,
    name: meta.name || def.name,
    category: meta.category || def.category || 'misc',
    tier: meta.tier || def.tier || 'free',
    priceCents: meta.priceCents ?? null,
    description: meta.description || def.description || '',
    render: def.render,
  });
  return brushes.get(def.id);
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

// ---------- wave 2 ----------

defineBrush({
  id: 'watercolor',
  name: 'Watercolor',
  category: 'paint',
  tier: 'ad',
  description: 'Soft washes with darker edges and granulation.',
  render(ctx, pts, params, seed) {
    const rand = mulberry32(seed ^ 0x6a09);
    const alpha = params.opacity ?? 1;
    const dots = resample(pts, Math.max(2, params.size * 0.35));
    ctx.save();
    for (const d of dots) {
      const r = params.size * (0.9 + rand() * 0.5) * (0.6 + (d.pressure ?? 0.5) * 0.6);
      // light wash
      let g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
      g.addColorStop(0, rgba(params.color, 0.1 * alpha));
      g.addColorStop(0.7, rgba(params.color, 0.05 * alpha));
      g.addColorStop(1, rgba(params.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill();
      // darker edge ring — the watercolor signature
      g = ctx.createRadialGradient(d.x, d.y, r * 0.5, d.x, d.y, r);
      g.addColorStop(0, rgba(params.color, 0));
      g.addColorStop(0.82, rgba(params.color, 0.11 * alpha));
      g.addColorStop(1, rgba(params.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill();
    }
    // granulation speckle
    const n = Math.min(900, dots.length * 4);
    ctx.fillStyle = rgba(params.color, 0.08 * alpha);
    for (let i = 0; i < n; i++) {
      const d = dots[Math.floor(rand() * dots.length)];
      if (!d) break;
      const a = rand() * Math.PI * 2;
      const rr = rand() * params.size;
      ctx.fillRect(d.x + Math.cos(a) * rr, d.y + Math.sin(a) * rr, 1.4, 1.4);
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'oil',
  name: 'Oil Paint',
  category: 'paint',
  tier: 'premium',
  description: 'Thick impasto with bristle streaks.',
  render(ctx, pts, params, seed) {
    fillPoly(ctx, pts, params, { stroke: { thinning: 0.45 }, opacity: params.opacity ?? 1 });
    const rand = mulberry32(seed ^ 0x9e37);
    const dots = resample(pts, Math.max(3, params.size * 0.5));
    ctx.save();
    ctx.lineCap = 'round';
    for (const d of dots) {
      const light = rand() > 0.5;
      ctx.strokeStyle = light ? rgba('#ffffff', 0.1) : rgba('#000000', 0.13);
      ctx.lineWidth = Math.max(1, params.size * 0.12);
      const a = rand() * Math.PI;
      const len = params.size * (0.3 + rand() * 0.5);
      ctx.beginPath();
      ctx.moveTo(d.x - (Math.cos(a) * len) / 2, d.y - (Math.sin(a) * len) / 2);
      ctx.lineTo(d.x + (Math.cos(a) * len) / 2, d.y + (Math.sin(a) * len) / 2);
      ctx.stroke();
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'pencil',
  name: 'Pencil',
  category: 'dry',
  tier: 'free',
  description: 'Fine graphite with tooth.',
  render(ctx, pts, params, seed) {
    const p = { ...params, size: Math.max(1, params.size * 0.45), color: '#9aa0a6' };
    const outline = fillPoly(ctx, pts, p, {
      stroke: { thinning: 0.6 },
      opacity: 0.72 * (params.opacity ?? 1),
    });
    if (!outline || !outline.length) return;
    const rand = mulberry32((seed ^ 0x9e1) >>> 0);
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    ctx.save();
    ctx.fillStyle = rgba('#3c4043', 0.3);
    const n = Math.min(1500, Math.floor(pts.length * 4));
    for (let i = 0; i < n; i++) {
      const x = minX + rand() * (maxX - minX);
      const y = minY + rand() * (maxY - minY);
      if (pointInPolygon(x, y, outline)) ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'crayon',
  name: 'Crayon',
  category: 'dry',
  tier: 'free',
  description: 'Waxy color with broken texture.',
  render(ctx, pts, params, seed) {
    const outline = fillPoly(ctx, pts, params, {
      stroke: { thinning: 0.5 },
      opacity: 0.88 * (params.opacity ?? 1),
    });
    if (!outline || !outline.length) return;
    const rand = mulberry32(seed ^ 0x51f7);
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const n = Math.min(2500, Math.floor(pts.length * 6));
    for (let i = 0; i < n; i++) {
      const x = minX + rand() * (maxX - minX);
      const y = minY + rand() * (maxY - minY);
      if (pointInPolygon(x, y, outline) && rand() < 0.6) {
        ctx.beginPath();
        ctx.arc(x, y, 0.8 + rand() * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'chalk',
  name: 'Chalk',
  category: 'dry',
  tier: 'free',
  description: 'Soft dusty pastel.',
  render(ctx, pts, params, seed) {
    const rand = mulberry32(seed ^ 0xc4a1);
    const alpha = params.opacity ?? 1;
    const dots = resample(pts, Math.max(2, params.size * 0.4));
    ctx.save();
    for (const d of dots) {
      const r = params.size * (0.7 + rand() * 0.4);
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
      g.addColorStop(0, rgba(params.color, 0.22 * alpha));
      g.addColorStop(1, rgba(params.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = rgba('#ffffff', 0.1 * alpha);
    const n = Math.min(800, dots.length * 3);
    for (let i = 0; i < n; i++) {
      const d = dots[Math.floor(rand() * dots.length)];
      if (!d) break;
      ctx.fillRect(
        d.x + (rand() - 0.5) * params.size * 2,
        d.y + (rand() - 0.5) * params.size * 2,
        1.5, 1.5
      );
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'laser',
  name: 'Laser',
  category: 'fx',
  tier: 'premium',
  description: 'White-hot beam with colored halo.',
  render(ctx, pts, params) {
    const alpha = params.opacity ?? 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // halo
    ctx.shadowColor = params.color;
    ctx.shadowBlur = params.size * 3;
    ctx.strokeStyle = rgba(params.color, 0.9 * alpha);
    ctx.lineWidth = Math.max(1, params.size * 0.5);
    pathFromPts(ctx, pts);
    ctx.stroke();
    // hot core
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * alpha})`;
    ctx.lineWidth = Math.max(1, params.size * 0.16);
    pathFromPts(ctx, pts);
    ctx.stroke();
    ctx.restore();
  },
});

defineBrush({
  id: 'fire',
  name: 'Fire',
  category: 'fx',
  tier: 'free',
  description: 'Licks of flame with ember sparks.',
  render(ctx, pts, params, seed) {
    const rand = mulberry32(seed ^ 0xf17e);
    const alpha = params.opacity ?? 1;
    const dots = resample(pts, Math.max(2, params.size * 0.3));
    const n = dots.length;
    ctx.save();
    dots.forEach((d, i) => {
      const t = n <= 1 ? 0 : i / (n - 1);
      const hue = 52 - t * 42 + (rand() - 0.5) * 14;
      const r = params.size * (0.55 + (d.pressure ?? 0.5) * 0.5) * (1 - t * 0.35);
      ctx.fillStyle = `hsla(${hue},100%,${50 + rand() * 12}%,${0.85 * alpha})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill();
      if (rand() < 0.3) {
        ctx.fillStyle = `hsla(${45 + rand() * 15},100%,62%,${0.8 * alpha})`;
        ctx.fillRect(d.x + (rand() - 0.5) * r * 3, d.y + (rand() - 0.5) * r * 3 - r, 2, 2);
      }
    });
    ctx.restore();
  },
});

defineBrush({
  id: 'rainbow',
  name: 'Rainbow',
  category: 'fx',
  tier: 'free',
  description: 'Hue cycles with distance drawn.',
  render(ctx, pts, params) {
    const dots = resample(pts, Math.max(2, params.size * 0.4));
    if (dots.length < 2) return;
    const alpha = params.opacity ?? 1;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, params.size * 0.8);
    let dist = 0;
    for (let i = 1; i < dots.length; i++) {
      dist += Math.hypot(dots[i].x - dots[i - 1].x, dots[i].y - dots[i - 1].y);
      ctx.strokeStyle = `hsla(${(dist * 1.4) % 360},90%,60%,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(dots[i - 1].x, dots[i - 1].y);
      ctx.lineTo(dots[i].x, dots[i].y);
      ctx.stroke();
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'stipple',
  name: 'Stipple',
  category: 'texture',
  tier: 'free',
  description: 'Hand-dotted pointillism.',
  render(ctx, pts, params, seed) {
    const rand = mulberry32(seed ^ 0x5719);
    const alpha = params.opacity ?? 1;
    const dots = resample(pts, Math.max(3, params.size * 0.9));
    ctx.save();
    ctx.fillStyle = rgba(params.color, alpha);
    for (const d of dots) {
      const r = Math.max(
        0.8,
        params.size * 0.16 * (0.6 + (d.pressure ?? 0.5) * 0.8) * (0.8 + rand() * 0.4)
      );
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
});

defineBrush({
  id: 'spray',
  name: 'Spray Mist',
  category: 'paint',
  tier: 'free',
  description: 'Fine aerosol mist.',
  render(ctx, pts, params, seed) {
    const rand = mulberry32(seed ^ 0x5eed);
    const alpha = params.opacity ?? 1;
    const dots = resample(pts, Math.max(4, params.size * 0.6));
    ctx.save();
    for (const d of dots) {
      for (let k = 0; k < 14; k++) {
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * params.size * 1.4;
        ctx.fillStyle = rgba(params.color, 0.15 * alpha);
        ctx.fillRect(d.x + Math.cos(a) * rr, d.y + Math.sin(a) * rr, 1.4, 1.4);
      }
    }
    ctx.restore();
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
