# OpenWA Relay

HTTP relay for app alerts and WhatsApp keyword forwarding via [OpenWA](https://github.com/rmyndharis/OpenWA) (run separately).

## What it does

1. **`POST /alert`** — apps send formatted, throttled error alerts to a `lists.json` channel.
2. **Inbound WhatsApp** — messages in watched chats that start with `error`, `warning`, or `info` are forwarded as `Investigation Issue …` to `errorForward`, `warningForward`, or `infoForward`.

OpenWA must already be running with a linked WhatsApp session.

## Quick start

```bash
cp .env.example .env
cp lists.example.json lists.json   # edit chat IDs
# Set OPENWA_KEY, OPENWA_SESSION, RELAY_TOKEN in .env

npm ci && npm start
# or: docker compose up -d --build
```

**Docker + OpenWA on the host:** `docker-compose.yml` sets `OPENWA_URL` and `OPENWA_EVENTS_URL` to `host.docker.internal:2785`.

**OpenWA SSRF:** if you use OpenWA webhooks elsewhere, add to OpenWA's `.env`:

`SSRF_ALLOWED_HOSTS=host.docker.internal`

**Optional:** `npm run setup-inbound` — removes legacy OpenWA automation rules / webhooks (inbound uses the live `/events` stream).

## `lists.json`

| Key | Purpose |
|-----|---------|
| `alerts` | Default recipients for `/alert` |
| `inbound` | Chats allowed to send `error` / `warning` / `info` commands |
| `errorForward` | Recipients when a message starts with `error` |
| `warningForward` | Recipients when a message starts with `warning` |
| `infoForward` | Recipients when a message starts with `info` |

Chat IDs: copy from OpenWA (e.g. `919876543210@c.us`, `…@lid`, `…@g.us`).

## API

`POST /alert` — header `X-Relay-Token: <RELAY_TOKEN>`

See `.env.example` for optional variables (`THROTTLE_MINUTES`, `TZ`, `DEFAULT_CHANNEL`, …).

`GET /health` — no auth.

`./alert.sh` — shell helper; see script header.

## Inbound rules

- Prefix must be at the **start** of the message (case-insensitive): `error …`, `warning …`, `info …`.
- Relay logs: `WhatsApp listener connected` and `[inbound] …` on startup / delivery.
- After code changes with Docker: `docker compose up -d --build`.
