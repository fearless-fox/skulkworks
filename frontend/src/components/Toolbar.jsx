import React from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { listBrushes } from '../brushes';

const STICKER_PRESETS = ['⭐', '🔥', '💀', '🌹', '👁️', '⚡'];

const TIER_BADGE = {
  free: null,
  premium: '★',
  ad: '▶',
};

export function Toolbar() {
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);
  const toolConfig = useCanvasStore((s) => s.toolConfig);
  const setToolConfig = useCanvasStore((s) => s.setToolConfig);
  const stickerAsset = useCanvasStore((s) => s.stickerAsset);
  const setStickerAsset = useCanvasStore((s) => s.setStickerAsset);
  const permissions = useCanvasStore((s) => s.permissions);
  const authenticated = useCanvasStore((s) => s.authenticated);

  const canWrite = permissions.includes('write');
  const canSticker = permissions.includes('sticker');
  const disabled = !authenticated;
  const brushes = listBrushes().filter((b) => b.id !== 'eraser');

  const btn = (id, label, enabled = true) => (
    <button
      key={id}
      className={`tool-btn ${tool === id ? 'active' : ''}`}
      disabled={disabled || !enabled}
      onClick={() => setTool(id)}
      title={id}
    >
      {label}
    </button>
  );

  return (
    <div className="toolbar">
      {btn('brush', '🖌️', canWrite)}
      {btn('sticker', '⭐', canSticker)}
      {btn('pan', '✋')}

      {tool === 'brush' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {brushes.map((b) => (
            <button
              key={b.id}
              className={`tool-btn ${toolConfig.brushId === b.id ? 'active' : ''}`}
              disabled={disabled || !canWrite}
              onClick={() => setToolConfig({ brushId: b.id })}
              title={`${b.name} — ${b.description}`}
              style={{ width: 'auto', padding: '4px 8px', fontSize: 11, position: 'relative' }}
            >
              {b.name}
              {TIER_BADGE[b.tier] && (
                <span style={{ marginLeft: 4, color: '#fbbf24' }}>{TIER_BADGE[b.tier]}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <input
        type="color"
        value={toolConfig.color}
        disabled={disabled}
        onChange={(e) => setToolConfig({ color: e.target.value })}
        title="Color"
        style={{ width: 40, height: 28, padding: 0, border: 'none', background: 'none' }}
      />
      <input
        type="range"
        min={2}
        max={48}
        value={toolConfig.size}
        disabled={disabled}
        onChange={(e) => setToolConfig({ size: Number(e.target.value) })}
        title={`Size ${toolConfig.size}`}
        style={{ width: 90 }}
      />
      <input
        type="range"
        min={10}
        max={100}
        value={Math.round(toolConfig.opacity * 100)}
        disabled={disabled}
        onChange={(e) => setToolConfig({ opacity: Number(e.target.value) / 100 })}
        title={`Opacity ${Math.round(toolConfig.opacity * 100)}%`}
        style={{ width: 90 }}
      />

      {tool === 'sticker' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 120 }}>
          {STICKER_PRESETS.map((a) => (
            <button
              key={a}
              className={`tool-btn ${stickerAsset === a ? 'active' : ''}`}
              style={{ width: 32, height: 32, fontSize: 18 }}
              onClick={() => setStickerAsset(a)}
            >
              {a}
            </button>
          ))}
        </div>
      )}

      {!canWrite && authenticated && (
        <div style={{ fontSize: 10, color: '#888', maxWidth: 120 }}>
          View-only: epoch closed or no write permission
        </div>
      )}
    </div>
  );
}
