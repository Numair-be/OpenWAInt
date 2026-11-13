import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { io } from "socket.io-client";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

// ---- Config (from environment) -------------------------------------------
const {
  OPENWA_URL = "http://localhost:2785",   // OpenWA base URL (no trailing /api)
  OPENWA_KEY,                             // OpenWA API key
  OPENWA_SESSION,                         // OpenWA session ID
  RELAY_TOKEN,                            // token your apps must send to /notify
  PORT = "3000",
  LISTS_FILE = "./lists.json",
  MIN_DELAY_MS = "2000",                  // min pause between messages
  MAX_DELAY_MS = "5000",                  // max pause between messages
  MAX_RETRIES = "2",
} = process.env;

for (const [name, val] of Object.entries({ OPENWA_KEY, OPENWA_SESSION, RELAY_TOKEN })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!SESSION_UUID.test(OPENWA_SESSION)) {
  console.error(
    `OPENWA_SESSION must be the full session UUID from the dashboard (got "${OPENWA_SESSION}")`,
  );
  process.exit(1);
}

const minDelay = Number(MIN_DELAY_MS);
const maxDelay = Number(MAX_DELAY_MS);
const maxRetries = Number(MAX_RETRIES);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => minDelay + Math.random() * Math.max(0, maxDelay - minDelay);

// ---- Recipient lists (re-read on every request, so edits apply instantly) --
function loadLists() {
  const raw = fs.readFileSync(LISTS_FILE, "utf8").trim();
  if (!raw) throw new Error(`${LISTS_FILE} is empty`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${LISTS_FILE}: ${err.message}`);
  }
}

function validateListsAtStartup() {
  try {
    const lists = loadLists();
    for (const key of [
      "alerts",
      "inbound",
      "errorForward",
      "warningForward",
      "infoForward",
    ]) {
      const arr = lists[key];
      if (arr !== undefined && !Array.isArray(arr)) {
        throw new Error(`${key} must be an array`);
      }
    }
    console.log(`Loaded ${LISTS_FILE}`);
  } catch (err) {
    console.error(`Invalid lists file: ${err.message}`);
    process.exit(1);
  }
}
validateListsAtStartup();

// ---- Send one message through OpenWA --------------------------------------
async function sendOne(chatId, text) {
  const url = `${OPENWA_URL}/api/sessions/${OPENWA_SESSION}/messages/send-text`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": OPENWA_KEY },
      body: JSON.stringify({ chatId, text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const hint = err.cause?.code ?? err.cause?.message ?? err.message;
    throw new Error(
      `cannot reach OpenWA at ${OPENWA_URL} (${hint}) — if relay runs in Docker, set OPENWA_URL=http://host.docker.internal:2785`
    );
  }
  if (!res.ok) {
    throw new Error(`OpenWA ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ---- Single sequential queue ----------------------------------------------
// All apps share one queue, so simultaneous requests never get blasted out
// in parallel. Messages go out one at a time with a random delay.
const queue = [];
const jobs = new Map(); // jobId -> { channel, total, sent, failed, done }
let working = false;

async function worker() {
  if (working) return;
  working = true;
  while (queue.length) {
    const { jobId, chatId, text } = queue.shift();
    const job = jobs.get(jobId);
    let ok = false;
    for (let attempt = 0; attempt <= maxRetries && !ok; attempt++) {
      try {
        await sendOne(chatId, text);
        ok = true;
      } catch (err) {
        console.error(`[${jobId}] ${chatId} attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < maxRetries) await sleep(3000 * (attempt + 1));
      }
    }
    if (ok) job.sent++;
    else job.failed.push(chatId);
    if (job.sent + job.failed.length === job.total) {
      job.done = true;
      console.log(`[${jobId}] done: ${job.sent}/${job.total} sent`);
      setTimeout(() => jobs.delete(jobId), 60 * 60 * 1000); // forget after 1h
    }
    if (queue.length) await sleep(jitter());
  }
  working = false;
}

// ---- HTTP API --------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "100kb" }));

