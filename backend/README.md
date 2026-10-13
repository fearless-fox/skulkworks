# Skulkworks — backend

Persistent collaborative infinite canvas. Node/Express + Socket.io, Prisma/Postgres,
Redis + BullMQ.

## Quick start

```bash
# 1. Infra
docker compose up -d

# 2. Env
cp .env.example .env
# set JWT_SECRET (and STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET for brush purchases)

# 3. Deps + DB
npm install
npx prisma migrate dev

# 4. Run
npm run dev
```

Health: `GET http://localhost:4000/health`

## Socket protocol

| Client → server | Purpose |
|---|---|
| `auth:challenge` `{canvasId}` | Get a one-time message to sign (wallet flow) |
| `auth:authenticate` `{token}` or `{walletAddress, message, signature, canvasId}` | JWT or EIP-191 wallet auth |
| `ghost:start` / `ghost:stream` | Live stroke preview (spectators see 0.5 opacity) |
| `commit:request` `{finalBounds, ghostSessionId}` | Ask to finalize (rate limit, epoch, collision, region lock) |
| `commit:finalize` `{transactionId, strokeData, metadata}` | Persist the stroke |
| `sticker:place` `{assetId, parentArtworkId, transform, zIndex}` | Place a sticker/artwork |
| `query:spatial` `{point, radius, timestamp}` | Hover metadata lookup |
| `viewport:update` | Viewport hint (currently ack-only) |

| Server → client | Purpose |
|---|---|
| `auth:required` / `auth:challenge` / `auth:success` / `auth:error` | Auth flow |
| `ghost:confirmed` / `ghost:relay` | Preview session + spectator relay |
| `commit:approved` / `commit:rejected` | Finalization gate |
| `art:committed` | New persisted artwork (broadcast) |
| `sticker:placed` | New sticker (broadcast) |
| `canvas:init` | Last 100 transactions + spatial snapshot |
| `epoch:transition` / `epoch:archived` | Epoch lifecycle |
| `query:result` | Spatial query hits |

## Brush marketplace

Brush catalog lives in `shared/brushes.json` (tiers: `free`, `premium`, `ad`).
The server validates brush entitlement on every `commit:finalize` — clients can
forge any brushId, so the server is the source of truth.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/brushes` | — | Public catalog |
| `GET /api/brushes/me` | optional JWT | Catalog with `owned` flags |
| `POST /api/brushes/purchase` `{brushId}` | JWT | Stripe Checkout session URL |
| `POST /api/stripe/webhook` | Stripe sig | Fulfillment → permanent grant |
| `POST /api/ads/reward` `{brushId}` | JWT | 24h grant for ad-tier brushes |

Socket auth (`auth:success`) now includes a `restToken` JWT so wallet-logged-in
users can call the marketplace API too. Purchases require `STRIPE_SECRET_KEY`;
without it the purchase endpoint returns 503. Point Stripe webhooks at
`/api/stripe/webhook` with `STRIPE_WEBHOOK_SECRET` set.

## Notes

- Write permission: account older than 24h, not banned, < 1000 contributions on the canvas.
- Painting opaquely (opacity > 0.3) over occupied cells is rejected — use stickers,
  which carry the artist's cover/add-to/stand-alone intent.
- Epochs: OPEN → READ_ONLY at `endsAt`, archived ~24h later. Archives land in
  `./archives/` served at `/archives/:canvasId.svg`. Timelapse `.mp4` renders
  automatically on archival (node-canvas + ffmpeg, max 300 frames @ 30fps).
  Requires an `ffmpeg` binary on PATH.
- Set `ARCHIVE_PROVIDER=ipfs` (plus provider keys) for the Hall of Fame once a
  pinning service is chosen.
