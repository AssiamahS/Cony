#!/usr/bin/env python3
# cony email scanner v2 — reads the hcp Gmail inbox over IMAP and emits pings.
# Signal over noise: a sender only pings if (a) the user has WRITTEN to them
# before (harvested from Sent Mail, cached 24h), or (b) they match the
# always-keep list (apple/testflight/recruiters/clients). Marketing dies here.
import imaplib, json, os, re, subprocess, sys, time
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr, getaddresses, parsedate_to_datetime
from datetime import datetime, timedelta, timezone

ACCOUNT = "sylvesterassiamahhcp@gmail.com"
CACHE = os.path.expanduser("~/cony/.known-senders.json")
MIN_HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 3
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 7

KEEP_ANYWAY = re.compile(r"apple\.com|testflight|appstoreconnect|greenhouse|bw-thinking|lever\.co|workday|docusign|omegachain", re.I)
NEVER = re.compile(r"mailer-daemon|postmaster|sylvesterassiamah(105|pm|hcp)?@|pelotonysl@", re.I)

def login():
    pw = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "cony-hcp-imap", "-w"],
                        capture_output=True, text=True).stdout.strip()
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(ACCOUNT, pw)
    return M

def known_senders(M):
    try:
        c = json.load(open(CACHE))
        if time.time() - c["ts"] < 86400:
            return set(c["addrs"])
    except Exception:
        pass
    addrs = set()
    M.select('"[Gmail]/Sent Mail"', readonly=True)
    since = (datetime.now(timezone.utc) - timedelta(days=365)).strftime("%d-%b-%Y")
    typ, data = M.search(None, "SINCE", since)
    ids = data[0].split()
    for i in range(0, len(ids), 50):
        batch = b",".join(ids[i:i+50]).decode()
        typ, msgs = M.fetch(batch, "(BODY.PEEK[HEADER.FIELDS (TO CC)])")
        for part in msgs:
            if isinstance(part, tuple):
                m = message_from_bytes(part[1])
                for _, a in getaddresses(m.get_all("To", []) + m.get_all("Cc", [])):
                    if a: addrs.add(a.lower())
    json.dump({"ts": time.time(), "addrs": sorted(addrs)}, open(CACHE, "w"))
    return addrs

def main():
    M = login()
    known = known_senders(M)
    M.select("INBOX", readonly=True)
    since = (datetime.now(timezone.utc) - timedelta(days=DAYS)).strftime("%d-%b-%Y")
    typ, data = M.search(None, "UNSEEN", "SINCE", since)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=MIN_HOURS)
    pings = []
    for mid in data[0].split():
        typ, msg = M.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE LIST-UNSUBSCRIBE PRECEDENCE)])")
        m = message_from_bytes(msg[0][1])
        name, addr = parseaddr(m.get("From", ""))
        addr = (addr or "").lower()
        if NEVER.search(addr):
            continue
        # unknown senders still ping if they look like a human: no bulk-mail
        # machinery (List-Unsubscribe / Precedence: bulk) and not a no-reply.
        is_known = addr in known or KEEP_ANYWAY.search(addr + (m.get("Subject") or ""))
        looks_human = (not m.get("List-Unsubscribe")
                       and (m.get("Precedence") or "").lower() not in ("bulk", "list")
                       and not re.search(r"no-?reply|donotreply|notifications?@|automated", addr))
        if not is_known and not looks_human:
            continue
        try:
            dt = parsedate_to_datetime(m.get("Date"))
            if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if dt > cutoff:
            continue
        subject = str(make_header(decode_header(m.get("Subject") or ""))).strip()
        pings.append({
            "channel": "email",
            "who": name or addr,
            "reply_to": addr,
            "what": f"Reply to this email: {subject[:100]}",
            "since": dt.isoformat(),
            "source": "hcp-imap-scan",
        })
    M.logout()
    print(json.dumps({"scanned": len(data[0].split()), "known_senders": len(known), "pings": pings}))

main()