function auth(req, res, next) {
  const given = req.get("X-Relay-Token") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(RELAY_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Look up a channel's recipients and queue the text for each of them.
// Returns { jobId, queued } or { status, error } on failure.
function enqueue(channel, text) {
  let lists;
  try {
    lists = loadLists();
  } catch (err) {
    console.error("Could not read lists file:", err.message);
    return { status: 500, error: "recipient lists unavailable" };
  }

  const recipients = lists[channel];
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { status: 404, error: `unknown or empty channel: ${channel}` };
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  jobs.set(jobId, { channel, total: recipients.length, sent: 0, failed: [], done: false });
  for (const chatId of recipients) queue.push({ jobId, chatId, text });
  worker();

  console.log(`[${jobId}] queued "${channel}" -> ${recipients.length} recipient(s)`);
  return { jobId, queued: recipients.length };
}

// Shared with WhatsApp inbound: message must *start* with error | warning | info.
const PREFIX_RE = /^\s*(error|warning|info)(\s+|$)/i;

function routeInboundPrefix(body) {
  const m = String(body ?? "").match(PREFIX_RE);
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (word === "error") return "errorForward";
  if (word === "warning") return "warningForward";
  if (word === "info") return "infoForward";
  return null;
}

function investigationText(body) {
  return `Investigation Issue ${String(body).trim()}`;
}

// POST /notify  { "channel": "alerts", "text": "Disk usage at 92%" }
app.post("/notify", auth, (req, res) => {
  const { channel, text } = req.body ?? {};
  if (typeof channel !== "string" || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "body needs string fields: channel, text" });
  }
  const out = enqueue(channel, text);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(202).json(out);
});

// ---- Error alerts ----------------------------------------------------------
// POST /alert
// { "app": "billing-api", "message": "DB connection refused",
//   "level": "error", "details": "<stack trace>", "channel": "alerts" }
// Only "message" is required. If message starts with error|warning|info, routes
// like WhatsApp inbound (Investigation Issue → *Forward lists). Otherwise formatted alert.
// Identical alerts from the same app are throttled.
const THROTTLE_MS = Number(process.env.THROTTLE_MINUTES ?? 5) * 60 * 1000;
const DEFAULT_CHANNEL = process.env.DEFAULT_CHANNEL ?? "alerts";
const HOST = process.env.RELAY_HOSTNAME ?? os.hostname();
const seen = new Map(); // key -> { lastSent, suppressed }
const ICONS = { info: "ℹ️", warning: "⚠️", error: "🔴", critical: "🚨" };

app.post("/alert", auth, (req, res) => {
  const {
    app: appName = "unknown-app",
    message,
    level = "error",
    details = "",
    channel = DEFAULT_CHANNEL,
  } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "body needs a string field: message" });
  }
  const lvl = String(level).toLowerCase();

  // Throttle repeats of the same alert (same app + level + message)
  const key = crypto
    .createHash("sha1")
    .update(`${appName}|${lvl}|${message}`)
    .digest("hex");
  const now = Date.now();
  const entry = seen.get(key);
  if (entry && now - entry.lastSent < THROTTLE_MS) {
    entry.suppressed++;
    return res.status(202).json({ throttled: true, suppressed: entry.suppressed });
  }
  const repeats = entry?.suppressed ?? 0;
  seen.set(key, { lastSent: now, suppressed: 0 });

  const lines = [
    `${ICONS[lvl] ?? "🔴"} *${lvl.toUpperCase()}* — ${appName}`,
    `🖥 ${HOST}`,
    `🕒 ${new Date().toLocaleString("en-GB", { timeZone: process.env.TZ ?? "UTC", hour12: false })}`,
    "",
    String(message).slice(0, 1000),
  ];
  if (details) lines.push("", "```" + String(details).slice(0, 800) + "```");
  if (repeats > 0) {
    lines.push("", `_(+${repeats} identical alert(s) suppressed since the last one)_`);
  }

  const forwardChannel = routeInboundPrefix(message);
  if (forwardChannel) {
    const out = enqueue(forwardChannel, investigationText(message));
    if (out.error) return res.status(out.status).json({ error: out.error });
    return res.status(202).json({ ...out, route: forwardChannel, format: "investigation" });
  }

  const out = enqueue(channel, lines.join("\n"));
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(202).json(out);
});

