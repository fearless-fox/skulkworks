import React, { useEffect, useState } from 'react';
import { useCanvasStore } from '../store/canvasStore';

export function AuthBar() {
  const connected = useCanvasStore((s) => s.connected);
  const authenticated = useCanvasStore((s) => s.authenticated);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const setCanvasId = useCanvasStore((s) => s.setCanvasId);
  const connect = useCanvasStore((s) => s.connect);
  const authenticateJwt = useCanvasStore((s) => s.authenticateJwt);
  const authenticateWallet = useCanvasStore((s) => s.authenticateWallet);
  const logout = useCanvasStore((s) => s.logout);
  const lastError = useCanvasStore((s) => s.lastError);
  const clearError = useCanvasStore((s) => s.clearError);

  const [token, setToken] = useState('');
  const hasProvider = typeof window !== 'undefined' && !!window.ethereum;

  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connected) {
    return (
      <div style={{ padding: '8px 16px', fontSize: 12, color: '#f87171' }}>
        Connecting to mural server…
      </div>
    );
  }

  if (authenticated) {
    return (
      <div style={{ padding: '4px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#666' }}>canvas: {canvasId.slice(0, 8)}…</span>
        <button onClick={logout} style={{ fontSize: 11, background: 'none', border: '1px solid #444', color: '#aaa', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
          disconnect
        </button>
        {lastError && (
          <span style={{ fontSize: 11, color: '#f87171' }} onClick={clearError}>{lastError} (dismiss)</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 16px', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
      <input
        placeholder="canvas id"
        value={canvasId}
        onChange={(e) => setCanvasId(e.target.value)}
        style={{ background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '4px 8px', width: 280 }}
      />
      <input
        placeholder="paste JWT (optional)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        type="password"
        style={{ background: '#111', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '4px 8px', width: 220 }}
      />
      <button
        onClick={() => authenticateJwt(token)}
        disabled={!token || !canvasId}
        style={{ background: '#222', border: '1px solid #444', color: '#fff', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
      >
        sign in
      </button>
      {hasProvider && (
        <button
          onClick={authenticateWallet}
          disabled={!canvasId}
          style={{ background: '#3b82f6', border: 'none', color: '#fff', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
        >
          connect wallet
        </button>
      )}
      {lastError && (
        <span style={{ fontSize: 11, color: '#f87171', cursor: 'pointer' }} onClick={clearError}>{lastError}</span>
      )}
    </div>
  );
}
