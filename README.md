# visit.roottorisemicroschool.com

Visit and info-request page for Root to Rise Microschool. Static site on GitHub Pages, with a small Cloudflare Worker that writes to Airtable so the Airtable token is never in the public code.

```
(repo root) -> the page, served by GitHub Pages
worker/    -> the Airtable API (deploy to Cloudflare Workers)
```

## Two entry points, one form

| Link | Opens | Lands in Airtable as |
|---|---|---|
| `visit.roottorisemicroschool.com` | Schedule a visit (tour picker) | Path: Visit form, Status: Tour booked |
| `visit.roottorisemicroschool.com/?info` | Get info (no tour picker) | Path: Info request, Status: Inquiry |

Both create a **Lead** and a linked **Student** in the *R2R Microschool & Daycare* base. A visit also links the **Tour slot**, which updates Booked / Spots left automatically.

## Demo mode

With `API_BASE` empty in `site/config.js`, the page shows sample tour times and submits nothing. Good for reviewing the design before the Worker is live.

## Go-live steps

1. **Logo** – replace `site/assets/logo-placeholder.png` with the original logo file (transparent PNG or SVG) and update the two references in `index.html`.
2. **Airtable token** – airtable.com/create/tokens. Scopes: `data.records:read`, `data.records:write`. Access: only the R2R Microschool & Daycare base.
3. **Worker** – from `worker/`:
   ```
   npx wrangler deploy
   npx wrangler secret put AIRTABLE_TOKEN
   ```
   Copy the Worker URL (e.g. `https://r2r-visit.learnbuildmaintain.workers.dev`).
4. **Point the site at it** – set `API_BASE` in `site/config.js` to that URL.
5. **GitHub Pages** – new repo, push `site/` contents, Settings → Pages → deploy from main. `CNAME` is already set.
6. **DNS (Squarespace domains)** – add a CNAME record: host `visit`, value `<github-username>.github.io`. Then tick "Enforce HTTPS" in GitHub Pages once it verifies.
7. **Tour slots** – add a few future records in Tour Slots with Capacity filled and Open checked.
8. **Test** – book one visit and one info request; check both rows in Leads and Students, then delete them.

## Squarespace buttons

- Schedule a visit → `https://visit.roottorisemicroschool.com`
- Get info → `https://visit.roottorisemicroschool.com/?info`

## Notes

- The Worker re-checks a slot is still open before booking, so two families can't take the last spot.
- "Info request" is added to the Path field automatically the first time one comes in.
- Times display in Eastern Time.
