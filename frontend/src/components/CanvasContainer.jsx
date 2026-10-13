import React, { useEffect, useRef } from 'react';
import { fabric } from 'fabric';
import { getStroke } from 'perfect-freehand';
import throttle from 'lodash.throttle';
import { useCanvasStore } from '../store/canvasStore';

/** One-shot request/response over socket.io with timeout. */
function emitOnce(socket, emitEvent, emitData, okEvent, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out'));
    }, timeoutMs);
    const onOk = (data) => { cleanup(); resolve(data); };
    const onRejected = (data) => {
      cleanup();
      reject(new Error(data.reason || data.message || data.code || 'rejected'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off(okEvent, onOk);
      socket.off('commit:rejected', onRejected);
    }
    socket.once(okEvent, onOk);
    socket.once('commit:rejected', onRejected);
    socket.emit(emitEvent, emitData);
  });
}

function polygonToPath(outline) {
  if (!outline.length) return '';
  const d = outline.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `${d} Z`;
}

function strokeBounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

export function CanvasContainer() {
  const wrapRef = useRef(null);
  const canvasElRef = useRef(null);
  const fabricRef = useRef(null);
  const drawRef = useRef({ drawing: false, points: [], ghostSessionId: null, seq: 0, preview: null });
  const renderedRef = useRef(new Map()); // stroke/sticker/ghost id -> fabric object
  const spaceHeld = useRef(false);

  const socket = useCanvasStore((s) => s.socket);
  const strokes = useCanvasStore((s) => s.strokes);
  const stickers = useCanvasStore((s) => s.stickers);
  const ghosts = useCanvasStore((s) => s.ghosts);
  const tool = useCanvasStore((s) => s.tool);
  const toolConfig = useCanvasStore((s) => s.toolConfig);
  const stickerAsset = useCanvasStore((s) => s.stickerAsset);
  const permissions = useCanvasStore((s) => s.permissions);
  const setHoverInfo = useCanvasStore((s) => s.setHoverInfo);

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const cfgRef = useRef(toolConfig);
  cfgRef.current = toolConfig;

  // --- init fabric canvas ---
  useEffect(() => {
    const canvas = new fabric.Canvas(canvasElRef.current, {
      selection: false,
      backgroundColor: '#0a0a0a',
      fireRightClick: true,
      stopContextMenu: true,
    });
    fabricRef.current = canvas;

    const resize = () => {
      const el = wrapRef.current;
      if (!el) return;
      canvas.setWidth(el.clientWidth);
      canvas.setHeight(el.clientHeight);
      canvas.requestRenderAll();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current);

    const onKeyDown = (e) => { if (e.code === 'Space') { spaceHeld.current = true; e.preventDefault(); } };
    const onKeyUp = (e) => { if (e.code === 'Space') spaceHeld.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Wheel zoom
    const onWheel = (e) => {
      e.preventDefault();
      const pt = canvas.getPointer(e);
      let zoom = canvas.getZoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      zoom = Math.min(8, Math.max(0.1, zoom));
      canvas.zoomToPoint(pt, zoom);
    };
    canvasElRef.current.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvasElRef.current?.removeEventListener('wheel', onWheel);
      canvas.dispose();
      fabricRef.current = null;
    };
  }, []);

  // --- render committed strokes ---
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const rendered = renderedRef.current;
    const seen = new Set();

    for (const s of strokes) {
      seen.add(`stroke:${s.id}`);
      if (rendered.has(`stroke:${s.id}`) || !s.path) continue;
      const obj = new fabric.Path(s.path, {
        fill: '',
        stroke: s.style.color,
        strokeWidth: s.style.width,
        opacity: s.style.opacity,
        selectable: false,
        evented: false,
      });
      canvas.add(obj);
      rendered.set(`stroke:${s.id}`, obj);
    }

    for (const [key, obj] of [...rendered]) {
      if (key.startsWith('stroke:') && !seen.has(key)) {
        canvas.remove(obj);
        rendered.delete(key);
      }
    }
    canvas.requestRenderAll();
  }, [strokes]);

  // --- render stickers ---
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const rendered = renderedRef.current;
    const seen = new Set();

    for (const st of stickers) {
      seen.add(`sticker:${st.id}`);
      if (rendered.has(`sticker:${st.id}`)) continue;
      const obj = new fabric.Text(st.assetId, {
        left: st.x, top: st.y,
        fontSize: 40,
        originX: 'center', originY: 'center',
        selectable: false, evented: false,
      });
      canvas.add(obj);
      rendered.set(`sticker:${st.id}`, obj);
    }
    canvas.requestRenderAll();
  }, [stickers]);

  // --- render ghost previews ---
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const rendered = renderedRef.current;
    const seen = new Set();

    for (const [id, g] of Object.entries(ghosts)) {
      const key = `ghost:${id}`;
      seen.add(key);
      if (g.points.length < 2) continue;
      if (rendered.has(key)) canvas.remove(rendered.get(key));
      const pts = g.points.map((p) => new fabric.Point(p.x, p.y));
      const obj = new fabric.Polyline(pts, {
        stroke: g.style?.color || '#fff',
        strokeWidth: g.style?.size || 4,
        opacity: 0.5,
        fill: '',
        selectable: false,
        evented: false,
      });
      canvas.add(obj);
      rendered.set(key, obj);
    }

    for (const [key, obj] of [...rendered]) {
      if (key.startsWith('ghost:') && !seen.has(key)) {
        canvas.remove(obj);
        rendered.delete(key);
      }
    }
    canvas.requestRenderAll();
  }, [ghosts]);

  // --- hover -> spatial query (throttled) ---
  const queryHover = useRef(
    throttle((socket, worldPt, clientX, clientY) => {
      if (!socket) return;
      useCanvasStore.getState().setHoverInfo({ x: clientX, y: clientY, hits: [] });
      socket.emit('query:spatial', {
        point: { x: worldPt.x, y: worldPt.y },
        radius: 14,
        timestamp: Date.now(),
      });
    }, 180)
  ).current;

  // --- pointer handlers ---
  useEffect(() => {
    const canvas = fabricRef.current;
    const el = canvasElRef.current;
    if (!canvas || !el) return;

    const pan = { active: false, startX: 0, startY: 0, vpt: null };

    const onPointerDown = async (e) => {
      const s = useCanvasStore.getState();
      const sock = s.socket;
      const pt = canvas.getPointer(e);
      const currentTool = toolRef.current;

      // Pan: pan tool, space held, or middle mouse
      if (currentTool === 'pan' || spaceHeld.current || e.button === 1) {
        pan.active = true;
        pan.startX = e.clientX;
        pan.startY = e.clientY;
        pan.vpt = [...canvas.viewportTransform];
        canvas.setCursor('grabbing');
        return;
      }

      if (!sock || !s.authenticated) return;
      if (currentTool === 'sticker') {
        if (!s.permissions.includes('sticker')) return;
        sock.emit('sticker:place', {
          assetId: s.stickerAsset,
          parentArtworkId: null,
          transform: { x: pt.x, y: pt.y, scale: 1, rotation: 0 },
          zIndex: 0,
        });
        return;
      }

      // Brush
      if (currentTool !== 'brush' || !s.permissions.includes('write')) return;
      const d = drawRef.current;
      d.drawing = true;
      d.points = [{ x: pt.x, y: pt.y, pressure: 0.5 }];
      d.seq = 0;

      try {
        const confirmed = await emitOnce(
          sock,
          'ghost:start',
          { tool: 'brush', toolConfig: cfgRef.current, viewport: null },
          'ghost:confirmed'
        );
        d.ghostSessionId = confirmed.ghostSessionId;
      } catch (err) {
        d.drawing = false;
        useCanvasStore.getState().setHoverInfo(null);
      }
    };

    const streamThrottled = throttle((sock, sessionId, seq, points) => {
      sock.emit('ghost:stream', { ghostSessionId: sessionId, sequence: seq, points });
    }, 50);

    const onPointerMove = (e) => {
      const pt = canvas.getPointer(e);

      if (pan.active) {
        const vpt = [...pan.vpt];
        vpt[4] = pan.vpt[4] + (e.clientX - pan.startX);
        vpt[5] = pan.vpt[5] + (e.clientY - pan.startY);
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
        return;
      }

      const d = drawRef.current;
      const s = useCanvasStore.getState();

      if (d.drawing && d.ghostSessionId && s.socket) {
        d.points.push({ x: pt.x, y: pt.y, pressure: 0.5 });
        d.seq += 1;

        // Local preview
        const outline = getStroke(d.points, {
          size: cfgRef.current.size,
          thinning: 0.6,
          smoothing: 0.5,
          streamline: 0.5,
        });
        const pathData = polygonToPath(outline);
        if (d.preview) canvas.remove(d.preview);
        if (pathData) {
          d.preview = new fabric.Path(pathData, {
            fill: cfgRef.current.color,
            opacity: cfgRef.current.opacity,
            selectable: false,
            evented: false,
          });
          canvas.add(d.preview);
          canvas.requestRenderAll();
        }

        streamThrottled(s.socket, d.ghostSessionId, d.seq, d.points.slice(-20));
      } else if (!d.drawing && s.authenticated) {
        queryHover(s.socket, pt, e.clientX, e.clientY);
      }
    };

    const onPointerUp = async () => {
      if (pan.active) {
        pan.active = false;
        canvas.setCursor('default');
        return;
      }

      const d = drawRef.current;
      if (!d.drawing) return;
      d.drawing = false;

      const s = useCanvasStore.getState();
      const sock = s.socket;
      if (d.preview) {
        fabricRef.current.remove(d.preview);
        d.preview = null;
        fabricRef.current.requestRenderAll();
      }

      if (!sock || !d.ghostSessionId || d.points.length < 2) {
        d.ghostSessionId = null;
        return;
      }

      try {
        const bounds = strokeBounds(d.points);
        const approved = await emitOnce(
          sock,
          'commit:request',
          { finalBounds: bounds, ghostSessionId: d.ghostSessionId },
          'commit:approved'
        );

        const outline = getStroke(d.points, {
          size: cfgRef.current.size,
          thinning: 0.6,
          smoothing: 0.5,
          streamline: 0.5,
        });

        sock.emit('commit:finalize', {
          transactionId: approved.transactionId,
          strokeData: {
            path: polygonToPath(outline),
            simplifiedPoints: d.points.filter((_, i) => i % 3 === 0),
            pressureProfile: d.points.map((p) => p.pressure ?? 0.5),
          },
          metadata: {},
        });
      } catch (err) {
        useCanvasStore.setState({ lastError: `Commit failed: ${err.message}` });
      } finally {
        d.ghostSessionId = null;
        d.points = [];
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      streamThrottled.cancel();
      queryHover.cancel();
    };
  }, []);

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasElRef} />
    </div>
  );
}
