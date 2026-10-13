import React from 'react';
import { useCanvasStore } from '../store/canvasStore';

export function MetadataPanel() {
  const hoverInfo = useCanvasStore((s) => s.hoverInfo);
  const setHoverInfo = useCanvasStore((s) => s.setHoverInfo);

  if (!hoverInfo || !hoverInfo.hits || hoverInfo.hits.length === 0) return null;

  const style = {
    left: Math.min(hoverInfo.x + 16, window.innerWidth - 240),
    top: Math.min(hoverInfo.y + 16, window.innerHeight - 160),
  };

  return (
    <div className="metadata-panel visible" style={style}>
      <button
        onClick={() => setHoverInfo(null)}
        style={{
          float: 'right', background: 'none', border: 'none',
          color: '#888', cursor: 'pointer', fontSize: 14,
        }}
      >
        ×
      </button>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        {hoverInfo.hits.length} artwork{hoverInfo.hits.length > 1 ? 's' : ''} here
      </div>
      {hoverInfo.hits.slice(0, 5).map((hit) => (
        <div key={hit.id} style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>
          <div>by {hit.artistId?.slice(0, 8) || 'unknown'}</div>
          <div style={{ color: '#666' }}>
            {hit.timestamp ? new Date(hit.timestamp).toLocaleString() : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
