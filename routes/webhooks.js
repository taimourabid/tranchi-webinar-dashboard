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

// GHL wraps our configured custom fields under body.customData
// Fall back to top-level fields for anything not in customData
function extractBooking(body) {
  const cd = body.customData || {};
  const u  = body.user || {};
  const closerName = cd.closer_name || body.closer_name ||
    [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
  return {
    contact_id:    cd.contact_id    || body.contact_id    || body.contactId  || null,
    contact_name:  cd.contact_name  || body.contact_name  || body.full_name  || body.fullName || null,
    contact_email: cd.contact_email || body.contact_email || body.email      || null,
    contact_phone: cd.contact_phone || body.contact_phone || body.phone      || null,
    closer:        closerName,
    webinar_name:  cd.webinar_name  || body.webinar_name  || body['webinar date'] || null,
    booked_at:     cd.booked_at     || body.booked_at     || body.startTime  || new Date().toISOString(),
    appointment_id:cd.appointment_id|| body.appointment_id|| body.appointmentId || body.id || null,
  };
}

function extractPayment(body) {
  const cd = body.customData || {};
  const u  = body.user || {};
  const closerName = cd.closer_name || body.closer_name ||
    [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
  const contact_id = cd.contact_id || body.contact_id || body.contactId || null;
  const rawAmount  = String(cd.amount_paid || body['Amount paid'] || body.amount_paid || body.amount || '0');
  const amount     = parseFloat(rawAmount.replace(/[^0-9.]/g, '')) || 0;
  const collected_at = cd.collected_at || body.collected_at || body.paid_at || new Date().toISOString();
  const transaction_id = cd.transaction_id || body.transaction_id ||
    `${contact_id}-${amount}-${new Date(collected_at).getTime()}`;
  return {
    contact_id,
    contact_name:  cd.contact_name  || body.contact_name  || body.full_name  || null,
    closer:        closerName,
    webinar_name:  cd.webinar_name  || body.webinar_name  || body['webinar date'] || null,
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
  const resolved = (name || '').replace(/ /g, ' ').trim();
  name = (resolved && resolved !== 'Webinar') ? resolved : todayWebinarName();
  const date = parseWebinarDate(name);
  const result = await pool.query(`
    INSERT INTO webinars (name, date, status) VALUES ($1, $2, 'upcoming')
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [name, date]);
  return result.rows[0].id;
}

// POST /webhooks/booking
router.post('/booking', requireWebhookSecret, async (req, res) => {
  try {
    const data = extractBooking(req.body);
    const webinar_id = await findOrCreateWebinar(data.webinar_name);

    // Upsert per contact per webinar — multiple bookings by same contact = 1 lead
    const existing = data.contact_id
      ? await pool.query('SELECT id FROM leads WHERE webinar_id=$1 AND contact_id=$2 LIMIT 1', [webinar_id, data.contact_id])
      : { rows: [] };

    if (existing.rows.length) {
      await pool.query(`
        UPDATE leads SET contact_name=$1, contact_email=$2, contact_phone=$3,
          closer=COALESCE($4, closer), appointment_id=$5, raw_payload=$6
        WHERE id=$7
      `, [data.contact_name, data.contact_email, data.contact_phone, data.closer, data.appointment_id, req.body, existing.rows[0].id]);
    } else {
      await pool.query(`
        INSERT INTO leads (webinar_id, contact_id, contact_name, contact_email, contact_phone, closer, appointment_id, booked_at, source, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9)
        ON CONFLICT (appointment_id) DO UPDATE SET contact_name=EXCLUDED.contact_name, raw_payload=EXCLUDED.raw_payload
      `, [webinar_id, data.contact_id, data.contact_name, data.contact_email, data.contact_phone, data.closer, data.appointment_id, data.booked_at, req.body]);
    }

    res.json({ ok: true, webinar_id, webinar_name: data.webinar_name });
  } catch (err) {
    console.error('Booking webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhooks/payment
router.post('/payment', requireWebhookSecret, async (req, res) => {
  try {
    console.log('Payment webhook raw body:', JSON.stringify(req.body));
    const data = extractPayment(req.body);
    console.log('Payment extracted amount:', data.amount, '| raw amount_paid:', req.body.amount_paid);
    if (!data.amount || data.amount <= 0) {
      return res.status(400).json({ error: 'amount must be > 0', received: req.body.amount_paid || req.body.amount || null });
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
