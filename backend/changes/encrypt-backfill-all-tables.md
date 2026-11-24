---
type: fix
audience: admin
---
**Encryption:** the encryption backfill now covers every encrypted field (ticket resolution summaries, private notes, time entry notes, alerts, company names and notes, inbound email, email account tokens, alert source tokens, scheduled tickets and tasks). Also fixed Microsoft 365 / Google directory lookups and the `{ticket.title}` canned response tag, which came back empty once encryption was on.
