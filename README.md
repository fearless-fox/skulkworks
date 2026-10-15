# Skulkworks

A persistent collaborative infinite canvas — a living wall that never forgets.
Artists paint together in real time; finished epochs archive to the Hall of Fame.

A skulk is a group of foxes. This is their workshop.

## Structure

- `backend/` — Node/Express + Socket.io real-time server, Prisma/Postgres,
  Redis + BullMQ. See `backend/README.md` for the socket protocol.
- `frontend/` — React + Vite + fabric.js canvas client.

## Quick start

Start the backend and frontend in **separate terminals** from the repository root.

### Terminal 1: backend

```bash
cd backend
docker compose up -d
cp -n .env.example .env
# Edit .env and replace JWT_SECRET with a local secret.
npm install
npx prisma migrate dev
npm run dev
```

### Terminal 2: frontend

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:3000`. The backend creates one persistent community
canvas on first startup, and the app automatically opens it for everyone.
Connect a wallet or sign in with a JWT to join; users do not need to create a
canvas. The canvas and its artwork persist in the Postgres volume.
