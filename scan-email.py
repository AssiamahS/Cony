#!/usr/bin/env python3
# cony email scanner — reads the hcp Gmail inbox over IMAP (app password in
# the keychain as cony-hcp-imap) and prints pings as JSON: unread messages
# from real people/services that have sat unanswered for min_hours.
# Called by lib.mjs scanEmail(); can also run standalone for debugging.
import imaplib, json, re, subprocess, sys
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime, timedelta, timezone

ACCOUNT = "sylvesterassiamahhcp@gmail.com"
MIN_HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 3
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 7

# marketing/no-reply senders never become pings; apple/testflight are the
# exception because acting on them is the whole point
SKIP = re.compile(r"no-?reply|noreply|newsletter|marketing|store-news|loyalty@|deals|offers|notifications@github"
                  r"|ziprecruiter|creditsesame|credit sesame|indeed\.com|glassdoor|klarna|expedia|bestbuy|amazon\.com"
                  r"|coursera|linkedin\.com|substack|hello\.|email\.|promo", re.I)
KEEP_ANYWAY = re.compile(r"apple\.com|testflight|appstoreconnect|greenhouse|bw-thinking|lever\.co|workday", re.I)

def main():
    pw = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "cony-hcp-imap", "-w"],
                        capture_output=True, text=True).stdout.strip()
    if not pw:
        print(json.dumps({"error": "keychain item cony-hcp-imap missing"})); return
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(ACCOUNT, pw)
    M.select("INBOX", readonly=True)
    since = (datetime.now(timezone.utc) - timedelta(days=DAYS)).strftime("%d-%b-%Y")
    typ, data = M.search(None, "UNSEEN", "SINCE", since)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=MIN_HOURS)
    pings = []
    for mid in data[0].split():
        typ, msg = M.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        m = message_from_bytes(msg[0][1])
        name, addr = parseaddr(m.get("From", ""))
        if SKIP.search(addr or "") and not KEEP_ANYWAY.search((addr or "") + (m.get("Subject") or "")):
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
            "what": subject[:120],
            "since": dt.isoformat(),
            "source": "hcp-imap-scan",
        })
    M.logout()
    print(json.dumps({"scanned": len(data[0].split()), "pings": pings}))

main()
