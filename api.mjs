#!/usr/bin/env node
// cony-api — Tailscale-only HTTP face of the ping queue, for ConyOS,
// the watch, and the alexa brief. Mirrors pm's api.mjs conventions.
import { createServer } from "http";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { addPing, resolvePing, snoozePing, openPings, brief, scanIMessage, scanEmail, scanWhatsApp, replyPing, askClaude } from "./lib.mjs";

const PORT = parseInt(process.env.CONY_API_PORT || "8797");
const KEY_PATH = join(homedir(), ".config", "cony", "api-key");
const API_KEY = existsSync(KEY_PATH) ? readFileSync(KEY_PATH, "utf-8").trim() : null;

function tailscaleIp() {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    try {
      const ip = execSync(`"${bin}" ip -4 2>/dev/null`, { encoding: "utf-8" }).trim().split("\n")[0];
      if (/^100\./.test(ip)) return ip;
    } catch {}
  }
  return "127.0.0.1"; // no tailscale found — stay loopback-only, never LAN
}

const routes = {
  "GET /health": () => ({ ok: true, version: "1.0.0" }),
  "GET /pings": () => ({ pings: openPings() }),
  "GET /brief": () => ({ brief: brief() }),
  "POST /add": (b) => addPing(b),
  "POST /resolve": (b) => resolvePing(b),
  "POST /snooze": (b) => snoozePing(b),
  "POST /reply": (b) => replyPing(b),
  "POST /ask": (b) => askClaude(b),
  "POST /scan/imessage": (b) => scanIMessage(b.min_hours, b.days),
  "POST /scan/email": (b) => scanEmail(b.min_hours, b.days),
  "POST /scan/whatsapp": (b) => scanWhatsApp(b.min_hours, b.days),
};

const server = createServer((req, res) => {
  const send = (code, obj) => {
    console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${code}`);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (API_KEY && req.headers["x-cony-key"] !== API_KEY) return send(401, { error: "bad key" });
  const url = new URL(req.url, "http://x");
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(404, { error: "not found" });
  if (req.method === "GET") {
    try { return send(200, handler(url.searchParams)); }
    catch (e) { return send(500, { error: String(e.message || e) }); }
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const result = handler(parsed);
      send(result.error ? 400 : 200, result);
    } catch (e) {
      send(500, { error: String(e.message || e) });
    }
  });
});

// Tailscale's interface can be briefly gone right after boot/restart —
// retry instead of crash-looping under launchd KeepAlive.
function start() {
  const BIND = tailscaleIp();
  server.listen(PORT, BIND, () => {
    console.log(`cony-api listening on http://${BIND}:${PORT}${API_KEY ? " (key required)" : ""}`);
  });
}
server.on("error", (e) => {
  if (e.code === "EADDRNOTAVAIL" || e.code === "EADDRINUSE") {
    console.log(`listen ${e.code}, retrying in 5s`);
    setTimeout(start, 5000);
  } else {
    throw e;
  }
});
start();
