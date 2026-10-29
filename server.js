"use strict";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { parse } = require("csv-parse/sync");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || "";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. On Railway, add a PostgreSQL database and set DATABASE_URL=${{Postgres.DATABASE_URL}} on this service.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const STATUSES = ["New", "Contacted", "Interested", "Follow-up", "Paid", "Not interested"];
const CHECKS = { visit: "Visited the salon", profile: "Bewtee profile created", paid: "Paid account", print: "Printed material at the salon" };
const DETAILS = { name: "Name", area: "Area", contact: "Contact person", phone: "Phone", address: "Address", notes: "Notes" };
const LIMITS = { name: 120, area: 120, contact: 120, phone: 40, address: 300, notes: 2000 };
const MAX_PHOTOS = 10;
const MAX_PHOTO_CHARS = 1_500_000;

// Header aliases accepted in uploaded CSVs (lowercased, letters only)
const ALIAS = {
  salonname: "name", salon: "name",
  owner: "contact", ownername: "contact", contactperson: "contact", manager: "contact",
  mobile: "phone", phonenumber: "phone", contactnumber: "phone", whatsapp: "phone", mobilenumber: "phone",
  location: "area", locality: "area",
  remarks: "notes", comment: "notes", comments: "notes",
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salons (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      area        TEXT NOT NULL DEFAULT '',
      contact     TEXT NOT NULL DEFAULT '',
      phone       TEXT NOT NULL DEFAULT '',
      address     TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'New',
      visit       BOOLEAN NOT NULL DEFAULT false,
      profile     BOOLEAN NOT NULL DEFAULT false,
      paid        BOOLEAN NOT NULL DEFAULT false,
      print       BOOLEAN NOT NULL DEFAULT false,
      resp        INT NOT NULL DEFAULT 0,
      photos      JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by  TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      version     INT NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS salons_name_area ON salons (lower(name), lower(area));
    CREATE TABLE IF NOT EXISTS activity (
      id          SERIAL PRIMARY KEY,
      salon_id    INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      user_name   TEXT NOT NULL,
      action      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS activity_salon ON activity (salon_id, id DESC);
  `);
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const h = fn => (req, res, next) => fn(req, res).catch(next);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const fmt = n => (n > 0 ? "+" : "") + n;
const who = req => {
  try { return decodeURIComponent(req.get("x-user") || "").trim().slice(0, 60) || "Unknown"; }
  catch { return "Unknown"; }
};
const same = (a, b) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(a).digest(),
  crypto.createHash("sha256").update(b).digest()
);
const csvCell = v => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get("/healthz", (req, res) => res.send("ok"));
app.get("/api/config", (req, res) => res.json({ needsPassword: !!PASSWORD, statuses: STATUSES }));

// Everything below needs the team password (when APP_PASSWORD is set)
app.use("/api", (req, res, next) => {
  if (!PASSWORD || same(req.get("x-app-key") || "", PASSWORD)) return next();
  res.status(401).json({ error: "Wrong team password" });
});

app.get("/api/ping", (req, res) => res.json({ ok: true }));

const LIST_COLS = `id, name, area, contact, phone, address, status, visit, profile, paid, print, resp,
  jsonb_array_length(photos)::int AS photo_count, updated_by, updated_at, version`;

app.get("/api/salons", h(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM salons ORDER BY id`);
  res.json(rows);
}));

app.get("/api/salons/:id", h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad salon id" });
  const { rows: [s] } = await pool.query(`SELECT *, jsonb_array_length(photos)::int AS photo_count FROM salons WHERE id = $1`, [id]);
  if (!s) return res.status(404).json({ error: "Salon not found. It may have been deleted." });
  const { rows: activity } = await pool.query(
    `SELECT user_name, action, created_at FROM activity WHERE salon_id = $1 ORDER BY id DESC LIMIT 60`, [id]);
  res.json({ ...s, activity });
}));

