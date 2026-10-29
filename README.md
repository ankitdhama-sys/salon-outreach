# Bewtee Salon Tracker — Railway-ready

A password-protected, mobile-friendly salon outreach tracker. Uses Flask + SQLite and a persistent Railway volume. Supports salon CRUD, status, visit/revisit checklist, response score, photo proof, A/B/C classification, Excel import, and CSV export.

## Deploy to Railway (recommended: GitHub)

1. Extract the ZIP and upload the **contents** of `bewtee-salon-tracker` to a new private GitHub repository. Do not commit `.env` or database files.
2. At [railway.com](https://railway.com), create a project → **Deploy from GitHub repo** → select that repository. Railway detects the Dockerfile.
3. In the Railway service **Variables**, set:
   - `ADMIN_PASSWORD`: a strong unique password (required)
   - `SECRET_KEY`: a long random string (required for persistent login sessions; e.g. `python -c "import secrets; print(secrets.token_hex(32))"`)
   - `DATA_DIR`: `/data`
4. Under the service **Volumes**, create a volume and **mount it at `/data`**. Do this **before importing or editing** any salon data. Without a volume, SQLite and uploaded photos can be lost on redeploy.
5. In service **Settings → Networking**, generate a public domain. Railway will build and start the container. Its start command uses Railway's `PORT` automatically.
6. Open the domain, log in using `ADMIN_PASSWORD`, then select **Import Excel** and upload `jagatpura_jaipur_salon_outreach.xlsx` (the spreadsheet provided with this package). The import skips duplicate name+area pairs.
7. Test by adding a salon, refreshing the page, and uploading a photo. Then redeploy once and verify data persists.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
export ADMIN_PASSWORD='change-me' SECRET_KEY='some-long-random-secret' # Windows PowerShell: $env:ADMIN_PASSWORD='change-me'; $env:SECRET_KEY='some-long-random-secret'
python app.py
```

Open http://localhost:8080. Locally data is stored in `./data` unless `DATA_DIR` is set.

## Data and security

- Only one shared admin password; this is not multi-user role management. HTTPS is provided by Railway's public domain.
- Uploaded image files are stored on the persistent volume; image access requires login.
- CSV export backs up salon fields, **not photos**. For full backup, also back up the Railway volume (`salons.sqlite3` and `uploads/`).
- Import expects the supplied spreadsheet columns (Salon, Area, Google reviews (reported), Phone, Review-based candidate, Instagram followers, Outreach status, Google Maps search, Notes). Blank followers remain unverified. Final Type is calculated in the app: C if both counts <100, B if both <500, A if both <1000; otherwise Outside criteria. Missing counts = Needs verification.
- For production with more than one admin or heavy traffic, consider moving from SQLite to PostgreSQL and adding named accounts, rate limits and audit logging.
- Keep the GitHub repository private because the bundled outreach sheet contains business contact numbers.
