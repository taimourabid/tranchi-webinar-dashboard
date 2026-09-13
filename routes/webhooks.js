const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireWebhookSecret } = require('../middleware/auth');

// Parse a webinar name like "Webinar 9/13/2026" into a date
function parseWebinarDate(name) {
  if (!name) return null;
  const match = name.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// Flexibly extract fields from whatever GHL sends
function extractBooking(body) {
  const c = body.contact || {};
  return {
    contact_id:   body.contact_id   || body.contactId   || c.id       || null,
    contact_name: body.contact_name || body.contactName || c.name     || body.full_name || body.fullName || [body.firstName, body.lastName].filter(Boolean).join(' ') || null,
    contact_email:body.contact_email|| body.email       || c.email    || null,
    contact_phone:body.contact_phone|| body.phone       || c.phone    || null,
    closer:       body.closer_name  || body.closerName  || body.assigned_user || body.assignedUser?.name || null,
    webinar_name: body.webinar_name || body.webinarName || body.calendar_name || body.calendarName || body.calendar?.name || null,
    booked_at:    body.booked_at    || body.startTime   || body.appointmentStartTime || new Date().toISOString(),
    appointment_id: body.appointment_id || body.appointmentId || body.id || null,
  };
}

function extractPayment(body) {
  const c = body.contact || {};
  const amount = parseFloat(body.amount_paid || body.amount || body.total || body.price || 0);
  // Generate a stable dedup key when GHL doesn't send a transaction_id
  const contact_id = body.contact_id || body.contactId || c.id || null;
  const collected_at = body.collected_at || body.paid_at || body.paidAt || body.createdAt || new Date().toISOString();
  const transaction_id = body.transaction_id || body.transactionId ||
    `${contact_id}-${amount}-${new Date(collected_at).getTime()}`;
  return {
    contact_id,
    contact_name:  body.contact_name || body.contactName || c.name  || null,
    closer:        body.closer_name  || body.closerName  || body.assigned_user || null,
    webinar_name:  body.webinar_name || body.webinarName || body.calendar_name || body.calendarName || null,
    amount,
    transaction_id,
    collected_at,
  };
}

function todayWebinarName() {
  const now = new Date();
  return `Webinar ${now.getMonth()+1}/${now.getDate()}/${now.getFullYear()}`;
}

async function findOrCreateWebinar(name) {
  // Fall back to today's date if GHL didn't resolve the field
  const resolved = (name || '').trim();
  name = (resolved && resolved !== 'Webinar') ? resolved : todayWebinarName();
  const date = parseWebinarDate(name);
  const existing = await pool.query('SELECT id FROM webinars WHERE name = $1', [name]);
  if (existing.rows.length) return existing.rows[0].id;
  const result = await pool.query(
    'INSERT INTO webinars (name, date, status) VALUES ($1, $2, $3) RETURNING id',
    [name, date, 'upcoming']
  );
  return result.rows[0].id;
}

// POST /webhooks/booking
router.post('/booking', requireWebhookSecret, async (req, res) => {
  try {
    const data = extractBooking(req.body);
    const webinar_id = await findOrCreateWebinar(data.webinar_name);

    // Upsert by appointment_id to be idempotent
    await pool.query(`
      INSERT INTO leads (webinar_id, contact_id, contact_name, contact_email, contact_phone, closer, appointment_id, booked_at, source, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9)
      ON CONFLICT (appointment_id) DO UPDATE SET
        contact_name   = EXCLUDED.contact_name,
        contact_email  = EXCLUDED.contact_email,
        contact_phone  = EXCLUDED.contact_phone,
        closer         = EXCLUDED.closer,
        raw_payload    = EXCLUDED.raw_payload
    `, [webinar_id, data.contact_id, data.contact_name, data.contact_email, data.contact_phone, data.closer, data.appointment_id, data.booked_at, req.body]);

    res.json({ ok: true, webinar_id, webinar_name: data.webinar_name });
  } catch (err) {
    console.error('Booking webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhooks/payment
router.post('/payment', requireWebhookSecret, async (req, res) => {
  try {
    const data = extractPayment(req.body);
    if (!data.amount || data.amount <= 0) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    const webinar_id = await findOrCreateWebinar(data.webinar_name);

    // Find matching lead for the lead_id FK
    const leadResult = await pool.query(
      'SELECT id FROM leads WHERE webinar_id = $1 AND contact_id = $2 LIMIT 1',
      [webinar_id, data.contact_id]
    );
    const lead_id = leadResult.rows[0]?.id || null;

    // Upsert by transaction_id
    await pool.query(`
      INSERT INTO payments (webinar_id, contact_id, contact_name, lead_id, closer, amount, transaction_id, collected_at, source, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9)
      ON CONFLICT (transaction_id) DO UPDATE SET
        amount       = EXCLUDED.amount,
        contact_name = EXCLUDED.contact_name,
        closer       = EXCLUDED.closer,
        raw_payload  = EXCLUDED.raw_payload
    `, [webinar_id, data.contact_id, data.contact_name, lead_id, data.closer, data.amount, data.transaction_id, data.collected_at, req.body]);

    res.json({ ok: true, webinar_id, amount: data.amount });
  } catch (err) {
    console.error('Payment webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
