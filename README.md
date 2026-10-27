# MEET ENIHAKOLE

A React SPA and Express API starter for online prayers, choir rehearsals, and video conferences.

## What is included

- React 19 + TypeScript + Vite single-page application.
- Express + TypeScript API with MongoDB/Mongoose persistence.
- Email/password registration and login, with password hashes and signed 7-day API bearer tokens.
- Host-owned meeting scheduling, public/unlisted-by-link visibility, planned duration, timezone, and optional public HTTPS thumbnail URL.
- Guest access by invitation link: guests do not need to create an account.
- Server-side LiveKit join-token generation. LiveKit API secrets never belong in frontend environment variables.
- LiveKit's React conference prefab for video tiles, microphone/camera controls, participant list, in-room chat, and screen sharing.
- A 720p/30fps camera capture target with 360p and 180p simulcast layers, plus Adaptive Stream and Dynacast so LiveKit can select lower layers and avoid sending unused layers where supported. Real output adapts to device and network conditions.
- Server-generated share page with Open Graph and Twitter metadata, so supported messaging apps can discover a title, description, and thumbnail.
- Mobile-responsive burgundy, warm-ivory, and muted-gold UI, including scheduling and sign-in dialogs.

## Architecture

```text
React SPA (Cloudflare Pages or another static host)
   | HTTPS JSON API + short-lived access token
   v
Express API (Render or another Node host) ---- MongoDB Atlas
   | creates short-lived LiveKit room token
   v
Browser <===================================> LiveKit Cloud
                  WebRTC audio/video
```

Audio/video travels between participants and LiveKit. It does not pass through the Express API. The API stores meeting metadata, checks host permissions, and mints LiveKit join tokens. The LiveKit API secret must remain only on the backend.

## Prerequisites

- Node.js 20.19+ (Node 22 LTS recommended).
- A MongoDB instance. For initial trials, MongoDB Atlas Free is an option.
- A LiveKit Cloud project and its WebSocket URL, API key, and API secret. The Build tier currently has usage quotas; check the live pricing page before scheduling frequent or large meetings: https://livekit.com/pricing.

## Run locally

Open two terminals.

### 1. Start the API

```bash
cd backend
npm install
cp .env.example .env
```

Set these in `backend/.env`:

- `MONGODB_URI` — local MongoDB or your Atlas connection string.
- `JWT_SECRET` — a randomly generated secret with at least 32 characters.
- `LIVEKIT_URL` — a URL like `wss://your-project.livekit.cloud`.
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` — from the LiveKit project settings.
- `APP_URL=http://localhost:5173`
- `API_PUBLIC_URL=http://localhost:4000`
- `FRONTEND_ORIGINS=http://localhost:5173`

Then run:

```bash
npm run dev
```

The API health endpoint is `http://localhost:4000/health`.

### 2. Start the React app

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Register an account to schedule meetings. Use **Start instant meeting** to create a room that can be started immediately, or schedule a future meeting and share the generated invitation. Anyone with the invitation link may join as a guest when the host starts the meeting.

## Deployment outline

### MongoDB Atlas

1. Create a database and a least-privilege database user.
2. Allow network access only from the API's deployment environment where your hosting provider supports static egress IPs. If a provider requires a broad allowlist, understand that tradeoff and use a strong password.
3. Set `MONGODB_URI` as a backend secret. Never put it in a `VITE_*` variable.

### LiveKit Cloud

1. Create a project at https://cloud.livekit.io.
2. Copy its WebSocket URL and server-side API key/secret into the API environment.
3. Never put `LIVEKIT_API_SECRET` in the frontend.
4. Test the call from at least two devices and from mobile data, not just two tabs on one machine.

### Express API

1. Deploy `backend/` as a Node service. `render.yaml` is an initial Render Blueprint example, not a guarantee of production availability.
2. Set `APP_URL` to the deployed frontend origin, for example `https://your-app.pages.dev`.
3. Set `API_PUBLIC_URL` to the full HTTPS API origin, for example `https://your-api.onrender.com` (include `https://`). This is used for invitation/share URLs.
4. Set `FRONTEND_ORIGINS` to the exact frontend origin(s), comma-separated if required.
5. Set `MONGODB_URI`, `JWT_SECRET`, and the three `LIVEKIT_*` values in the provider's secret/environment settings.
6. Set `NODE_ENV=production`.

