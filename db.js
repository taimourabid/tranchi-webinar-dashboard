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

    CREATE INDEX IF NOT EXISTS idx_leads_webinar ON leads(webinar_id);
    CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_id);
    CREATE INDEX IF NOT EXISTS idx_payments_webinar ON payments(webinar_id);
    CREATE INDEX IF NOT EXISTS idx_payments_contact ON payments(contact_id);
  `);
  console.log('Database schema initialized');
}

module.exports = { pool, initDb };
