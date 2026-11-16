# OpenWA Relay

HTTP relay for app alerts and WhatsApp keyword forwarding via [OpenWA](https://github.com/rmyndharis/OpenWA) (run separately).

## What it does

1. **`POST /alert`** — apps send alerts. Forwards as `Investigation Issue …` to `errorForward` / `warningForward` / `infoForward` when `message` **starts with** `error`, `warning`, or `info`, **or** when JSON `level` is `error` / `critical` / `warning` / `info`. Otherwise the formatted alert goes to `channel` or `alerts`.
2. **Inbound WhatsApp** — same prefix rule in `inbound` chats → `errorForward` / `warningForward` / `infoForward`.

OpenWA must already be running with a linked WhatsApp session.

## Quick start

The relay does **not** ship a ready-to-run `lists.json` (chat IDs are yours). Copy the example, then edit it.

**macOS / Linux:**

```bash
cp .env.example .env
cp lists.example.json lists.json
```

**Windows (cmd, from the relay folder):**

```cmd
copy .env.example .env
copy lists.example.json lists.json
```

**Windows (PowerShell):**

```powershell
Copy-Item .env.example .env
Copy-Item lists.example.json lists.json
```

Then:

1. Edit **`lists.json`** — replace placeholders with real chat IDs from OpenWA (see below).
2. Edit **`.env`** — set `OPENWA_KEY`, `OPENWA_SESSION`, `RELAY_TOKEN`.

```bash
npm ci && npm start
# or: docker compose up -d --build
```

**Docker:** `docker-compose.yml` mounts `./lists.json` into the container. Create it on the host **before** `docker compose up`; changes on the host apply without rebuild.

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

### Local prefix demo (three buttons)

With relay + OpenWA up and `.env` set:

```bash
npm run demo:alert
```

Open **http://127.0.0.1:3100** — red / orange / blue circles send `error` / `warning` / `info` test alerts to the forward lists.

## Forward routing (`/alert` and WhatsApp inbound)

- **WhatsApp:** message must **start** with `error` / `warning` / `info`; only chats in `inbound` (if listed).
- **`POST /alert`:** same message prefix **or** `level` field (`error`, `critical`, `warning`, `info`).
- Delivery text: `Investigation Issue` + message (not the formatted alert block).
- After changing `server.js`, run `docker compose up -d --build` so the relay container picks up the code.
- Relay logs: `WhatsApp listener connected` and `[inbound] …` on startup / delivery.
- After code changes with Docker: `docker compose up -d --build`.

## Logs (any folder / clone name)

Docker Compose used to name containers after the **folder** (e.g. `OpenWA-integration-main` → `openwaintegration-main-openwa-relay-1`). This repo pins the relay container to **`openwa-relay`** and project name **`openwa-relay`**.

From the relay directory (where `docker-compose.yml` lives):

```bash
docker compose logs -f openwa-relay
# or
docker logs -f openwa-relay
```

If you have an older compose file without `container_name`, find the relay by port **3000**:

```bash
docker ps --filter publish=3000
docker logs -f <NAME from first column>
```

OpenWA API logs (separate stack): `docker logs -f openwa-api`
