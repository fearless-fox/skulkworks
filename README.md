# Skulkworks

A persistent collaborative infinite canvas — a living wall that never forgets.
Artists paint together in real time; finished epochs archive to the Hall of Fame.

A skulk is a group of foxes. This is their workshop.

## Structure

- `backend/` — Node/Express + Socket.io real-time server, Prisma/Postgres,
  Redis + BullMQ. See `backend/README.md` for the socket protocol.
- `frontend/` — React + Vite + fabric.js canvas client.

## Quick start

```bash
# backend
cd backend
docker compose up -d
cp .env.example .env   # set JWT_SECRET
npm install
npx prisma migrate dev
npm run dev            # :4000

# frontend
cd frontend
npm install
npm run dev            # :3000
```

Open `http://localhost:3000/?canvas=<canvas-id>`, connect a wallet or paste a JWT.
