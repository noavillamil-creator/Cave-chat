# CaveChat

A Discord-inspired chat app starter built for a separate Render service and a separate Neon database. It is intentionally independent from Cave Game.

## Included

- Account registration and login (passwords hashed with bcrypt)
- Secure, HTTP-only, 7-day sign-in cookie
- Community creation and invite-code joining
- Text and voice-channel entries (voice is only a placeholder for now)
- Persistent community messages and one-to-one direct messages
- Account discovery by username (email addresses are never exposed in search)
- Live community chat, direct messages, and online presence with Socket.IO
- GIF picker powered by GIPHY (requires an API key)
- File and image uploads up to 8 MB, stored in Neon PostgreSQL
- Discord-inspired dark layout based on the supplied screenshot

## Before deploying

Create a **new Neon project** just for CaveChat. Do not paste Cave Game's database URL here.

The server applies `schema.sql` automatically on startup, so you do not need to paste the SQL manually. The schema file is also included if you prefer to inspect it.

## Deploy on Render

1. Put this project in its own GitHub repository, for example `cavechat`.
2. In Render, create a new **Web Service** from that repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Add these environment variables:
   - `DATABASE_URL` — the connection string from the new CaveChat Neon project. Use Neon's pooled connection string if available.
   - `JWT_SECRET` — a long random secret (at least 32 characters).
   - `NODE_ENV` — `production`.
   - `GIPHY_API_KEY` — optional; add a GIPHY developer API key to enable GIF search.
5. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`; it should return `{"ok":true,"app":"CaveChat"}`.

`PORT` is supplied automatically by Render. The app serves the website and Socket.IO from the same service, so no separate WebSocket URL is needed.

## Local testing

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in `DATABASE_URL` using the new CaveChat Neon project, and set a random `JWT_SECRET`.
4. Run:

```bash
npm install
npm start
```

5. Visit `http://localhost:3000`.

## Notes / current limits

- This is a working starter, not a finished Discord replacement.
- Voice channels are listed but voice/video calling is not implemented.
- Voice channels are only placeholders; live voice/video calls are not implemented.
- Uploads are limited to 8 MB and a safe file-type allowlist. File bytes are stored in Neon as PostgreSQL `BYTEA`, so they survive Render redeploys without a Render disk. This is convenient for a small beta, but large file libraries should move to object storage later to control database growth.
- GIF search uses GIPHY. Without `GIPHY_API_KEY`, the GIF picker explains how to enable it. GIPHY's Search API is designed to be called from the client, so the key is made available to the signed-in browser; use an app-specific key and GIPHY dashboard controls.
- Password reset/email verification, moderation controls, role management, message editing/deleting, and unread indicators are not implemented yet.
- Online presence is in-memory on the running Node process. Keep one Render instance for this starter; multi-instance scaling needs a shared Socket.IO adapter/presence store.
- The app uses an HTTP-only cookie, bcrypt password hashes, server-side membership checks, and parameterized SQL queries. Keep `JWT_SECRET` private and never commit `.env`.
- The first person to create a community becomes its owner. Only owners/admins can create channels.
