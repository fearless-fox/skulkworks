import React, { useEffect, useState } from 'react';
import { useCanvasStore } from '../store/canvasStore';

function fmt(ms) {
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function EpochStatus({ state }) {
  const epochEndsAt = useCanvasStore((s) => s.epochEndsAt);
  const archiveUrl = useCanvasStore((s) => s.archiveUrl);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {epochEndsAt && state === 'OPEN' && (
        <span style={{ fontSize: 11, color: '#888' }}>{fmt(epochEndsAt - Date.now())} left</span>
      )}
      {state === 'ARCHIVED' && archiveUrl && (
        <a href={archiveUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#60a5fa' }}>
          archive
        </a>
      )}
      <div className={`epoch-status ${state}`}>{state.replace('_', ' ')}</div>
    </div>
  );
}
