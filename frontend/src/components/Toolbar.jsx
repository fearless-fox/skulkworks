import React from 'react';
import { useCanvasStore } from '../store/canvasStore';

const STICKER_PRESETS = ['⭐', '🔥', '💀', '🌹', '👁️', '⚡'];

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
