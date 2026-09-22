require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webinars (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      date DATE,
      status TEXT DEFAULT 'upcoming',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      webinar_id INTEGER REFERENCES webinars(id) ON DELETE CASCADE,
      contact_id TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      closer TEXT,
      appointment_id TEXT UNIQUE,
      booked_at TIMESTAMPTZ,
      showed BOOLEAN DEFAULT FALSE,
      triaged BOOLEAN DEFAULT FALSE,
      qualified BOOLEAN DEFAULT FALSE,
      source TEXT DEFAULT 'auto',
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      webinar_id INTEGER REFERENCES webinars(id) ON DELETE CASCADE,
      contact_id TEXT,
      contact_name TEXT,
      lead_id INTEGER REFERENCES leads(id),
      closer TEXT,
      amount NUMERIC(10,2) NOT NULL,
      transaction_id TEXT UNIQUE,
      collected_at TIMESTAMPTZ,
      source TEXT DEFAULT 'auto',
      raw_payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS webinar_ad_stats (
      id                  SERIAL PRIMARY KEY,
      webinar_id          INTEGER REFERENCES webinars(id) ON DELETE CASCADE UNIQUE,
      ad_spend            NUMERIC(10,2) DEFAULT 0,
      link_clicks         INTEGER DEFAULT 0,
      opt_ins             INTEGER DEFAULT 0,
      attendees           INTEGER DEFAULT 0,
      attendees_at_offer  INTEGER DEFAULT 0,
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_leads_webinar ON leads(webinar_id);
    CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_contact_webinar
      ON leads(webinar_id, contact_id) WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_webinar ON payments(webinar_id);
    CREATE INDEX IF NOT EXISTS idx_payments_contact ON payments(contact_id);
  `);
  // Add recording_url to webinars if not present
  await pool.query(`ALTER TABLE webinars ADD COLUMN IF NOT EXISTS recording_url TEXT;`);
  // Add lead_source column if not already present; existing rows default to 'paid'
  await pool.query(`
    ALTER TABLE leads    ADD COLUMN IF NOT EXISTS lead_source TEXT NOT NULL DEFAULT 'paid';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS lead_source TEXT NOT NULL DEFAULT 'paid';
  `);
  // Deduplicate webinars: keep lowest id per name, reassign leads/payments first
  await pool.query(`
    DO $$
    DECLARE dup RECORD;
    BEGIN
      FOR dup IN
        SELECT name, MIN(id) AS keep_id, array_agg(id ORDER BY id) AS all_ids
        FROM webinars GROUP BY name HAVING COUNT(*) > 1
      LOOP
        UPDATE leads    SET webinar_id = dup.keep_id WHERE webinar_id = ANY(dup.all_ids) AND webinar_id <> dup.keep_id;
        UPDATE payments SET webinar_id = dup.keep_id WHERE webinar_id = ANY(dup.all_ids) AND webinar_id <> dup.keep_id;
        DELETE FROM webinars WHERE id = ANY(dup.all_ids) AND id <> dup.keep_id;
      END LOOP;
    END $$;
  `);
  console.log('Database schema initialized');
}

module.exports = { pool, initDb };
