const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

// Import services
const CollisionService = require('./services/CollisionService');
const EpochService = require('./services/EpochService');
const SpatialIndexService = require('./services/SpatialIndexService');
const AuthService = require('./services/AuthService');
const { createArchiveProvider } = require('./services/ArchiveService');
const TimelapseService = require('./services/TimelapseService');
const BrushService = require('./services/BrushService');

// Stripe (optional — brush purchases disabled without STRIPE_SECRET_KEY)
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Initialize services
const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Rate limit exceeded' }
});
app.use(limiter);

// Stripe webhook — registered BEFORE express.json() because it needs the raw body
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, brushId } = session.metadata || {};
      if (userId && brushId) {
        await brushService.grantBrush(userId, brushId, 'PURCHASE', null);
        logger.info(`Purchase fulfilled: brush ${brushId} -> user ${userId}`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook error:', err.message);
    res.status(400).json({ error: 'Webhook signature verification failed' });
  }
});

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Redis clients for Socket.IO adapter
const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const subClient = pubClient.duplicate();

// Redis client for data operations
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

// BullMQ queues
const epochQueue = new Queue('epoch-transitions', { connection: redisClient });
const archivalQueue = new Queue('archival-jobs', { connection: redisClient });

// Initialize Socket.IO with Redis adapter
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  // Connection state recovery
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  }
});

// Initialize services
const collisionService = new CollisionService(redisClient, logger);
const spatialIndexService = new SpatialIndexService(redisClient, logger);
const archiveProvider = createArchiveProvider(logger);
const timelapseService = new TimelapseService({
  logger,
  archiveDir: path.join(__dirname, '..', 'archives'),
  baseUrl: process.env.ARCHIVE_BASE_URL || 'http://localhost:4000',
});
const epochService = new EpochService(prisma, redisClient, epochQueue, logger, archiveProvider, timelapseService);
const authService = new AuthService(prisma, logger);
const brushService = new BrushService(prisma, logger);

// Serve archived epoch artifacts
app.use('/archives', express.static(path.join(__dirname, '..', 'archives')));

// Connection tracking
const activeConnections = new Map();
const canvasSubscriptions = new Map();

