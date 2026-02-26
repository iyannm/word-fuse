# Word Fuse

Word Fuse is a real-time multiplayer word game inspired by fast bomb-pass gameplay. Players join a shared room, race to submit valid words containing a required chunk, and avoid exploding when the timer runs out.

## Stack

- Monorepo with npm workspaces
- Client: React + TypeScript + Vite
- Server: Node.js + TypeScript + Express
- Real-time: Socket.IO
- State: in-memory room store on server
- Styling: plain CSS

## Project Structure

- `client/` React app (Home, Lobby, Game, Results)
- `server/` Express + Socket.IO authoritative game server

## Features

- Room creation with 6-character code
- Join by room code and display name
- Host controls before start:
  - Turn timer: 5-20 seconds
  - Starting lives: 1-5
  - Dictionary validation on/off
- Server-authoritative gameplay:
  - Active player must submit an unused alphabetic word (>=3 letters)
  - Word must contain required chunk
  - Optional dictionary validation from local `wordlist.txt`
  - Correct word passes bomb to next eligible player and resets timer
  - Timer expiry removes life; elimination at 0 lives
- Deterministic clockwise turn order based on lobby join order
- Eliminated and disconnected players are skipped for active turns
- Host reassignment on host disconnect (earliest joined connected player)
- Results screen with winner and final scoreboard
- Reconnect-aware client with connection status banner
- Basic rate limit on submissions (1 every 300ms per socket)

## Environment Defaults

### Server (`server/.env`)

Use `server/.env.example` as a template.

- `PORT=3001`
- `CLIENT_ORIGIN=http://localhost:5173`
- `DICTIONARY_ENABLED=true`

`CLIENT_ORIGIN` also supports comma-separated values for multiple frontends.

### Client (`client/.env`)

Use `client/.env.example` as a template.

- `VITE_SERVER_URL=http://localhost:3001`

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start both server and client:

```bash
npm run dev
```

3. Open client:

- http://localhost:5173

4. Open a second browser/device, join the same room code, and play.

## Mobile Device Testing (same LAN)

If testing phone + laptop:

1. Find your laptop LAN IP (example `192.168.1.50`).
2. Set server `CLIENT_ORIGIN` to your phone-accessible client URL, for example:
   - `http://192.168.1.50:5173`
3. Set client `VITE_SERVER_URL` to:
   - `http://192.168.1.50:3001`
4. Run `npm run dev --workspace server` and `npm run dev --workspace client`.
5. Open `http://192.168.1.50:5173` on phone.

## Scripts

### Root

- `npm run dev` - runs server and client concurrently
- `npm run build` - builds server and client

### Server

- `npm run dev --workspace server` - ts-node-dev server
- `npm run build --workspace server` - compile TypeScript
- `npm run start --workspace server` - run built server

### Client

- `npm run dev --workspace client` - Vite dev server
- `npm run build --workspace client` - typecheck + Vite build
- `npm run preview --workspace client` - preview production build

## Deploy (Vercel + Socket Server)

This project uses Socket.IO with a long-lived server process. Vercel Functions cannot act as a WebSocket server, so deploy in two parts:

1. Deploy `client/` to Vercel.
2. Deploy `server/` to a Node host (for example Railway, Render, Fly.io, or your own VM).

### 1) Deploy client to Vercel

In Vercel, create a new project from this repo and set:

- **Root Directory**: `client`
- **Framework Preset**: `Vite`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

Set environment variable in Vercel project:

- `VITE_SERVER_URL=https://<your-server-domain>`

Redeploy after setting env vars.

### 2) Deploy server to Render (quick path)

Use [render.yaml](render.yaml) for a Blueprint deploy:

1. In Render, click **New +** -> **Blueprint**.
2. Connect this repo.
3. Render will detect `render.yaml` and create `word-fuse-server`.
4. Set env vars when prompted:
   - `CLIENT_ORIGIN=https://<your-vercel-domain>`
   - `DICTIONARY_ENABLED=true`
5. Deploy and copy the Render service URL, for example:
   - `https://word-fuse-server.onrender.com`

Notes:

- Do not set `PORT` manually on Render. Render injects it.
- Health check path is `/health`.

### 3) Point Vercel client to Render server

Set Vercel env var in the `client` project:

```bash
npx vercel env add VITE_SERVER_URL production --cwd client
```

Enter your Render URL (for example `https://word-fuse-server.onrender.com`) as the value.

Redeploy client:

```bash
npx vercel --prod --cwd client --yes
```

### 4) Verify production flow

1. Open your Vercel app URL.
2. Create room from device A.
3. Join same room from device B.
4. Start game and submit words.

If sockets fail in production, re-check:

- `VITE_SERVER_URL` points to your deployed server URL
- `CLIENT_ORIGIN` includes your Vercel frontend domain
- Server host supports WebSockets

## Notes

- Game state is in-memory only. Restarting server clears rooms/matches.
- Dictionary uses local `server/wordlist.txt` and never calls external paid APIs.
- Server broadcasts room/game state at 4Hz during active matches for consistent timer updates.
