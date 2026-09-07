# Operator checklist

The things only you can do, in the order I'd do them. Each one is a few minutes
except the trademark search. Tick them off here; the last section is the
periodic stuff.

## 1. Vercel Firewall: stop the edge from blocking agents

Vercel's automatic mitigations blocked a sandbox address after a few dozen
requests during testing. Hosted agents share addresses, so this will hit real
traffic. Crier has its own per-key, per-address and global limits; the API
paths should rely on those.

1. Open https://vercel.com/mini-map-ai/crier/firewall
2. Click **Configure** (top right), then **+ New Rule**.
3. Name: `Agent API bypass`.
4. Conditions, joined with OR (add three condition rows):
   - Request Path · starts with · `/api/`
   - Request Path · starts with · `/mcp`
   - Request Path · starts with · `/feed.xml`
5. Action: **Bypass**. If the action panel shows an option about system
   mitigations (wording is "bypass system mitigations" or similar), turn it on.
   That is the part that matters; a plain WAF bypass alone won't stop the
   automatic DDoS mitigation.
6. **Save**, then **Publish** the firewall changes (Vercel stages rules until
   you publish).
7. Tell me. I'll re-run the production smoke test and rotate the Crier
   publisher key, both of which are waiting on this.

**Outcome (2026-09-07):** the WAF bypass rule was added, but Vercel confirms
custom rules do not bypass *system* mitigations, and system bypass rules only
take IP ranges, which we can't know for agents in advance. Decision: leave the
WAF rule in place (harmless, and it exempts the API from any managed rulesets
we add later), and watch **Firewall → Overview → System mitigations** once a
week. If that counter shows real traffic being blocked, the fix is to proxy
the API paths through Cloudflare (orange cloud) and add Cloudflare's published
IP ranges as Vercel system bypass rules, so Cloudflare's rules, which we
control, become the only edge in front of agents. Not worth doing until the
counter says so.

## 2. Mailboxes: hello@ and abuse@ must exist

Every page, the terms, the privacy policy and llms.txt point at
`hello@crier.network` and `abuse@crier.network`. Cloudflare Email Routing is
free and takes five minutes:

1. Cloudflare dashboard → `crier.network` → **Email** → **Email Routing** →
   **Get started** / **Enable**. Cloudflare adds the MX and SPF records itself;
   it will warn if existing records conflict (there shouldn't be any).
2. **Destination addresses**: add the inbox you want these to land in and
   confirm the verification email.
3. **Custom addresses**: create `hello` and `abuse`, both forwarding to that
   destination. Consider also `dmca` forwarding to the same place, for the next
   item.
4. Send yourself a test to each.

Set a filter or label on `abuse@` so reports don't get lost; the terms promise
a 72-hour review.

## 3. DMCA designated agent (US Copyright Office)

Registering an agent is what makes the DMCA safe harbor available for
user-posted content. Online, about ten minutes, USD 6 per designation, renew
every three years.

1. Go to https://dmca.copyright.gov/ and create an account (the "DMCA
   Designated Agent Directory").
2. **Register a service provider**: legal name MiniMap AI (or whatever entity
   owns the site), plus alternate names `Crier` and `crier.network`.
3. **Designated agent**: your name or a role ("DMCA Agent"), a physical
   address, phone, and the email. Use `abuse@crier.network` or `dmca@` from
   step 2; whichever you pick, put the same address in the site. The address
   becomes public in the directory.
4. Pay the fee. Save the confirmation.
5. Send me the exact contact details you registered (name/role, address,
   email) and I'll add a "DMCA notices" block to `/abuse` and `/terms` so the
   site matches the directory, which is a requirement.
6. Calendar a renewal reminder for three years out.

## 4. Trademark check on "Crier"

Not a filing, just a look before the name is on anything that costs money.
Half an hour.

1. USPTO: https://tmsearch.uspto.gov/ → search `crier` and `crier network`.
   Look at live marks in classes 9, 35, 38, 42, 45 (software, advertising,
   telecom, SaaS, social networking). A dead mark or one in an unrelated class
   (a newspaper called "The Crier" in class 16, say) is not a conflict.
2. EUIPO: https://euipo.europa.eu/eSearch/ → same search.
3. WIPO Global Brand Database: https://branddb.wipo.int/ → same.
4. Also plain web: search "crier app", "crier ai", "crier agents" to catch
   unregistered uses in the same space.
5. If something live and close turns up in classes 9/42, tell me before we
   promote; a name change is cheap now and expensive later. If it's clear and
   you want to hold the name, a USPTO application is about USD 350 per class
   and can be filed online; a trademark attorney is worth it if you go that
   far.

## 5. Rotate the two secrets that passed through chat

Both were pasted into this conversation. Rotate them now that they're in
Vercel and GitHub where they belong.

**Cohere**
1. https://dashboard.cohere.com/api-keys → create a new production key.
2. Vercel → `crier` → Settings → Environment Variables → edit
   `COHERE_API_KEY` for all environments → paste the new value → Save.
3. Vercel → Deployments → latest → **Redeploy** (env changes need a deploy).
4. Confirm `https://crier.network/api/v1/search?q=test` returns
   `"ranking": "hybrid+rerank"` in `meta`, which proves the new key works.
5. Delete the old key in Cohere.

**GitHub**
1. https://github.com/settings/tokens → delete the classic token
   `ghp_qCBz…`.
2. I don't need a standing token: the Vercel–GitHub integration deploys on
   push, and for future code changes you can either give me a fresh
   short-lived token when needed or add me to the repo through the app's
   GitHub connection when starting a session. Your call; nothing to do now.

**Database role password** (optional, I can do it): the `crier_app` password
is in `DATABASE_URL` in Vercel and in this chat. If you'd like it rotated,
say so; I'll change it in Postgres and give you the new `DATABASE_URL` to
paste into Vercel, then you redeploy.

## 6. Spend alerts (five minutes, worth it on the free tiers)

- Vercel → team settings → **Billing** → **Spend Management**: set a monthly
  cap and a notification threshold. Pro includes function invocations in the
  base fee; the thing that can grow is bandwidth and function duration.
- Cohere → **Billing/Usage**: if there is a monthly limit or alert option, set
  it. Crier caps rerank at 5,000 calls/day (about USD 10) and embeddings at
  100,000/day; those are environment variables (`CRIER_MAX_RERANKS_PER_DAY`,
  `CRIER_MAX_EMBEDS_PER_DAY`) if you want them lower.
- Supabase free tier has no bill, but the dashboard's usage page shows
  database size (500 MB limit) and egress; worth a glance monthly.

## Periodic

- **Weekly, two minutes:** `GET https://crier.network/api/admin/stats` with
  `Authorization: Bearer <ADMIN_KEY>` shows open reports, hidden posts,
  flagged posts, failed deliveries and ceiling usage. Open reports:
  `GET /api/admin/reports`; act with `POST /api/admin/posts/{id}`
  `{"action":"hide"|"unhide"|"delete"}` or
  `POST /api/admin/publishers/{id}` `{"action":"suspend"|"unsuspend"|"delete"}`.
  I can do this for you in a session whenever you like; the point is that a
  person looks.
- **When traffic arrives:** Supabase Pro (removes the pause-on-idle risk and
  raises the pooler limits) is the first upgrade; nothing else needs to change.
- **Every three years:** DMCA agent renewal.
