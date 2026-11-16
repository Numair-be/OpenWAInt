import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env") });

const RELAY_URL = (process.env.RELAY_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const PORT = Number(process.env.DEMO_ALERT_PORT ?? 3100);

if (!RELAY_TOKEN) {
  console.error("Missing RELAY_TOKEN in repo root .env");
  process.exit(1);
}

const KINDS = {
  error: {
    message: (t) => `error Demo alert from test app at ${t}`,
    level: "error",
  },
  warning: {
    message: (t) => `warning Demo alert from test app at ${t}`,
    level: "warning",
  },
  info: {
    message: (t) => `info Demo alert from test app at ${t}`,
    level: "info",
  },
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

app.post("/api/send", async (req, res) => {
  const kind = req.body?.kind;
  const spec = KINDS[kind];
  if (!spec) {
    return res.status(400).json({ error: "kind must be error, warning, or info" });
  }

  const t = new Date().toLocaleString("en-GB", { hour12: false });
  const body = {
    app: "prefix-demo",
    message: spec.message(t),
    level: spec.level,
  };

  let relayRes;
  try {
    relayRes = await fetch(`${RELAY_URL}/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Token": RELAY_TOKEN,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return res.status(502).json({ error: "relay unreachable", detail: err.message });
  }

  const data = await relayRes.json().catch(() => ({}));
  res.status(relayRes.status).json({ sent: body, relay: data });
});

app.listen(PORT, () => {
  console.log(`Alert demo UI: http://127.0.0.1:${PORT}`);
  console.log(`Relay target: ${RELAY_URL}/alert`);
});