// Keep the dedupe map from growing forever
setInterval(() => {
  const cutoff = Date.now() - Math.max(THROTTLE_MS, 60 * 60 * 1000);
  for (const [k, v] of seen) if (v.lastSent < cutoff) seen.delete(k);
}, 10 * 60 * 1000).unref();

// GET /jobs/:id  - check delivery progress
app.get("/jobs/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.json(job);
});

// GET /health  - no auth, for monitoring
app.get("/health", (_req, res) => res.json({ ok: true, queued: queue.length }));

// ---- Inbound WhatsApp (live message stream, not HTTP webhooks) ---------------
// Watched chats only; same prefix → forward rules as POST /alert (see routeInboundPrefix).
const seenInbound = new Set();
const MAX_SEEN_INBOUND = 10_000;

function handleInboundWhatsApp(data) {
  if (!data || data.fromMe === true) return;

  const msgId = data.id ?? data.messageId;
  if (msgId) {
    if (seenInbound.has(msgId)) return;
    seenInbound.add(msgId);
    if (seenInbound.size > MAX_SEEN_INBOUND) {
      seenInbound.clear();
    }
  }

  const body = typeof data.body === "string" ? data.body : "";
  const channel = routeInboundPrefix(body);
  if (!channel) return;

  let lists;
  try {
    lists = loadLists();
  } catch (err) {
    console.error("inbound: lists file:", err.message);
    return;
  }

  const inbound = lists.inbound;
  const chatId = data.chatId ?? data.from;
  if (Array.isArray(inbound) && inbound.length > 0) {
    const ids = [data.chatId, data.from, data.author].filter((id) => typeof id === "string");
    if (!ids.some((id) => inbound.includes(id))) {
      if (process.env.INBOUND_DEBUG === "true") {
        console.log(`[inbound] skip chat not in list: ${ids.join(", ")}`);
      }
      return;
    }
  }

  const out = enqueue(channel, investigationText(body));
  if (out.error) {
    console.error(`[inbound] ${out.error}`);
    return;
  }
  console.log(`[inbound] ${channel} ← ${chatId}: ${body.slice(0, 80)}`);
}

function openwaEventsUrl() {
  const raw = (process.env.OPENWA_EVENTS_URL ?? OPENWA_URL).replace(/\/events\/?$/, "");
  const httpish = raw.replace(/^wss?:/i, "http:");
  const u = new URL(httpish.includes("://") ? httpish : `http://${httpish}`);
  return `${u.origin}/events`;
}

function startWhatsAppInboundListener() {
  if (process.env.INBOUND_LISTENER === "false") return;

  const url = openwaEventsUrl();
  const socket = io(url, {
    auth: { apiKey: OPENWA_KEY },
    reconnection: true,
    reconnectionDelayMax: 15_000,
    // Prefer WebSocket over long-polling (fewer "xhr poll error" lines on Docker Desktop → host).
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    console.log(`WhatsApp listener connected (${url})`);
    socket.emit("message", {
      type: "subscribe",
      sessionId: OPENWA_SESSION,
      events: ["message.received"],
      requestId: "relay-inbound",
    });
  });

  socket.on("message", (msg) => {
    if (msg?.type === "error") {
      console.error(`WhatsApp listener error: ${msg.code} — ${msg.message}`);
      return;
    }
    if (msg?.type === "subscribed") {
      console.log(`WhatsApp listener subscribed (session ${msg.sessionId})`);
      return;
    }
    if (msg?.type !== "event") return;
    const { event, sessionId, data } = msg.payload ?? {};
    if (event !== "message.received") return;
    if (sessionId !== OPENWA_SESSION) {
      if (process.env.INBOUND_DEBUG === "true") {
        console.log(`[inbound] skip session ${sessionId} (OPENWA_SESSION=${OPENWA_SESSION})`);
      }
      return;
    }
    handleInboundWhatsApp(data);
  });

  socket.on("connect_error", (err) => {
    console.error("WhatsApp listener:", err.message);
  });
}

app.listen(Number(PORT), () => {
  console.log(`OpenWA relay listening on :${PORT}`);
  startWhatsAppInboundListener();
});