app.put("/api/salons/:id", h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad salon id" });
  const b = req.body || {};
  const user = who(req);

  // Validate before touching the database
  if ("name" in b && !str(b.name, LIMITS.name)) return res.status(400).json({ error: "Salon name can't be empty." });
  if ("status" in b && !STATUSES.includes(b.status)) return res.status(400).json({ error: "Unknown status." });
  let photos = null;
  if ("photos" in b) {
    if (!Array.isArray(b.photos) || b.photos.length > MAX_PHOTOS) return res.status(400).json({ error: `Up to ${MAX_PHOTOS} photos per salon.` });
    if (b.photos.some(p => typeof p !== "string" || !p.startsWith("data:image/") || p.length > MAX_PHOTO_CHARS))
      return res.status(400).json({ error: "One of the photos is not a valid image or is too large." });
    photos = b.photos;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [cur] } = await client.query("SELECT * FROM salons WHERE id = $1 FOR UPDATE", [id]);
    if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Salon not found. It may have been deleted." }); }
    if (b.version != null && Number(b.version) !== cur.version) {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "stale", error: `${cur.updated_by || "Someone"} updated this salon while you were editing.` });
    }

    const nx = { ...cur };
    const log = [];
    for (const k of Object.keys(DETAILS)) {
      if (!(k in b)) continue;
      const v = str(b[k], LIMITS[k]);
      if (v === cur[k]) continue;
      nx[k] = v;
      log.push(k === "notes" ? "Notes updated" : `${DETAILS[k]}: ${cur[k] || "—"} → ${v || "—"}`);
    }
    if ("status" in b && b.status !== cur.status) { nx.status = b.status; log.push(`Status: ${cur.status} → ${b.status}`); }
    for (const k of Object.keys(CHECKS)) {
      if (!(k in b)) continue;
      const v = !!b[k];
      if (v === cur[k]) continue;
      nx[k] = v;
      log.push(v ? `✓ ${CHECKS[k]}` : `✗ ${CHECKS[k]} (unchecked)`);
    }
    if ("resp" in b) {
      const v = Math.max(-5, Math.min(5, Math.round(Number(b.resp) || 0)));
      if (v !== cur.resp) { nx.resp = v; log.push(`Response: ${fmt(cur.resp)} → ${fmt(v)}`); }
    }
    if (photos) {
      const before = new Set(cur.photos), after = new Set(photos);
      const added = photos.filter(p => !before.has(p)).length;
      const removed = cur.photos.filter(p => !after.has(p)).length;
      if (added || removed) {
        nx.photos = photos;
        if (added) log.push(`Added ${added} photo${added > 1 ? "s" : ""} of printed material`);
        if (removed) log.push(`Removed ${removed} photo${removed > 1 ? "s" : ""}`);
      }
    }

    if (!log.length) {
      await client.query("ROLLBACK");
      return res.json({ ...cur, photo_count: cur.photos.length, unchanged: true });
    }

    const { rows: [saved] } = await client.query(
      `UPDATE salons SET name=$2, area=$3, contact=$4, phone=$5, address=$6, notes=$7, status=$8,
         visit=$9, profile=$10, paid=$11, print=$12, resp=$13, photos=$14::jsonb,
         updated_by=$15, updated_at=now(), version=version+1
       WHERE id=$1 RETURNING *`,
      [id, nx.name, nx.area, nx.contact, nx.phone, nx.address, nx.notes, nx.status,
        nx.visit, nx.profile, nx.paid, nx.print, nx.resp, JSON.stringify(nx.photos), user]);
    for (const a of log) {
      await client.query("INSERT INTO activity (salon_id, user_name, action) VALUES ($1, $2, $3)", [id, user, a]);
    }
    await client.query("COMMIT");
    res.json({ ...saved, photo_count: saved.photos.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.delete("/api/salons/:id", h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad salon id" });
  const { rowCount } = await pool.query("DELETE FROM salons WHERE id = $1", [id]);
  if (!rowCount) return res.status(404).json({ error: "Salon not found." });
  console.log(`Salon ${id} deleted by ${who(req)}`);
  res.json({ ok: true });
}));