async function initializeServer() {
  try {
    // Connect Redis clients
    await pubClient.connect();
    await subClient.connect();
    await redisClient.connect();

    // Setup Redis adapter for horizontal scaling
    io.adapter(createAdapter(pubClient, subClient));

    logger.info('Redis adapter connected');

    // Setup epoch monitoring
    await epochService.initialize(io);

    logger.info('Server initialization complete');
  } catch (error) {
    logger.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

// Socket.IO connection handling
io.on('connection', async (socket) => {
  const connectionId = uuidv4();
  activeConnections.set(connectionId, {
    socket,
    authenticated: false,
    userId: null,
    canvasId: null,
    ghostSession: null,
    rateLimitBucket: { tokens: 60, lastRefill: Date.now() }
  });

  logger.info(`Client connected: ${socket.id}, ConnectionID: ${connectionId}`);

  // Send auth challenge
  socket.emit('auth:required', {
    methods: ['jwt', 'wallet'],
    serverTime: Date.now()
  });

  // Wallet auth: issue a one-time challenge message to sign
  socket.on('auth:challenge', async (data) => {
    try {
      const { canvasId } = data || {};
      if (!canvasId) {
        return socket.emit('auth:error', { code: 'CANVAS_REQUIRED', message: 'canvasId required' });
      }
      const nonce = uuidv4();
      const issuedAt = Date.now();
      const message = [
        'Skulkworks sign-in',
        `canvas: ${canvasId}`,
        `nonce: ${nonce}`,
        `issued: ${issuedAt}`
      ].join('\n');
      await redisClient.setEx(
        `auth:nonce:${nonce}`,
        300,
        JSON.stringify({ canvasId, issuedAt })
      );
      socket.emit('auth:challenge', { nonce, message, issuedAt });
    } catch (error) {
      logger.error('Challenge error:', error);
      socket.emit('auth:error', { code: 'SERVER_ERROR', message: 'Internal server error' });
    }
  });

  // Shared post-auth flow for JWT and wallet methods
  async function completeAuthentication(user, canvasId) {
    // Check canvas exists and get state
    const canvas = await prisma.canvas.findUnique({
      where: { id: canvasId },
      include: { epoch: true }
    });

    if (!canvas) {
      socket.emit('auth:error', { code: 'CANVAS_NOT_FOUND', message: 'Canvas does not exist' });
      return;
    }

    // Check permissions based on epoch state
    const permissions = ['read'];
    if (canvas.epoch.state === 'OPEN') {
      const canWrite = await authService.checkWritePermission(user.id, canvas.id);
      if (canWrite) permissions.push('write', 'sticker');
    }

    // Update connection state
    const conn = activeConnections.get(connectionId);
    conn.authenticated = true;
    conn.userId = user.id;
    conn.canvasId = canvasId;
    conn.permissions = permissions;

    // Join canvas room
    socket.join(`canvas:${canvasId}`);

    // Track subscription
    if (!canvasSubscriptions.has(canvasId)) {
      canvasSubscriptions.set(canvasId, new Set());
    }
    canvasSubscriptions.get(canvasId).add(connectionId);

    // Send success response
    socket.emit('auth:success', {
      sessionId: connectionId,
      canvasState: canvas.epoch.state,
      permissions,
      authMethod: user.walletAddress ? 'wallet' : 'jwt',
      // REST token for marketplace API (works for both auth methods)
      restToken: authService.generateToken(user.id),
      rateLimit: {
        maxStrokesPerMinute: 60,
        currentBurst: 10
      },
      viewport: {
        lockedTo: null,
        currentEpochEndsAt: canvas.epoch.endsAt
      }
    });

    // Send initial canvas state
    const recentArt = await prisma.transaction.findMany({
      where: { canvasId },
      orderBy: { timestamp: 'desc' },
      take: 100,
      include: { artist: { select: { id: true, displayName: true } } }
    });

    socket.emit('canvas:init', {
      canvasId,
      state: canvas.epoch.state,
      recentTransactions: recentArt,
      spatialIndex: await spatialIndexService.getIndexSnapshot(canvasId)
    });

    logger.info(`User ${user.id} authenticated on canvas ${canvasId}`);
  }

  // Authentication handler (JWT token or wallet signature)
  socket.on('auth:authenticate', async (data) => {
    try {
      const { token, walletAddress, message, signature, canvasId, clientVersion } = data || {};
      let user = null;

      if (token) {
        user = await authService.verifyToken(token);
        if (!user) {
          return socket.emit('auth:error', { code: 'INVALID_TOKEN', message: 'Authentication failed' });
        }
      } else if (walletAddress && message && signature) {
        user = await authService.verifyWalletAuth({
          walletAddress, message, signature, canvasId, redis: redisClient
        });
        if (!user) {
          return socket.emit('auth:error', { code: 'INVALID_SIGNATURE', message: 'Wallet authentication failed' });
        }
      } else {
        return socket.emit('auth:error', {
          code: 'BAD_AUTH',
          message: 'Provide a JWT token or a wallet signature (get a challenge via auth:challenge first)'
        });
      }

      await completeAuthentication(user, canvasId);

    } catch (error) {
      logger.error('Authentication error:', error);
      socket.emit('auth:error', { code: 'SERVER_ERROR', message: 'Internal server error' });
    }
  });

  // Ghosting: Start preview session
  socket.on('ghost:start', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated || !conn.permissions?.includes('write')) {
      return socket.emit('error', { code: 'UNAUTHORIZED', message: 'Write permission required' });
    }

    const ghostSessionId = uuidv4();
    conn.ghostSession = {
      id: ghostSessionId,
      tool: data.tool,
      toolConfig: data.toolConfig,
      viewport: data.viewport,
      points: [],
      bounds: null,
      startedAt: Date.now()
    };

    socket.emit('ghost:confirmed', {
      ghostSessionId,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      serverTimestamp: Date.now()
    });
  });

  // Ghosting: Stream stroke data
  socket.on('ghost:stream', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.ghostSession || conn.ghostSession.id !== data.ghostSessionId) {
      return socket.emit('error', { code: 'INVALID_GHOST_SESSION', message: 'Ghost session not found' });
    }

    // Update session data
    conn.ghostSession.points.push(...data.points);

    // Update bounds
    const points = data.points;
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const newBounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys)
    };

    if (!conn.ghostSession.bounds) {
      conn.ghostSession.bounds = newBounds;
    } else {
      conn.ghostSession.bounds = {
        minX: Math.min(conn.ghostSession.bounds.minX, newBounds.minX),
        maxX: Math.max(conn.ghostSession.bounds.maxX, newBounds.maxX),
        minY: Math.min(conn.ghostSession.bounds.minY, newBounds.minY),
        maxY: Math.max(conn.ghostSession.bounds.maxY, newBounds.maxY)
      };
    }

    // Relay to other clients in canvas (spectator mode)
    socket.to(`canvas:${conn.canvasId}`).emit('ghost:relay', {
      artistId: conn.userId,
      ghostSessionId: data.ghostSessionId,
      sequence: data.sequence,
      points: data.points,
      style: {
        color: conn.ghostSession.toolConfig.color,
        opacity: 0.5,
        size: conn.ghostSession.toolConfig.size
      }
    });
  });

  // Commit: Request finalization
  socket.on('commit:request', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated || !conn.permissions?.includes('write')) {
      return socket.emit('commit:rejected', { code: 'UNAUTHORIZED', message: 'Write permission required' });
    }

    // Rate limiting check
    const now = Date.now();
    const timePassed = now - conn.rateLimitBucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / 1000); // 1 token per second
    conn.rateLimitBucket.tokens = Math.min(60, conn.rateLimitBucket.tokens + tokensToAdd);
    conn.rateLimitBucket.lastRefill = now;

    if (conn.rateLimitBucket.tokens < 1) {
      return socket.emit('commit:rejected', {
        code: 'RATE_LIMITED',
        reason: 'Stroke quota exceeded',
        retryAfter: Math.ceil((1 - conn.rateLimitBucket.tokens) * 1000),
        currentUsage: 60 - conn.rateLimitBucket.tokens,
        limit: 60
      });
    }

    // Check canvas state
    const canvas = await prisma.canvas.findUnique({
      where: { id: conn.canvasId },
      include: { epoch: true }
    });

    if (canvas.epoch.state !== 'OPEN') {
      return socket.emit('commit:rejected', {
        code: 'CANVAS_LOCKED',
        reason: `Canvas is ${canvas.epoch.state}`,
        currentState: canvas.epoch.state
      });
    }

    // Collision detection (erasers are exempt — they paint back to ground)
    if (!data.isEraser) {
      const collisionCheck = await collisionService.checkCollision(
        conn.canvasId,
        data.finalBounds,
        conn.ghostSession?.toolConfig?.opacity || 1.0
      );

      if (!collisionCheck.allowed) {
        return socket.emit('commit:rejected', {
          code: 'COLLISION_DETECTED',
          reason: collisionCheck.reason,
          conflicts: collisionCheck.conflicts,
          ghostSessionId: data.ghostSessionId,
          retryAllowed: true,
          alternative: collisionCheck.alternative
        });
      }
    }

    // Lock region for commit
    const regionLock = await collisionService.lockRegion(
      conn.canvasId,
      data.finalBounds,
      connectionId,
      30000 // 30 second lock
    );

    if (!regionLock.success) {
      return socket.emit('commit:rejected', {
        code: 'REGION_CONTENTION',
        reason: 'Another artist is committing to this region',
        retryAllowed: true
      });
    }

    // Track the granted lock on the connection for finalize/release
    conn.regionLockId = regionLock.lockId;

    // Consume rate limit token
    conn.rateLimitBucket.tokens--;

    // Generate transaction ID
    const transactionId = uuidv4();

    socket.emit('commit:approved', {
      transactionId,
      regionLock: {
        ...data.finalBounds,
        expiresAt: Date.now() + 30000
      },
      collisionReport: {
        checked: true,
        conflicts: 0,
        overlappingArtists: []
      }
    });
  });

  // Commit: Finalize with full data
  socket.on('commit:finalize', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated) {
      return socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }

    try {
      // Verify region lock
      const lockValid = await collisionService.verifyLock(
        conn.canvasId,
        conn.regionLockId,
        connectionId
      );

      if (!lockValid) {
        return socket.emit('error', { code: 'LOCK_EXPIRED', message: 'Region lock expired' });
      }

      // Brush entitlement: the server is the source of truth — clients can
      // forge any brushId in the payload, so validate before persisting.
      const brushId = data.strokeData?.brush?.id;
      if (brushId) {
        const entitled = await brushService.isEntitled(conn.userId, brushId);
        if (!entitled.ok) {
          return socket.emit('error', {
            code: entitled.reason,
            message: entitled.reason === 'UNKNOWN_BRUSH' ? 'Unknown brush' : 'Brush not owned — unlock it first',
          });
        }
      }

      // Re-fetch canvas and confirm epoch still open (defense in depth)
      const canvas = await prisma.canvas.findUnique({
        where: { id: conn.canvasId },
        include: { epoch: true }
      });

      if (!canvas || canvas.epoch.state !== 'OPEN') {
        await collisionService.releaseLock(conn.canvasId, conn.regionLockId);
        conn.regionLockId = null;
        return socket.emit('error', {
          code: 'CANVAS_LOCKED',
          message: `Canvas is ${canvas?.epoch?.state || 'missing'}`
        });
      }

      // Create transaction record
      const transaction = await prisma.transaction.create({
        data: {
          id: data.transactionId,
          canvasId: conn.canvasId,
          userId: conn.userId,
          type: 'stroke',
          timestamp: new Date(),
          payload: {
            path: data.strokeData.path,
            simplifiedPoints: data.strokeData.simplifiedPoints,
            pressureProfile: data.strokeData.pressureProfile,
            style: conn.ghostSession?.toolConfig,
            bounds: conn.ghostSession?.bounds,
            metadata: data.metadata
          }
        },
        include: {
          artist: {
            select: { id: true, displayName: true, avatar: true }
          }
        }
      });

      // Update spatial index
      await spatialIndexService.addToIndex(conn.canvasId, {
        id: transaction.id,
        type: 'stroke',
        bounds: conn.ghostSession.bounds,
        artistId: conn.userId,
        timestamp: transaction.timestamp
      });

      // Update occupancy map
      await collisionService.markOccupied(conn.canvasId, conn.ghostSession.bounds, {
        transactionId: transaction.id,
        artistId: conn.userId,
        opacity: conn.ghostSession?.toolConfig?.opacity || 1.0
      });

      // Release lock
      await collisionService.releaseLock(conn.canvasId, conn.regionLockId);
      conn.regionLockId = null;

      // Clear ghost session
      conn.ghostSession = null;

      // Broadcast to all clients in canvas
      const broadcastData = {
        transactionId: transaction.id,
        artist: transaction.artist,
        artworkData: {
          type: 'stroke',
          id: transaction.id,
          bounds: transaction.payload.bounds,
          path: transaction.payload.path,
          brush: transaction.payload.brush || null,
          style: {
            color: transaction.payload.style?.color,
            opacity: 1.0,
            width: transaction.payload.style?.size,
            blendMode: transaction.payload.style?.blendMode || 'source-over'
          }
        },
        timestamp: transaction.timestamp.getTime(),
        epochRemaining: canvas.epoch.endsAt - Date.now()
      };

      io.to(`canvas:${conn.canvasId}`).emit('art:committed', broadcastData);

      logger.info(`Transaction ${transaction.id} committed by ${conn.userId}`);

    } catch (error) {
      logger.error('Commit finalization error:', error);
      socket.emit('error', { code: 'COMMIT_FAILED', message: 'Failed to finalize artwork' });
    }
  });

  // Sticker operations
  socket.on('sticker:place', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated || !conn.permissions?.includes('sticker')) {
      return socket.emit('error', { code: 'UNAUTHORIZED', message: 'Sticker permission required' });
    }

    try {
      const stickerInstanceId = uuidv4();

      const sticker = await prisma.sticker.create({
        data: {
          id: stickerInstanceId,
          canvasId: conn.canvasId,
          creatorId: conn.userId,
          assetId: data.assetId,
          parentArtworkId: data.parentArtworkId,
          transform: data.transform,
          zIndex: data.zIndex
        }
      });

      // Broadcast sticker placement
      io.to(`canvas:${conn.canvasId}`).emit('sticker:placed', {
        stickerInstanceId: sticker.id,
        assetId: data.assetId,
        position: {
          global: { x: data.transform.x, y: data.transform.y },
          transform: data.transform
        },
        parentArtworkId: data.parentArtworkId,
        permissions: {
          canDelete: [conn.userId],
          canMove: [conn.userId]
        }
      });

    } catch (error) {
      logger.error('Sticker placement error:', error);
      socket.emit('error', { code: 'STICKER_FAILED', message: 'Failed to place sticker' });
    }
  });

  // Spatial query (hover)
  socket.on('query:spatial', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated) return;

    const results = await spatialIndexService.query(
      conn.canvasId,
      data.point,
      data.radius || 10
    );

    socket.emit('query:result', {
      hits: results,
      queryTimeMs: Date.now() - data.timestamp
    });
  });

  // Viewport update
  socket.on('viewport:update', async (data) => {
    const conn = activeConnections.get(connectionId);
    if (!conn?.authenticated) return;

    // Could use this for server-side culling optimization
    // For now, just acknowledge
    socket.emit('viewport:ack', { timestamp: Date.now() });
  });

  // Disconnect handling
  socket.on('disconnect', async (reason) => {
    const conn = activeConnections.get(connectionId);

    if (conn) {
      // Release any region lock
      if (conn.regionLockId) {
        await collisionService.releaseLock(conn.canvasId, conn.regionLockId);
      }

      // Remove from subscriptions
      if (conn.canvasId && canvasSubscriptions.has(conn.canvasId)) {
        canvasSubscriptions.get(conn.canvasId).delete(connectionId);
      }

      activeConnections.delete(connectionId);
    }

    logger.info(`Client disconnected: ${socket.id}, Reason: ${reason}`);
  });
});

