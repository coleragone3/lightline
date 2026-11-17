# LIGHTLINE.io

A clean, minimal, agar.io-style multiplayer light-cycle game. Open the page, type a name, hit PLAY. Die, respawn, climb the leaderboard. Bots keep the arena busy when few humans are online.

## Run locally
```bash
npm install
npm start            # http://localhost:3000
```
Open it in two browser tabs (or on two machines on your network at `http://<your-ip>:3000`) to play against each other.

## Mechanics
- **Rubber**: running into a wall doesn't kill you instantly. You stop just short of it and have about 0.5s of "rubber" to turn away. Rubber recharges while you're moving freely.
- **Grinding**: riding within 4 units of any wall (yours, an enemy's, or the arena edge) speeds you up, from 22 to a max of 62. Squeezing between two walls doubles the boost.
- **Brake** (SPACE): slows you to 11 for up to 1.5s, then recharges.
- **Trails** grow with time alive and kills, so the leaders take up more of the arena.
- **Score** = 10 per kill + 1 per second alive. A kill goes to whoever owns the wall you crash into.

## Controls
Arrow keys steer by absolute direction. A/D (or Q/E) turn left and right relative to your cycle, like classic light-cycle games. SPACE brakes. On mobile, swipe to steer or tap the left/right half of the screen to turn.

## Deploy (any host with WebSockets)
- **Render**: New → Web Service → connect the repo → Build `npm install`, Start `npm start`.
- **Railway / Fly.io**: deploy as a Node app or use the included Dockerfile. The server reads `PORT` from the environment.

## Tuning
All gameplay constants (arena size, speeds, rubber, grind, trail length, bot count) are at the top of `server.js`.

## Architecture
- `server.js`: authoritative 40Hz simulation that sends 20Hz delta snapshots over WebSocket (only new trail corners are sent). Also serves the static client.
- `public/`: a single canvas client with glow rendering, a minimap, a leaderboard, particles, and head extrapolation.
