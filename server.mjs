#!/usr/bin/env node
// cony-mcp — the "nothing falls through the cracks" queue, for Claude sessions.
// A ping = a person waiting on the user, on any channel. Sessions that can
// see a channel (Gmail MCP, telegram MCP) feed pings in; cony keeps the queue.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { addPing, resolvePing, snoozePing, openPings, brief, scanIMessage, scanEmail, CHANNELS } from "./lib.mjs";

const server = new Server({ name: "cony", version: "1.0.0" }, {
  capabilities: { tools: {} },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "cony_pings",
      description: "Who is waiting on the user right now, across every channel, oldest first. Call at conversation start and before any 'what should I do' answer.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "cony_add",
      description: "Record that someone is waiting on the user. Use whenever an unanswered message/thread/call is spotted on any channel (email, imessage, sms, telegram, whatsapp, instagram, call). Dedupes per person+channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: `One of: ${CHANNELS.join(", ")}` },
          who: { type: "string", description: "Person or address waiting (e.g. 'Mr. Bond', 'ResourceManagement@bw-thinking.com')" },
          what: { type: "string", description: "What they're waiting for, one line" },
          since: { type: "string", description: "ISO timestamp of their last message (default now)" },
          source: { type: "string", description: "Where this was spotted (e.g. gmail-scan)" },
        },
        required: ["channel", "who"],
      },
    },
    {
      name: "cony_resolve",
      description: "Mark a ping handled (the user replied / it no longer needs action).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          note: { type: "string", description: "How it was resolved" },
        },
        required: ["id"],
      },
    },
    {
      name: "cony_snooze",
      description: "Snooze a ping for N hours (default 24). It reopens automatically.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          hours: { type: "number" },
        },
        required: ["id"],
      },
    },
    {
      name: "cony_brief",
      description: "The daily-brief paragraph: every open ping in speakable form. This is what the watch, Alexa, and the 8am nudge read.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "cony_scan_email",
      description: "Scan the hcp Gmail inbox over IMAP (keychain app password) for unread mail from real people/services sitting unanswered, and add pings. Apple/TestFlight/recruiter senders always count; marketing noise is skipped.",
      inputSchema: {
        type: "object",
        properties: {
          min_hours: { type: "number", description: "Only flag if unanswered this many hours (default 3)" },
          days: { type: "number", description: "Look-back window in days (default 7)" },
        },
      },
    },
    {
      name: "cony_scan_imessage",
      description: "Scan the Mac's Messages database for conversations where the last message is inbound (user never replied) and add them as pings. Requires Full Disk Access; returns a clear error if not granted.",
      inputSchema: {
        type: "object",
        properties: {
          min_hours: { type: "number", description: "Only flag if unanswered this many hours (default 3)" },
          days: { type: "number", description: "Look-back window in days (default 14)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  switch (name) {
    case "cony_pings": {
      const pings = openPings();
      if (!pings.length) return text("No open pings. Nobody is waiting on the user.");
      return text(pings.map(p =>
        `[${p.id}] ${p.channel} · ${p.who} · waiting ${p.hours_waiting}h${p.what ? " — " + p.what : ""}`
      ).join("\n"));
    }
    case "cony_add": {
      const r = addPing(args);
      return text(`${r.deduped ? "Refreshed" : "Added"} [${r.ping.id}] ${r.ping.channel} · ${r.ping.who}`);
    }
    case "cony_resolve": {
      const r = resolvePing(args);
      if (r.error) return text(r.error);
      return text(`Resolved [${r.ping.id}] ${r.ping.who}`);
    }
    case "cony_snooze": {
      const r = snoozePing(args);
      if (r.error) return text(r.error);
      return text(`Snoozed [${r.ping.id}] ${r.ping.who} until ${r.ping.snooze_until}`);
    }
    case "cony_brief":
      return text(brief());
    case "cony_scan_email": {
      const r = scanEmail(args.min_hours, args.days);
      if (r.error) return text(r.error + (r.detail ? " " + r.detail : ""));
      return text(`Scanned ${r.scanned} unread emails, added ${r.added} new pings.`);
    }
    case "cony_scan_imessage": {
      const r = scanIMessage(args.min_hours, args.days);
      if (r.error) return text(r.error);
      return text(`Scanned ${r.scanned} unanswered conversations, added ${r.added} new pings.`);
    }
    default:
      return text(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
