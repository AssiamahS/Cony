// cony core — one queue of "people waiting on you" across every channel.
// Shared by the MCP server (server.mjs) and the HTTP API (api.mjs).
// Channels that can't be scanned automatically (whatsapp, instagram, calls)
// enter through manual capture or a Claude session that can see them.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

const MEM = join(homedir(), ".claude", "projects", "-Users-djsly", "memory");
export const CONY_PATH = join(MEM, "cony.json");

export const CHANNELS = ["imessage", "sms", "email", "telegram", "whatsapp", "instagram", "call", "other"];

export function load() {
  if (existsSync(CONY_PATH)) return JSON.parse(readFileSync(CONY_PATH, "utf-8"));
  return { pings: [] };
}
export function save(db) {
  writeFileSync(CONY_PATH, JSON.stringify(db, null, 2));
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function hoursSince(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.round((Date.now() - t) / 3600000 * 10) / 10;
}

// A ping = someone is waiting on the user.
// { id, channel, who, what, since (ISO), source, status: open|done|snoozed,
//   snooze_until?, resolved?, created }
export function addPing(args) {
  const db = load();
  const channel = CHANNELS.includes(args.channel) ? args.channel : "other";
  // dedupe: same person + channel open → refresh; resolved within 7 days →
  // stay dead (the user handled it; an unread flag in gmail doesn't reopen it)
  const who = String(args.who).toLowerCase();
  const existing = db.pings.find(p => p.status === "open" && p.channel === channel
    && p.who.toLowerCase() === who);
  if (existing) {
    if (args.what) existing.what = args.what;
    if (args.since) existing.since = args.since;
    save(db);
    return { ping: existing, deduped: true };
  }
  const recentlyDone = db.pings.find(p => p.status === "done" && p.channel === channel
    && p.who.toLowerCase() === who
    && p.resolved && (Date.now() - new Date(p.resolved)) < 7 * 86400000);
  if (recentlyDone && args.source !== "manual") {
    return { ping: recentlyDone, deduped: true };
  }
  const ping = {
    id: genId(),
    channel,
    who: args.who,
    what: args.what || "",
    since: args.since || new Date().toISOString(),
    source: args.source || "manual",
    status: "open",
    created: new Date().toISOString().split("T")[0],
  };
  if (args.reply_to) ping.reply_to = args.reply_to;
  db.pings.push(ping);
  save(db);
  return { ping };
}

export function resolvePing(args) {
  const db = load();
  const p = db.pings.find(x => x.id === args.id);
  if (!p) return { error: "Ping not found." };
  p.status = "done";
  p.resolved = new Date().toISOString();
  if (args.note) p.what = (p.what ? p.what + " | " : "") + args.note;
  save(db);
  return { ping: p };
}

export function snoozePing(args) {
  const db = load();
  const p = db.pings.find(x => x.id === args.id);
  if (!p) return { error: "Ping not found." };
  p.status = "snoozed";
  const hours = Number(args.hours) || 24;
  p.snooze_until = new Date(Date.now() + hours * 3600000).toISOString();
  save(db);
  return { ping: p };
}

// Wake snoozed pings whose time has come, then return open pings oldest-first.
export function openPings() {
  const db = load();
  let changed = false;
  for (const p of db.pings) {
    if (p.status === "snoozed" && p.snooze_until && new Date(p.snooze_until) <= new Date()) {
      p.status = "open";
      delete p.snooze_until;
      changed = true;
    }
  }
  if (changed) save(db);
  return db.pings
    .filter(p => p.status === "open")
    .map(p => ({ ...p, hours_waiting: hoursSince(p.since) }))
    .sort((a, b) => (b.hours_waiting ?? 0) - (a.hours_waiting ?? 0));
}

// The daily-brief string: what Alexa / the watch / the 8am nudge reads out.
export function brief() {
  const pings = openPings();
  if (!pings.length) return "Inbox zero across every channel. Nobody is waiting on you.";
  const lines = [`${pings.length} ${pings.length === 1 ? "person is" : "people are"} waiting on you:`];
  for (const p of pings) {
    const age = p.hours_waiting === null ? "" :
      p.hours_waiting >= 48 ? ` (${Math.round(p.hours_waiting / 24)} days)` :
      ` (${Math.round(p.hours_waiting)}h)`;
    lines.push(`- ${p.channel}: ${p.who}${age}${p.what ? " — " + p.what : ""}`);
  }
  return lines.join("\n");
}

// Reply as the user: dispatches the scipio send-email workflow, which sends
// from sylvesterassiamah105@gmail.com via the Gmail app password in CI.
// Resolves the ping on successful dispatch.
export function replyPing(args) {
  const db = load();
  const p = db.pings.find(x => x.id === args.id);
  if (!p) return { error: "Ping not found." };
  const to = args.to || p.reply_to || (p.who.includes("@") ? p.who : null);
  if (!to) return { error: `No email address for '${p.who}' — pass 'to' explicitly.` };
  if (!args.body) return { error: "Reply body required." };
  try {
    execFileSync("/opt/homebrew/bin/gh", ["workflow", "run", "send-email.yml",
      "-R", "AssiamahS/scipio",
      "-f", `to=${to}`,
      "-f", `subject=${args.subject || "Re: " + (p.what || "your message")}`,
      "-f", `body=${args.body}`,
    ], { encoding: "utf-8", timeout: 30000, env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" } });
  } catch (e) {
    return { error: "Send dispatch failed.", detail: String(e.message || e).slice(0, 200) };
  }
  p.status = "done";
  p.resolved = new Date().toISOString();
  p.what = (p.what ? p.what + " | " : "") + "replied via cony";
  save(db);
  return { ping: p, sent_to: to };
}

// Email scan: hcp Gmail over IMAP (scan-email.py, keychain app password).
// Unread mail from real people/services older than minHours becomes pings.
export function scanEmail(minHours = 3, days = 7) {
  let out;
  try {
    out = execFileSync("/usr/bin/python3",
      [new URL("./scan-email.py", import.meta.url).pathname, String(minHours), String(days)],
      { encoding: "utf-8", timeout: 60000 });
  } catch (e) {
    return { error: "Email scan failed.", detail: String(e.message || e).slice(0, 200) };
  }
  const r = JSON.parse(out);
  if (r.error) return r;
  const added = [];
  for (const p of r.pings) {
    const res = addPing(p);
    if (!res.deduped) added.push(res.ping);
  }
  return { scanned: r.scanned, added: added.length, pings: added };
}

// iMessage scan: conversations where the LAST message is inbound and older
// than min_hours. Requires Full Disk Access for the process running this
// (System Settings → Privacy & Security → Full Disk Access).
export function scanIMessage(minHours = 3, days = 14) {
  const dbPath = join(homedir(), "Library", "Messages", "chat.db");
  const appleEpochOffset = 978307200; // Apple stores nanoseconds since 2001-01-01
  const sql = `
    SELECT c.chat_identifier, m.text, m.is_from_me,
           (m.date/1000000000 + ${appleEpochOffset}) AS ts
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    WHERE m.ROWID = (
      SELECT m2.ROWID FROM chat_message_join cmj2
      JOIN message m2 ON m2.ROWID = cmj2.message_id
      WHERE cmj2.chat_id = c.ROWID ORDER BY m2.date DESC LIMIT 1
    )
    AND m.is_from_me = 0
    AND (m.date/1000000000 + ${appleEpochOffset}) > strftime('%s','now') - ${days} * 86400
    AND (m.date/1000000000 + ${appleEpochOffset}) < strftime('%s','now') - ${minHours} * 3600;`;
  let rows;
  try {
    rows = execFileSync("/usr/bin/sqlite3", ["-json", dbPath, sql], { encoding: "utf-8" });
  } catch (e) {
    return { error: "Cannot read Messages database. Grant Full Disk Access to the process running cony (System Settings → Privacy & Security → Full Disk Access), then rescan.", detail: String(e.message || e).slice(0, 200) };
  }
  const found = rows.trim() ? JSON.parse(rows) : [];
  const added = [];
  for (const r of found) {
    const res = addPing({
      channel: "imessage",
      who: r.chat_identifier,
      what: (r.text || "").slice(0, 120),
      since: new Date(r.ts * 1000).toISOString(),
      source: "imessage-scan",
    });
    if (!res.deduped) added.push(res.ping);
  }
  return { scanned: found.length, added: added.length, pings: added };
}