app.post("/api/import", h(async (req, res) => {
  const text = String(req.body?.csv || "");
  if (!text.trim()) return res.status(400).json({ error: "The file is empty." });

  let recs;
  try {
    recs = parse(text, {
      columns: header => header.map(x => {
        const k = String(x).trim().toLowerCase().replace(/[^a-z]/g, "");
        return ALIAS[k] || k;
      }),
      skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
    });
  } catch (e) {
    return res.status(400).json({ error: "Couldn't read this CSV: " + e.message });
  }
  if (!recs.length) return res.status(400).json({ error: "The CSV has a header row but no salons." });
  if (recs.length > 5000) return res.status(400).json({ error: "Upload at most 5,000 salons at a time." });
  if (!("name" in recs[0])) return res.status(400).json({ error: "The CSV needs a “name” column. Download the template to see the format." });

  const user = who(req);
  let added = 0, updated = 0, unchanged = 0;
  const skipped = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [i, r] of recs.entries()) {
      const row = {};
      for (const k of Object.keys(DETAILS)) row[k] = str(r[k], LIMITS[k]);
      if (!row.name) { skipped.push(`Row ${i + 2}: name is empty`); continue; }
      const status = STATUSES.find(s => s.toLowerCase() === String(r.status || "").trim().toLowerCase()) || "New";
      const { rows: [old] } = await client.query(
        "SELECT id, contact, phone, address FROM salons WHERE lower(name) = lower($1) AND lower(area) = lower($2)",
        [row.name, row.area]);
      if (!old) {
        const { rows: [x] } = await client.query(
          `INSERT INTO salons (name, area, contact, phone, address, notes, status, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [row.name, row.area, row.contact, row.phone, row.address, row.notes, status, user]);
        await client.query("INSERT INTO activity (salon_id, user_name, action) VALUES ($1, $2, $3)",
          [x.id, user, "Added from CSV import"]);
        added++;
        continue;
      }
      // Existing salon: keep its progress, only refresh contact details that the CSV provides
      const nx = { contact: row.contact || old.contact, phone: row.phone || old.phone, address: row.address || old.address };
      if (nx.contact === old.contact && nx.phone === old.phone && nx.address === old.address) { unchanged++; continue; }
      await client.query(
        `UPDATE salons SET contact = $2, phone = $3, address = $4, updated_by = $5, updated_at = now(), version = version + 1
         WHERE id = $1`, [old.id, nx.contact, nx.phone, nx.address, user]);
      await client.query("INSERT INTO activity (salon_id, user_name, action) VALUES ($1, $2, $3)",
        [old.id, user, "Contact details updated from CSV import"]);
      updated++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ added, updated, unchanged, skipped });
}));

app.get("/api/export.csv", h(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLS}, notes FROM salons ORDER BY id`);
  const head = ["id", "name", "area", "contact", "phone", "address", "status", "visited", "profile_created",
    "paid", "printed_material", "response", "photos", "notes", "updated_by", "updated_at"];
  const yn = v => (v ? "yes" : "no");
  const lines = rows.map(s => [s.id, s.name, s.area, s.contact, s.phone, s.address, s.status, yn(s.visit), yn(s.profile),
    yn(s.paid), yn(s.print), s.resp, s.photo_count, s.notes, s.updated_by, new Date(s.updated_at).toISOString()].map(csvCell).join(","));
  res.type("text/csv").send([head.join(","), ...lines].join("\r\n"));
}));

app.get("/api/activity", h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.salon_id, a.user_name, a.action, a.created_at, s.name AS salon_name
     FROM activity a JOIN salons s ON s.id = a.salon_id ORDER BY a.id DESC LIMIT 100`);
  res.json(rows);
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Upload is too large. Try fewer photos at once." });
  if (err.code === "23505") return res.status(409).json({ code: "duplicate", error: "Another salon already has this name and area." });
  console.error(err);
  res.status(500).json({ error: "Server error. Please try again." });
});

init()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`Salon Tracker running on port ${PORT}`)))
  .catch(e => { console.error("Database setup failed:", e); process.exit(1); });
