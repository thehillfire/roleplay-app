# LoreForge

A calm, AI-narrated roleplay app. Roll a class from theme, role and rarity, or describe yourself, then play a story one action at a time. Rebuilt from scratch, borrowing ideas from LoreForgeRPG, TESTINGRPG and AIRolePlayCalm.

## Quick start

```bash
npm install
cp .env.example .env      # optional: add GEMINI_API_KEY for real AI stories
npm run dev               # API on :3000, app on http://localhost:5173
```

The app works without a key: the **offline narrator** gives simple placeholder prose so you can develop and test without spending anything. Add `GEMINI_API_KEY` (from Google AI Studio) to get real stories.

| Script | What it does |
| --- | --- |
| `npm run dev` | API server (auto-restart) + Vite dev server with `/api` proxied |
| `npm run build` | Builds the web app into `dist/` |
| `npm start` | Serves the API and the built app from one port (3000) |
| `npm test` | Server test suite (`node --test`, in-memory SQLite) |
| `npm run test:pg` | Account tests against Postgres (`TEST_DATABASE_URL=postgres://…`) |
| `npm run e2e` | Browser smoke test against a running server (`BASE_URL`, `CHROMIUM_PATH`) |

## How it fits together

```
client/   React + Vite web app (mobile-first).
server/   Express API. Owns every prompt, validates input, rate-limits, talks to Gemini, stores accounts and stories.
api/      Vercel serverless entry that wraps the same Express app.
e2e/      Playwright smoke test of the full guest → account flow.
```

**Guests and players.** Anyone can play as a guest; guest stories live in that browser. Creating an account (email + password) moves guest stories to the server, where they're available on any device. Passwords are hashed with scrypt; sessions are random tokens in an httpOnly cookie, stored hashed.

**Database.** SQLite (built into Node, file at `data/loreforge.db`) works out of the box for a single server. Set `DATABASE_URL` to use Postgres (Supabase, Neon, Render…). Tables are created automatically on start.

**API**

- `GET /api/health` → `{ status, narrator: "gemini" | "offline" }`
- `POST /api/class` → `{ class: { name, description, rarity, theme, role } }`. The server rolls the rarity (weighted: Common 45% … Eternal 0.5%), theme and role; the narrator names and describes it.
- `POST /api/story` with `{ hero, history, action? }` → `{ passage, choices }`. Guest play: leave out `history`/`action` to open a story; send `action` to continue one.
- `POST /api/auth/signup | login | logout`, `GET /api/auth/me`
- Signed-in play (server keeps the history): `GET/POST /api/stories`, `GET/DELETE /api/stories/:id`, `POST /api/stories/:id/turns { action, version }`, `POST /api/stories/import`

The client sends **data, never prompts**, which is the main difference from the old apps: you can't use the backend as a free Gemini proxy, and every field has a length limit.

## Deploy (Vercel)

Import the repo into Vercel and set `GEMINI_API_KEY`, `DATABASE_URL` (required on Vercel: its disk is wiped between requests) and optionally `GEMINI_MODEL` (default `gemini-2.5-flash`) in the project's environment variables. `vercel.json` builds the app into `dist/` and sends `/api/*` to the Express app.

## Not carried over (yet)

Chat/contacts, inventory and background music from the older apps. Each one is its own feature; add them when you want them.
