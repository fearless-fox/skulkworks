import React, { useState } from 'react';
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
  const brushCatalog = useCanvasStore((s) => s.brushCatalog);
  const brushOwned = useCanvasStore((s) => s.brushOwned);
  const purchaseBrush = useCanvasStore((s) => s.purchaseBrush);
  const unlockWithAd = useCanvasStore((s) => s.unlockWithAd);
  const [unlocking, setUnlocking] = useState(null);

  const canWrite = permissions.includes('write');
  const canSticker = permissions.includes('sticker');
  const disabled = !authenticated;
  const brushes = listBrushes().filter((b) => b.id !== 'eraser');
  const ownedOf = (id) => brushCatalog.length === 0 || brushOwned(id);

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

  const unlockingBrush = unlocking ? brushes.find((b) => b.id === unlocking) : null;

  return (
    <div className="toolbar">
      {btn('brush', '🖌️', canWrite)}
      {btn('sticker', '⭐', canSticker)}
      {btn('pan', '✋')}

      {tool === 'brush' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {brushes.map((b) => {
            const owned = ownedOf(b.id);
            return (
              <button
                key={b.id}
                className={`tool-btn ${toolConfig.brushId === b.id ? 'active' : ''}`}
                disabled={disabled || !canWrite}
                onClick={() => (owned ? setToolConfig({ brushId: b.id }) : setUnlocking(b.id))}
                title={`${b.name} — ${b.description}${owned ? '' : ' (locked)'}`}
                style={{ width: 'auto', padding: '4px 8px', fontSize: 11, position: 'relative', opacity: owned ? 1 : 0.55 }}
              >
                {owned ? b.name : `🔒 ${b.name}`}
                {TIER_BADGE[b.tier] && (
                  <span style={{ marginLeft: 4, color: '#fbbf24' }}>{TIER_BADGE[b.tier]}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {unlockingBrush && (
        <div style={{ background: '#1a1a1a', border: '1px solid #fbbf24', borderRadius: 8, padding: 10, maxWidth: 160 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{unlockingBrush.name}</div>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>{unlockingBrush.description}</div>
          {unlockingBrush.tier === 'premium' && (
            <button
              onClick={() => { purchaseBrush(unlockingBrush.id); setUnlocking(null); }}
              style={{ width: '100%', background: '#3b82f6', border: 'none', color: '#fff', borderRadius: 4, padding: '6px 0', cursor: 'pointer', marginBottom: 4 }}
            >
              Buy ${(unlockingBrush.priceCents / 100).toFixed(2)}
            </button>
          )}
          {unlockingBrush.tier === 'ad' && (
            <button
              onClick={() => { unlockWithAd(unlockingBrush.id); setUnlocking(null); }}
              style={{ width: '100%', background: '#22c55e', border: 'none', color: '#000', borderRadius: 4, padding: '6px 0', cursor: 'pointer', marginBottom: 4 }}
            >
              ▶ Watch ad — free 24h
            </button>
          )}
          <button
            onClick={() => setUnlocking(null)}
            style={{ width: '100%', background: 'none', border: '1px solid #444', color: '#aaa', borderRadius: 4, padding: '4px 0', cursor: 'pointer', fontSize: 11 }}
          >
            cancel
          </button>
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