// REST API endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    connections: activeConnections.size,
    redis: redisClient.isReady 
  });
});

// Dev-only login: mints a JWT for a throwaway local user.
// Gated by ALLOW_DEV_LOGIN=true — NEVER enable in production.
if (process.env.ALLOW_DEV_LOGIN === 'true') {
  logger.warn('DEV MODE: POST /api/auth/dev-login is enabled — do not use in production');
  app.post('/api/auth/dev-login', async (req, res) => {
    try {
      const { displayName } = req.body || {};
      const base =
        (typeof displayName === 'string' && displayName.trim().slice(0, 40)) || 'tester';
      const user = await prisma.user.create({
        data: {
          email: `dev-${Date.now()}-${Math.floor(Math.random() * 1e6)}@local.test`,
          displayName: `${base}-${Math.floor(Math.random() * 10000)}`,
        },
      });
      res.json({
        token: authService.generateToken(user.id),
        user: { id: user.id, displayName: user.displayName },
      });
    } catch (err) {
      logger.error('dev login failed', err);
      res.status(500).json({ error: 'Dev login failed' });
    }
  });
}

// List canvases (public, newest first)
app.get('/api/canvas', async (req, res) => {
  try {
    const canvases = await prisma.canvas.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { epoch: { select: { state: true, endsAt: true } } },
    });
    res.json({ canvases });
  } catch (err) {
    logger.error('canvas list failed', err);
    res.status(500).json({ error: 'Could not list canvases' });
  }
});

