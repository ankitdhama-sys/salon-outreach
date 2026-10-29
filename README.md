# Salon Tracker

A shared tracker for the Bewtee field team. Upload your salon list as a CSV, then every
team member updates visits, the checklist, status, response score, photos and notes from
their phone. Every change is saved in a PostgreSQL database with who made it and when.

## What's inside

| File | What it does |
|---|---|
| `server.js` | Node/Express API + database setup (tables are created automatically) |
| `public/index.html` | The app your team opens on their phones |
| `salons_sample.csv` | Dummy salon list showing the CSV format |
| `package.json` | Dependencies and the `npm start` command Railway runs |

## Deploy on Railway (about 5 minutes)

1. **Put the code on GitHub.** Create a new repository and upload all these files
   (keep the `public` folder).
2. **Create the project.** In Railway: *New Project → Deploy from GitHub repo* → pick the repo.
3. **Add a database.** In the same project: *+ Create → Database → PostgreSQL*.
4. **Connect them.** Open your app service → *Variables* → add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway fills this in from the database)
   - `APP_PASSWORD` = a password you share with the team (recommended; leave unset for no password)
5. **Get a link.** App service → *Settings → Networking → Generate Domain*.
6. Open the link, enter your name (and the team password), tap **☰ → Upload CSV file**
   and choose `salons_sample.csv` (or your real list).

Share the link and password with the team. On phones, “Add to Home Screen” makes it feel like an app.

> Prefer the command line? `npm i -g @railway/cli`, then `railway login`, `railway init`,
> `railway add --database postgres`, set the variables above, and `railway up`.

## CSV format

```
name,area,contact,phone,address,notes,status
XYZ Salon,Gangashahar,Ramesh Kumar,+91 90000 00001,"Near Clock Tower, Gangashahar",Owner is free after 4 pm,New
```

- `name` is required; every other column is optional.
- `status` must be one of: New, Contacted, Interested, Follow-up, Paid, Not interested (anything else becomes New).
- Put a value in double quotes if it contains a comma.
- Common header variants work too (`Salon Name`, `Owner`, `Mobile`, `Location`, `Remarks`).
- **Re-uploading is safe.** A salon with the same name + area is matched, never duplicated.
  Its progress, status and notes are kept; only contact, phone and address are refreshed from the CSV (blank cells are ignored).
  So you can upload new salons any time by adding rows to the same sheet.

## What the team can do

- **Salon list** with *First visit* / *Revisit* tabs, search by name, area, contact or phone, and
  the next action for each salon (visit, create profile, call for paid account, place print material).
  The list refreshes itself every 30 seconds.
- **Profile**: status, 4-step checklist, photos of printed material, response score (−5 to +5),
  notes, tap-to-call phone, and editable salon details (⚙).
- **History**: every change is logged per salon (e.g. “Ravi: ✓ Visited the salon, 2 h ago”).
- **Team tools (☰)**: import CSV, download the CSV template, export all salons to CSV, recent team activity.
- **No overwriting each other**: if two people edit the same salon at once, the second one is told
  and shown the latest version instead of silently replacing it.

## Run locally (optional)

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/salons npm start
```
Then open http://localhost:3000.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_PASSWORD` | no | Team password; strongly recommended for a public link |
| `PGSSL` | no | Set to `true` only if your database requires SSL (e.g. Railway's *public* URL) |
| `PORT` | no | Set automatically by Railway |

## Backups

Use **☰ → Download all salons (CSV)** regularly, and/or enable backups on the Railway Postgres service.
Photos are stored in the database (resized to max 800 px, ~100 KB each, up to 10 per salon).
