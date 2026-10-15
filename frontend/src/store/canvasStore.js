import { create } from 'zustand';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined; // same-origin (vite proxy in dev)

/** Normalize a server transaction / committed artwork into a renderable stroke. */
function toStroke(tx) {
  const payload = tx.payload || {};
  const art = tx.artworkData || {};
  return {
    id: tx.id || tx.transactionId,
    type: 'stroke',
    path: payload.path || art.path,
    brush: payload.brush || art.brush || null,
    style: {
      color: payload.style?.color || art.style?.color || '#ffffff',
      opacity: payload.style?.opacity ?? art.style?.opacity ?? 1,
      width: payload.style?.size || payload.style?.width || art.style?.width || 4,
    },
    bounds: payload.bounds || art.bounds,
    artist: tx.artist || null,
    timestamp: tx.timestamp ? new Date(tx.timestamp).getTime() : Date.now(),
  };
}

export const useCanvasStore = create((set, get) => ({
  // --- connection / session ---
  socket: null,
  connected: false,
  authenticated: false,
  authMethod: null,
  permissions: [],
  sessionId: null,
  canvasId: new URLSearchParams(window.location.search).get('canvas') || '',
  canvasState: 'OPEN',
  epochEndsAt: null,
  lastError: null,

  // --- canvas content ---
  strokes: [],
  stickers: [],
  ghosts: {}, // ghostSessionId -> { points, style, artistId }

  // --- tools ---
  tool: 'brush',
  toolConfig: { brushId: 'ink', color: '#C13E1B', size: 12, opacity: 1 },
  stickerAsset: '⭐',
  brushCatalog: [], // [{ id, name, tier, priceCents, owned, ... }]

  // --- hover ---
  hoverInfo: null, // { x, y (screen px), hits }

  // --- simple setters ---
  setTool: (tool) => set({ tool }),
  setToolConfig: (patch) => set((s) => ({ toolConfig: { ...s.toolConfig, ...patch } })),
  setStickerAsset: (stickerAsset) => set({ stickerAsset }),
  setCanvasId: (canvasId) => set({ canvasId }),
  setHoverInfo: (hoverInfo) => set({ hoverInfo }),
  clearError: () => set({ lastError: null }),

  // --- socket lifecycle ---
  connect() {
    if (get().socket) return;
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

    socket.on('connect', async () => {
      set({ connected: true, lastError: null });
      if (get().canvasId) return;

      try {
        const response = await fetch('/api/canvas/default');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { canvas } = await response.json();
        if (!canvas?.id) throw new Error('Server returned no default canvas');
        if (get().canvasId) return;

        set({ canvasId: canvas.id });
        const url = new URL(window.location.href);
        url.searchParams.set('canvas', canvas.id);
        window.history.replaceState(null, '', url);

        const token = localStorage.getItem('mural_token');
        if (token) get().authenticateJwt(token);
      } catch (error) {
        set({ lastError: `Could not load the shared canvas: ${error.message}` });
      }
    });
    socket.on('disconnect', () =>
      set({ connected: false, authenticated: false, permissions: [] })
    );

    socket.on('auth:required', () => {
      // Prefer stored JWT; otherwise the user picks a method in the UI.
      const token = localStorage.getItem('mural_token');
      const { canvasId } = get();
      if (token && canvasId) get().authenticateJwt(token);
    });

    socket.on('auth:success', (data) => {
      // Persist REST token (minted for both JWT and wallet logins)
      if (data.restToken) localStorage.setItem('mural_token', data.restToken);
      set({
        authenticated: true,
        authMethod: data.authMethod || 'jwt',
        permissions: data.permissions || [],
        sessionId: data.sessionId,
        canvasState: data.canvasState,
        epochEndsAt: data.viewport?.currentEpochEndsAt || null,
      });
      get().fetchBrushes();
    });

    socket.on('auth:challenge', async ({ message }) => {
      // Wallet flow: sign the challenge via the injected provider.
      try {
        const { canvasId, walletAddress } = get()._walletPending || {};
        if (!window.ethereum || !walletAddress) throw new Error('no provider');
        const signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [message, walletAddress],
        });
        socket.emit('auth:authenticate', {
          walletAddress, message, signature, canvasId,
        });
        set({ _walletPending: null });
      } catch (e) {
        set({ lastError: 'Wallet signature rejected', _walletPending: null });
      }
    });

    socket.on('auth:error', (err) => set({ lastError: err.message || 'Auth failed' }));

    socket.on('canvas:init', (data) => {
      const strokes = (data.recentTransactions || [])
        .filter((t) => t.type === 'stroke' && (t.payload?.path || t.artworkData?.path))
        .map(toStroke);
      set({ strokes, canvasState: data.state });
    });

    socket.on('ghost:relay', (data) => {
      set((s) => ({
        ghosts: {
          ...s.ghosts,
          [data.ghostSessionId]: {
            points: data.points,
            style: data.style,
            artistId: data.artistId,
          },
        },
      }));
    });

    socket.on('art:committed', (data) => {
      const stroke = toStroke(data);
      set((s) => {
        // Drop any ghost previews from this artist — the real stroke landed.
        const ghosts = { ...s.ghosts };
        for (const [id, g] of Object.entries(ghosts)) {
          if (g.artistId === data.artist?.id) delete ghosts[id];
        }
        return { strokes: [...s.strokes, stroke], ghosts };
      });
    });

    socket.on('sticker:placed', (data) => {
      set((s) => ({
        stickers: [
          ...s.stickers,
          {
            id: data.stickerInstanceId,
            assetId: data.assetId,
            x: data.position?.global?.x ?? 0,
            y: data.position?.global?.y ?? 0,
            transform: data.position?.transform,
            parentArtworkId: data.parentArtworkId || null,
          },
        ],
      }));
    });

    socket.on('epoch:transition', (data) => {
      set({ canvasState: data.newState });
      if (data.scheduledArchive) set({ epochEndsAt: data.scheduledArchive });
    });

    socket.on('epoch:archived', (data) => {
      set({ canvasState: 'ARCHIVED', archiveUrl: data.archiveUrl });
    });

    socket.on('query:result', (data) => {
      const { hoverInfo } = get();
      if (hoverInfo) set({ hoverInfo: { ...hoverInfo, hits: data.hits } });
    });

    socket.on('error', (err) => set({ lastError: err.message || 'Server error' }));

    set({ socket });
  },

  disconnect() {
    get().socket?.disconnect();
    set({
      socket: null, connected: false, authenticated: false,
      permissions: [], strokes: [], stickers: [], ghosts: {},
    });
  },

  authenticateJwt(token) {
    const { socket, canvasId } = get();
    if (!socket || !canvasId) {
      set({ lastError: 'Enter a canvas ID first' });
      return;
    }
    localStorage.setItem('mural_token', token);
    socket.emit('auth:authenticate', { token, canvasId });
  },

  async authenticateWallet() {
    const { socket, canvasId } = get();
    if (!window.ethereum) {
      set({ lastError: 'No wallet provider found (install MetaMask)' });
      return;
    }
    if (!canvasId) {
      set({ lastError: 'Enter a canvas ID first' });
      return;
    }
    try {
      const [walletAddress] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      set({ _walletPending: { canvasId, walletAddress } });
      socket.emit('auth:challenge', { canvasId });
    } catch {
      set({ lastError: 'Wallet connection rejected' });
    }
  },

  logout() {
    localStorage.removeItem('mural_token');
    get().disconnect();
  },

  // --- brush marketplace ---
  apiBase() {
    return import.meta.env.VITE_SERVER_URL || '';
  },

  async fetchBrushes() {
    try {
      const token = localStorage.getItem('mural_token');
      const res = await fetch(`${get().apiBase()}/api/brushes/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (data.brushes) set({ brushCatalog: data.brushes });
    } catch {
      // catalog stays empty; brushes render from local registry regardless
    }
  },

  brushOwned(brushId) {
    const entry = get().brushCatalog.find((b) => b.id === brushId);
    // Unknown to catalog (or catalog not loaded): fall back to registry tier
    if (!entry) return true;
    return !!entry.owned;
  },

  async purchaseBrush(brushId) {
    const token = localStorage.getItem('mural_token');
    try {
      const res = await fetch(`${get().apiBase()}/api/brushes/purchase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ brushId }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else set({ lastError: data.error || 'Purchase failed' });
    } catch {
      set({ lastError: 'Purchase failed' });
    }
  },

  async unlockWithAd(brushId) {
    const token = localStorage.getItem('mural_token');
    try {
      const res = await fetch(`${get().apiBase()}/api/ads/reward`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ brushId }),
      });
      const data = await res.json();
      if (data.granted) {
        await get().fetchBrushes();
        set({ lastError: null });
      } else {
        set({ lastError: data.error || 'Ad reward failed' });
      }
    } catch {
      set({ lastError: 'Ad reward failed' });
    }
  },
}));
