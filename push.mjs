#!/usr/bin/env node
// cony push — POST the current ping list to the cloud relay (cony-relay
// Cloudflare Worker) so the phone can read it without Tailscale.
// Config lives outside the repo: ~/.config/cony/relay.json
//   { "url": "...workers.dev", "push_key": "...", "app_key": "..." }
// Usage: node push.mjs [--scan]   --scan refreshes whatsapp/email/imessage first
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { openPings, scanWhatsApp, scanEmail } from "./lib.mjs";

const CFG_PATH = join(homedir(), ".config", "cony", "relay.json");
if (!existsSync(CFG_PATH)) {
  console.error(`no relay config at ${CFG_PATH} — skipping push`);
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(CFG_PATH, "utf-8"));

if (process.argv.includes("--scan")) {
  // no imessage here on purpose: the unattended cycle turned every unanswered
  // text and spam shortcode into a ping. imessage stays manual (POST /scan/imessage).
  const scans = [
    ["whatsapp", scanWhatsApp],
    ["email", scanEmail],
  ];
  for (const [name, fn] of scans) {
    try {
      const r = fn();
      if (r.error) console.error(`scan ${name}: ${r.error}`);
      else console.log(`scan ${name}: ${r.scanned} seen, +${r.added}`);
    } catch (e) {
      console.error(`scan ${name} threw: ${String(e.message || e).slice(0, 150)}`);
    }
  }
}

const pings = openPings();
const res = await fetch(cfg.url + "/push", {
  method: "POST",
  headers: { "content-type": "application/json", "x-push-key": cfg.push_key },
  body: JSON.stringify({ pings }),
});
const out = await res.text();
console.log(`${new Date().toISOString()} push -> ${res.status} ${out.trim()} (${pings.length} open)`);
if (!res.ok) process.exit(1);
