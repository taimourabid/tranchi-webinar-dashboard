const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/webinars — list all webinars
router.get('/webinars', async (req, res) => {
  const result = await pool.query(
    'SELECT DISTINCT ON (name) * FROM webinars ORDER BY name, date DESC NULLS LAST, created_at DESC'
  );
  res.json(result.rows);
});

// GET /api/webinars/:id — single webinar metadata
router.get('/webinars/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM webinars WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

// PATCH /api/webinars/:id — update status
router.patch('/webinars/:id', async (req, res) => {
  const { status, name } = req.body;
  const updates = [];
  const vals = [];
  if (status) { vals.push(status); updates.push(`status = $${vals.length}`); }
  if (name)   { vals.push(name);   updates.push(`name = $${vals.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE webinars SET ${updates.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

// POST /api/webinars — manually create webinar
router.post('/webinars', async (req, res) => {
  const { name, date, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await pool.query(
    'INSERT INTO webinars (name, date, status) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET status=$3 RETURNING *',
    [name, date || null, status || 'upcoming']
  );
  res.json(result.rows[0]);
});

// GET /api/webinars/:id/metrics
router.get('/webinars/:id/metrics', async (req, res) => {
  const id = req.params.id;

  const [leadsRes, paymentsRes, closerRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                                        AS booked,
        COUNT(*) FILTER (WHERE showed = true)           AS showed,
        COUNT(*) FILTER (WHERE triaged = true)          AS triaged,
        COUNT(*) FILTER (WHERE qualified = true)        AS qualified
      FROM leads WHERE webinar_id = $1
    `, [id]),
    pool.query(`
      SELECT
        SUM(amount)                                     AS cash_collected,
        COUNT(DISTINCT contact_id)                      AS unique_payers
      FROM payments WHERE webinar_id = $1
    `, [id]),
    pool.query(`
      SELECT
        COALESCE(closer, 'Unassigned')                  AS closer,
        SUM(amount)                                     AS cash_collected,
        COUNT(DISTINCT contact_id)                      AS deals
      FROM payments
      WHERE webinar_id = $1
      GROUP BY closer
      ORDER BY cash_collected DESC
    `, [id]),
  ]);

  const l = leadsRes.rows[0];
  const p = paymentsRes.rows[0];

  const booked        = parseInt(l.booked)    || 0;
  const showed        = parseInt(l.showed)    || 0;
  const triaged       = parseInt(l.triaged)   || 0;
  const qualified     = parseInt(l.qualified) || 0;
  const cash          = parseFloat(p.cash_collected) || 0;
  const unique_payers = parseInt(p.unique_payers)    || 0;

  res.json({
    booked,
    showed,
    triaged,
    qualified,
    closed:        unique_payers,
    show_rate:     booked    ? showed    / booked    : 0,
    triage_rate:   booked    ? triaged   / booked    : 0,
    qualified_rate:booked    ? qualified / booked    : 0,
    closing_rate:  qualified ? unique_payers / qualified : 0,
    aov:           unique_payers ? cash / unique_payers : 0,
    cash_collected:cash,
    closers:       closerRes.rows.map(r => ({
      closer:         r.closer,
      cash_collected: parseFloat(r.cash_collected),
      deals:          parseInt(r.deals),
    })),
  });
});

// GET /api/metrics/all-time — aggregate across all webinars
router.get('/metrics/all-time', async (req, res) => {
  const [leadsRes, paymentsRes, closerRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                                 AS booked,
        COUNT(*) FILTER (WHERE showed = true)    AS showed,
        COUNT(*) FILTER (WHERE triaged = true)   AS triaged,
        COUNT(*) FILTER (WHERE qualified = true) AS qualified
      FROM leads
    `),
    pool.query(`
      SELECT SUM(amount) AS cash_collected, COUNT(DISTINCT contact_id) AS unique_payers
      FROM payments
    `),
    pool.query(`
      SELECT COALESCE(closer,'Unassigned') AS closer, SUM(amount) AS cash_collected, COUNT(DISTINCT contact_id) AS deals
      FROM payments GROUP BY closer ORDER BY cash_collected DESC
    `),
  ]);

  const l = leadsRes.rows[0];
  const p = paymentsRes.rows[0];
  const booked        = parseInt(l.booked)    || 0;
  const showed        = parseInt(l.showed)    || 0;
  const triaged       = parseInt(l.triaged)   || 0;
  const qualified     = parseInt(l.qualified) || 0;
  const cash          = parseFloat(p.cash_collected) || 0;
  const unique_payers = parseInt(p.unique_payers)    || 0;

  res.json({
    booked, showed, triaged, qualified,
    closed:        unique_payers,
    show_rate:     booked    ? showed    / booked    : 0,
    triage_rate:   booked    ? triaged   / booked    : 0,
    qualified_rate:booked    ? qualified / booked    : 0,
    closing_rate:  qualified ? unique_payers / qualified : 0,
    aov:           unique_payers ? cash / unique_payers : 0,
    cash_collected:cash,
    closers:       closerRes.rows.map(r => ({
      closer:         r.closer,
      cash_collected: parseFloat(r.cash_collected),
      deals:          parseInt(r.deals),
    })),
  });
});

// GET /api/webinars/:id/leads — for VA interface
router.get('/webinars/:id/leads', async (req, res) => {
  const result = await pool.query(
    `SELECT id, contact_name, contact_email, contact_phone, closer, booked_at, showed, triaged, qualified, source
     FROM leads WHERE webinar_id = $1 ORDER BY booked_at ASC`,
    [req.params.id]
  );
  res.json(result.rows);
});

// PATCH /api/leads/:id/outcomes — VA checks/unchecks
router.patch('/leads/:id/outcomes', async (req, res) => {
  const { showed, triaged, qualified } = req.body;
  await pool.query(
    'UPDATE leads SET showed=$1, triaged=$2, qualified=$3 WHERE id=$4',
    [!!showed, !!triaged, !!qualified, req.params.id]
  );
  res.json({ ok: true });
});

// POST /api/leads — manual entry
router.post('/leads', async (req, res) => {
  const { webinar_id, contact_name, contact_email, contact_phone, closer, booked_at, showed, triaged, qualified } = req.body;
  if (!webinar_id) return res.status(400).json({ error: 'webinar_id is required' });
  const result = await pool.query(`
    INSERT INTO leads (webinar_id, contact_name, contact_email, contact_phone, closer, booked_at, showed, triaged, qualified, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *
  `, [webinar_id, contact_name, contact_email, contact_phone, closer, booked_at || new Date(), !!showed, !!triaged, !!qualified]);
  res.json(result.rows[0]);
});

// POST /api/payments — manual payment entry
router.post('/payments', async (req, res) => {
  const { webinar_id, contact_id, contact_name, closer, amount, collected_at } = req.body;
  if (!webinar_id || !amount) return res.status(400).json({ error: 'webinar_id and amount are required' });
  const leadRes = await pool.query(
    'SELECT id FROM leads WHERE webinar_id=$1 AND (contact_id=$2 OR contact_name=$3) LIMIT 1',
    [webinar_id, contact_id || '', contact_name || '']
  );
  const result = await pool.query(`
    INSERT INTO payments (webinar_id, contact_id, contact_name, lead_id, closer, amount, collected_at, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'manual') RETURNING *
  `, [webinar_id, contact_id, contact_name, leadRes.rows[0]?.id || null, closer, parseFloat(amount), collected_at || new Date()]);
  res.json(result.rows[0]);
});

// DELETE /api/leads/:id
router.delete('/leads/:id', async (req, res) => {
  await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