// Create a canvas (auth required) — opens its first epoch automatically
app.post('/api/canvas', restAuth, async (req, res) => {
  try {
    const { name, description, epochDays } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const days = Math.min(90, Math.max(1, Number(epochDays) || 7));
    const now = Date.now();
    const canvas = await prisma.canvas.create({
      data: {
        name: name.trim().slice(0, 120),
        description: typeof description === 'string' ? description.slice(0, 500) : null,
        creatorId: req.user.id,
        epoch: {
          create: {
            state: 'OPEN',
            endsAt: new Date(now + days * 24 * 3600 * 1000),
            archiveAt: new Date(now + (days + 1) * 24 * 3600 * 1000),
          },
        },
      },
      include: { epoch: true },
    });
    res.status(201).json({ canvas });
  } catch (err) {
    logger.error('canvas create failed', err);
    res.status(500).json({ error: 'Could not create canvas' });
  }
});

app.get('/api/canvas/:id/state', async (req, res) => {
  try {
    const canvas = await prisma.canvas.findUnique({
      where: { id: req.params.id },
      include: { epoch: true, _count: { select: { transactions: true } } }
    });

    if (!canvas) return res.status(404).json({ error: 'Canvas not found' });

    res.json({
      id: canvas.id,
      state: canvas.epoch.state,
      createdAt: canvas.createdAt,
      endsAt: canvas.epoch.endsAt,
      transactionCount: canvas._count.transactions,
      contributorCount: await prisma.transaction.groupBy({
        by: ['userId'],
        where: { canvasId: canvas.id }
      }).then(g => g.length)
    });
  } catch (error) {
    logger.error('API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Brush marketplace ----

// JWT auth for REST endpoints
async function restAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await authService.verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// Public catalog
app.get('/api/brushes', async (req, res) => {
  res.json({ brushes: brushService.listBrushes() });
});

// Catalog annotated with ownership (auth optional)
app.get('/api/brushes/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = token ? await authService.verifyToken(token) : null;
  res.json({ brushes: await brushService.catalogForUser(user?.id || null) });
});

// Buy a premium brush -> Stripe Checkout session
app.post('/api/brushes/purchase', restAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Purchases not configured' });
    const { brushId } = req.body || {};
    const brush = brushService.getBrush(brushId);
    if (!brush) return res.status(404).json({ error: 'Unknown brush' });
    if (brush.tier !== 'premium' || !brush.priceCents) {
      return res.status(400).json({ error: 'Brush is not purchasable' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: brush.priceCents,
          product_data: { name: `Skulkworks brush — ${brush.name}` },
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?brush_success=1`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?brush_cancelled=1`,
      metadata: { userId: req.user.id, brushId },
    });
    res.json({ url: session.url });
  } catch (error) {
    logger.error('Purchase error:', error);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Rewarded ad: grant an ad-tier brush for 24h.
// TODO: verify the ad view server-side with the ad network (e.g. AdMob SSV)
// before granting. Currently grants directly; abuse is mitigated by a
// dedicated rate limiter + the 24h grant expiry.
const adLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many ad rewards — try again later' },
});
app.post('/api/ads/reward', adLimiter, restAuth, async (req, res) => {
  try {
    const { brushId } = req.body || {};
    const brush = brushService.getBrush(brushId);
    if (!brush) return res.status(404).json({ error: 'Unknown brush' });
    if (brush.tier !== 'ad') {
      return res.status(400).json({ error: 'Brush is not ad-unlockable' });
    }
    const grant = await brushService.grantBrush(
      req.user.id, brushId, 'AD_REWARD', new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    res.json({ granted: true, brushId, expiresAt: grant.expiresAt });
  } catch (error) {
    logger.error('Ad reward error:', error);
    res.status(500).json({ error: 'Could not grant brush' });
  }
});

// Start server
const PORT = process.env.PORT || 4000;

initializeServer().then(() => {
  server.listen(PORT, () => {
    logger.info(`Skulkworks server running on port ${PORT}`);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
  });
  await prisma.$disconnect();
  await redisClient.quit();
  await pubClient.quit();
  await subClient.quit();
});
