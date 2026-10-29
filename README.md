# Bewtee Salon Tracker — Railway-ready

A no-login, mobile-friendly salon outreach tracker. Uses Flask + SQLite and a persistent Railway volume. Supports salon CRUD, status, visit/revisit checklist, response score, photo proof, A/B/C classification, Excel import, and CSV export.

## Deploy to Railway (recommended: GitHub)

1. Extract the ZIP and upload the **contents** of `bewtee-salon-tracker` to a new private GitHub repository. Do not commit `.env` or database files.
2. At [railway.com](https://railway.com), create a project → **Deploy from GitHub repo** → select that repository. Railway detects the Dockerfile.
3. In the Railway service **Variables**, set:
   - `DATA_DIR`: `/data`
4. Under the service **Volumes**, create a volume and **mount it at `/data`**. Do this **before importing or editing** any salon data. Without a volume, SQLite and uploaded photos can be lost on redeploy.
5. In service **Settings → Networking**, generate a public domain. Railway will build and start the container. Its start command uses Railway's `PORT` automatically.
6. Open the domain, select **Import Excel** and upload `jagatpura_jaipur_salon_outreach.xlsx` (the spreadsheet provided with this package). The import skips duplicate name+area pairs.
7. Test by adding a salon, refreshing the page, and uploading a photo. Then redeploy once and verify data persists.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:8080. Locally data is stored in `./data` unless `DATA_DIR` is set.

## Data and security

- No login or password protection: anyone with the public URL can read, modify, export, or delete salon records and view photos. Use only if you accept public access. HTTPS is provided by Railway.
- Uploaded image files are stored on the persistent volume; image access is public.
- CSV export backs up salon fields, **not photos**. For full backup, also back up the Railway volume (`salons.sqlite3` and `uploads/`).
- Import expects the supplied spreadsheet columns (Salon, Area, Google reviews (reported), Phone, Review-based candidate, Instagram followers, Outreach status, Google Maps search, Notes). Blank followers remain unverified. Final Type is calculated in the app: C if both counts <100, B if both <500, A if both <1000; otherwise Outside criteria. Missing counts = Needs verification.
- For production with more than one admin or heavy traffic, consider moving from SQLite to PostgreSQL and adding named accounts, rate limits and audit logging.
- Keep the GitHub repository private because the bundled outreach sheet contains business contact numbers.

## No-password version
The login page, login/logout API and all authentication checks have been removed. Do not set `ADMIN_PASSWORD` or `SECRET_KEY`. Keep `DATA_DIR=/data` and the persistent Railway volume. **Anyone with the website address can access and edit all data.**
