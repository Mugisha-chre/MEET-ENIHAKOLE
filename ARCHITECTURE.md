# MEET ENIHAKOLE — Architecture and release plan

**Date:** 27 October 2026  
**Purpose:** Online prayer meetings, choir rehearsals, and small-group video conferences.

## 1. Design principles

1. Keep the React SPA small and let LiveKit's maintained conference components handle the difficult media controls.
2. Keep media traffic out of Express. Express authorizes users, stores meeting metadata, and signs short-lived LiveKit room tokens.
3. Treat the meeting URL as an invitation, not proof of identity. Private pastoral meetings need a waiting room and stronger admission rules before broad production use.
4. Optimize for a stable call, not an unconditional “HD” promise. The client requests 720p/30fps and publishes lower simulcast layers, while LiveKit and the browser adapt to receiver size, bandwidth, CPU, camera support, and device temperature.
5. Keep credentials out of the frontend, repository, and share metadata.

## 2. Architecture

```text
React SPA (Cloudflare Pages or another static host)
   ├── HTTPS JSON calls ──────────────┐
   │                                  ▼
   │                         Express + TypeScript API
   │                                  │
   │                         MongoDB Atlas / Mongoose
   │
   └──── WebRTC / secure WebSocket ─── LiveKit Cloud
                                        ▲
                                        │ signed room token
                                        └── Express API
```

LiveKit carries the actual audio, video, screen-share, and realtime participant media. The API should not proxy that media. The API is only required to fetch meeting details, authenticate a host, mint join tokens, and end/cancel meetings.

## 3. Meeting lifecycle

- **Schedule:** an authenticated host creates a meeting. MongoDB stores title, description, start time, timezone, planned duration, access visibility, optional public thumbnail, owner, slug, and status.
- **Share:** the app generates `/share/:slug` on the API domain. The HTML share page provides Open Graph/Twitter metadata and a default MEET ENIHAKOLE image, or the user's HTTPS thumbnail, for WhatsApp and other preview-capable clients. Link-only previews are marked `noindex,nofollow`.
- **Host starts:** the host requests a room token. The API changes the meeting to `live`, records `startedAt`, and issues a short-lived token for `eni-<slug>`.
- **Guest joins:** a guest enters a display name, and the API issues a participant token only after the meeting is open. Guests do not need a platform account.
- **During the call:** LiveKit's `VideoConference` includes participant tiles, microphone/camera controls, screen sharing, participants, and in-room chat. Adaptive Stream and Dynacast reduce needless high-resolution delivery.
- **End:** the host's “End for everyone” action marks the meeting ended and asks LiveKit to delete the room. A stale room is also closed when a later join/rejoin attempts to enter beyond the planned end plus a 30-minute grace period. This starter does **not** yet run a durable background scheduler, so hosts should explicitly end rooms; a sleeping free backend cannot promise exact-time automatic closure.

## 4. Security boundaries

- `LIVEKIT_API_SECRET` is backend-only. Frontend users receive scoped, expiring JWT room tokens—not the LiveKit API secret.
- API authentication uses hashed passwords and signed JWTs. For a wider production release, replace localStorage bearer-token storage with secure HttpOnly cookies (or a carefully designed short-lived token flow), and add email verification, password reset, audit logging, and abuse controls.
- Link-only meeting links are unlisted but are not a strong identity boundary. Someone who receives a link can attempt to enter. Add a waiting room, host approval, participant removal, and host-only sharing controls before using it for sensitive meetings.
- Public meetings are explicitly listed. Link-only share pages are marked `noindex,nofollow`, but crawlers and message clients cannot be guaranteed to honor metadata immediately.
- Keep `.env`, database URIs, JWT secrets, LiveKit API keys, and `.git` history out of public ZIPs and repositories. Rotate any real credential accidentally shared.

## 5. Video and audio quality

The current client asks for 1280×720 at 30 fps, with a 1.5 Mbps primary video encoding cap and lower 640×360 / 320×180 simulcast layers. LiveKit can choose appropriate layers for receivers and stop publishing unused layers where supported. These are **targets**, not guaranteed resolution: camera hardware, browser constraints, CPU load, uplink, downlink, and provider limits all affect the real call.

For ordinary prayer and discussion, browser echo cancellation and noise suppression are usually helpful. For choir singing, speech-processing defaults can distort sustained notes and internet latency makes tightly synchronized ensemble singing difficult. A future “Music mode” should be an explicit opt-in, strongly recommend headphones, and be tested against ordinary voice mode; it should not silently disable echo cancellation for everyone.

## 6. Free-tier planning

At the time this starter was prepared, LiveKit Cloud's Build tier listed 5,000 WebRTC participant-minutes, 100 concurrent connections, and 50 GB downstream data transfer. A one-hour call with 25 participants uses 1,500 participant-minutes; four such calls use 6,000 minutes. These limits need to be checked in the live provider dashboard before relying on the system for regular weekly meetings.

MongoDB Atlas Free currently documents 0.5 GB of storage. Render free web services spin down after 15 minutes without inbound traffic and take about a minute to spin back up, so they are appropriate for trials but not dependable production hosting. Vercel supports Express apps as a serverless function and may be a better no-cost API trial if its Hobby/non-commercial terms fit your use; serverless use still has invocation, compute, and platform limits. See the current documents before selecting the final deployment:

- LiveKit pricing: https://livekit.com/pricing
- LiveKit media configuration: https://docs.livekit.io/transport/media/advanced/
- MongoDB Atlas free-cluster limits: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
- Render free services: https://render.com/docs/free
- Express on Vercel: https://vercel.com/docs/frameworks/backend/express
- Vercel Hobby terms/usage: https://vercel.com/docs/plans/hobby

A genuinely unlimited, always-on, high-resolution conference service cannot be promised at zero cost. The realistic goal is a zero-cash-cost pilot within free-tier caps, with monitoring and a clear fallback if usage grows.

## 7. Release acceptance checklist

Before inviting the choir:

- [ ] Configure a fresh MongoDB database, a least-privilege DB user, and a strong `JWT_SECRET`.
- [ ] Create a LiveKit Cloud project; store only its URL/API key/secret in the API environment.
- [ ] Deploy the API and SPA to HTTPS URLs and set `APP_URL`, `API_PUBLIC_URL`, `FRONTEND_ORIGINS`, and `VITE_API_URL` correctly.
- [ ] Register a host; schedule a meeting; copy the invitation; check the image/title/description preview in WhatsApp.
- [ ] Join using two physical devices, not only two tabs; test Wi-Fi and mobile data.
- [ ] Test mic permission denied, camera unavailable, user refresh/rejoin, guest joins before host, host ends for everyone, and an expired meeting.
- [ ] Test a larger call with the expected choir size, watching CPU and network on low-end Android phones.
- [ ] Check LiveKit participant-minute and downstream transfer consumption after every test session.
- [ ] Decide whether calls must be private. If so, build waiting-room admission and host participant moderation before real sensitive meetings.
- [ ] Do not promise synchronized choir singing over ordinary Internet conference latency.
