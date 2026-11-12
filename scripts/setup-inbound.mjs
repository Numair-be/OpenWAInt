/**
 * Remove OpenWA automation rules and relay HTTP webhooks (old approach).
 * Inbound WhatsApp handling is built into the relay via the live /events stream.
 *
 * Usage: node scripts/setup-inbound.mjs
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const OPENWA_URL = (process.env.OPENWA_URL ?? "http://127.0.0.1:2785").replace(/\/$/, "");
const OPENWA_KEY = process.env.OPENWA_KEY;
const OPENWA_SESSION = process.env.OPENWA_SESSION;

if (!OPENWA_KEY || !OPENWA_SESSION) {
  console.error("Set OPENWA_KEY and OPENWA_SESSION in .env");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "X-API-Key": OPENWA_KEY,
};

async function api(method, pathSuffix) {
  const res = await fetch(`${OPENWA_URL}/api/sessions/${OPENWA_SESSION}${pathSuffix}`, {
    method,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${method} ${pathSuffix} → ${res.status}: ${text}`);
  }
}

const rulesRes = await fetch(`${OPENWA_URL}/api/sessions/${OPENWA_SESSION}/automation-rules`, { headers });
const rules = await rulesRes.json();
for (const rule of rules ?? []) {
  await api("DELETE", `/automation-rules/${rule.id}`);
  console.log(`Deleted automation rule: ${rule.name}`);
}

const hooksRes = await fetch(`${OPENWA_URL}/api/sessions/${OPENWA_SESSION}/webhooks`, { headers });
const hooks = await hooksRes.json();
for (const hook of hooks ?? []) {
  if (hook.url?.includes("/webhooks/inbound")) {
    await api("DELETE", `/webhooks/${hook.id}`);
    console.log(`Deleted HTTP webhook: ${hook.url}`);
  }
}

console.log("Done. Restart the relay — it listens to WhatsApp via OpenWA /events (no webhook URL).");