### Alternative API target: Express on Vercel

The backend also exports its Express app for Vercel's serverless Express integration. If the Vercel Hobby plan's personal/non-commercial terms fit the choir's use, this can avoid the 15-minute idle spin-down behavior of a Render free web service. It is still subject to function, resource, and platform limits, and a preview deployment must be tested before relying on it.

1. Create a Vercel project with `backend` as the project root. Vercel documents automatic Express detection from `src/server.ts`: https://vercel.com/docs/frameworks/backend/express.
2. Deploy a preview and confirm that `/health`, registration, database reads, meeting creation, and `/share/:slug` work before using the production alias.
3. Set the same backend environment variables listed above. Set `APP_URL` to the frontend's HTTPS origin, `API_PUBLIC_URL` to the Vercel API HTTPS origin, and `FRONTEND_ORIGINS` to the exact frontend origin.
4. Do not use Vercel serverless functions to proxy audio/video. LiveKit remains the media plane.

Choose either Render or Vercel as the API target. Do not deploy both against the same production configuration unless you intentionally want two API deployments.

### React SPA

1. Deploy `frontend/` as a static SPA, for example using Cloudflare Pages.
2. Use `frontend` as the project root; build command `npm run build`; output directory `dist`.
3. Set `VITE_API_URL` to the API base including `/api`, for example `https://your-api.onrender.com/api`.
4. The included `public/_redirects` file provides SPA fallback on hosts that support the redirects format.
5. Test `/`, `/meeting/<slug>`, and `/room/<slug>` after deployment.

**Free hosting caveat:** a free API instance may sleep or restart, while LiveKit has participant-minute and transfer limits. A static frontend can remain quick to load, but starting a meeting may be delayed by a sleeping API. Use free tiers for development and a small choir pilot; do not promise production uptime or unlimited conference minutes without monitoring and load testing.

## Important behavior and limitations of this starter

- A link-only meeting uses an unlisted invitation URL with a random slug suffix and `noindex,nofollow` share metadata; it is still not an authentication boundary. Anyone who receives the link can attempt to join. Do not publish private pastoral/counselling meetings publicly.
- Guests can join only after the host has started the meeting, and the API rejects joining too far before the scheduled time.
- The host can end a meeting for everyone. Recording, attendance reports, recurring meetings, calendar (.ics) export, invitation email/SMS, waiting-room approval, moderator controls, and persistent chat history are not implemented yet.
- The optional thumbnail field accepts a public HTTPS image URL. If it is blank, the bundled MEET ENIHAKOLE share cover is used. WhatsApp and other platforms may cache previews; use a new link or wait for their cache to refresh after changing a thumbnail.
- High-quality video is best-effort: camera capability, browser support, CPU, Wi-Fi/mobile network conditions, and LiveKit usage allowances all matter. The client targets 720p/30fps and publishes lower simulcast layers; validate 720p and low-bandwidth behavior with real participants before a larger rollout.
- This starter uses normal conferencing audio settings designed for speech. Music/singing mode is not implemented yet; choir singing over an Internet conference may not be synchronized because network latency varies, and speech-focused echo cancellation/noise suppression can change sustained musical notes.
- Before broad production use, move authentication to secure HttpOnly cookies, add email verification and password reset, add audit trails and account abuse controls, and run end-to-end tests on multiple networks/devices.

## Relationship to the uploaded Gihanga Updates project

This is intentionally a separate app. It follows the existing project's useful pattern—Express/Mongoose, server-side `livekit-server-sdk` token minting, browser-side `livekit-client`/React media components, and direct browser-to-LiveKit WebRTC—but it does not import its social feed, wallet, gifts, moderation, user database, or `.git` history. Do not copy the original `.env` into this project.
