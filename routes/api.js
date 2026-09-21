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

// DELETE /api/webinars/:id
router.delete('/webinars/:id', async (req, res) => {
  await pool.query('DELETE FROM webinars WHERE id=$1', [req.params.id]);
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
  const id  = req.params.id;
  const src = req.query.source;
  const hasSrc = src && src !== 'all';
  const lParams  = hasSrc ? [id, src] : [id];
  const lFilter  = hasSrc ? ' AND lead_source = $2' : '';

  const [leadsRes, paymentsRes, closerRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT COALESCE(contact_id, id::text))                                              AS booked,
        COUNT(DISTINCT CASE WHEN showed    THEN COALESCE(contact_id, id::text) END)                 AS showed,
        COUNT(DISTINCT CASE WHEN triaged   THEN COALESCE(contact_id, id::text) END)                 AS triaged,
        COUNT(DISTINCT CASE WHEN qualified THEN COALESCE(contact_id, id::text) END)                 AS qualified
      FROM leads WHERE webinar_id = $1${lFilter}
    `, lParams),
    pool.query(`
      SELECT
        SUM(amount)                                     AS cash_collected,
        COUNT(DISTINCT COALESCE(contact_id, id::text)) AS unique_payers
      FROM payments WHERE webinar_id = $1${lFilter}
    `, lParams),
    pool.query(`
      SELECT
        COALESCE(closer, 'Unassigned')                  AS closer,
        SUM(amount)                                     AS cash_collected,
        COUNT(DISTINCT COALESCE(contact_id, id::text)) AS deals
      FROM payments
      WHERE webinar_id = $1${lFilter}
      GROUP BY closer
      ORDER BY cash_collected DESC
    `, lParams),
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
    closing_rate:  showed ? unique_payers / showed : 0,
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
  const src    = req.query.source;
  const hasSrc = src && src !== 'all';
  const params  = hasSrc ? [src] : [];
  const filter  = hasSrc ? ' WHERE lead_source = $1' : '';
  const andFilter = hasSrc ? ' AND lead_source = $1' : '';

  const [leadsRes, paymentsRes, closerRes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT COALESCE(contact_id, id::text))                                 AS booked,
        COUNT(DISTINCT CASE WHEN showed    THEN COALESCE(contact_id, id::text) END)    AS showed,
        COUNT(DISTINCT CASE WHEN triaged   THEN COALESCE(contact_id, id::text) END)    AS triaged,
        COUNT(DISTINCT CASE WHEN qualified THEN COALESCE(contact_id, id::text) END)    AS qualified
      FROM leads${filter}
    `, params),
    pool.query(`
      SELECT SUM(amount) AS cash_collected, COUNT(DISTINCT COALESCE(contact_id, id::text)) AS unique_payers
      FROM payments${filter}
    `, params),
    pool.query(`
      SELECT COALESCE(closer,'Unassigned') AS closer, SUM(amount) AS cash_collected, COUNT(DISTINCT COALESCE(contact_id, id::text)) AS deals
      FROM payments${filter} GROUP BY closer ORDER BY cash_collected DESC
    `, params),
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
    closing_rate:  showed ? unique_payers / showed : 0,
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

// PATCH /api/leads/:id/outcomes — VA checks/unchecks + closer
router.patch('/leads/:id/outcomes', async (req, res) => {
  const { showed, triaged, qualified, closer } = req.body;
  await pool.query(
    'UPDATE leads SET showed=$1, triaged=$2, qualified=$3, closer=$4 WHERE id=$5',
    [!!showed, !!triaged, !!qualified, closer || null, req.params.id]
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

// DELETE /api/payments/:id
router.delete('/payments/:id', async (req, res) => {
  await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// GET /api/webinars/:id/payments — for management
router.get('/webinars/:id/payments', async (req, res) => {
  const result = await pool.query(
    'SELECT id, contact_name, closer, amount, collected_at, source FROM payments WHERE webinar_id=$1 ORDER BY collected_at DESC',
    [req.params.id]
  );
  res.json(result.rows);
});

// POST /api/admin/merge/:from/:into — merge one webinar into another
router.post('/admin/merge/:from/:into', async (req, res) => {
  const { from, into } = req.params;
  await pool.query('UPDATE leads    SET webinar_id=$1 WHERE webinar_id=$2', [into, from]);
  await pool.query('UPDATE payments SET webinar_id=$1 WHERE webinar_id=$2', [into, from]);
  await pool.query('DELETE FROM webinars WHERE id=$1', [from]);
  res.json({ ok: true, merged_from: from, into });
});

// GET /api/webinars/:id/ad-stats
router.get('/webinars/:id/ad-stats', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM webinar_ad_stats WHERE webinar_id=$1',
    [req.params.id]
  );
  res.json(result.rows[0] || { ad_spend:0, link_clicks:0, opt_ins:0, attendees:0, attendees_at_offer:0 });
});

// PUT /api/webinars/:id/ad-stats
router.put('/webinars/:id/ad-stats', async (req, res) => {
  const { ad_spend, link_clicks, opt_ins, attendees, attendees_at_offer } = req.body;
  await pool.query(`
    INSERT INTO webinar_ad_stats (webinar_id, ad_spend, link_clicks, opt_ins, attendees, attendees_at_offer, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (webinar_id) DO UPDATE SET
      ad_spend           = EXCLUDED.ad_spend,
      link_clicks        = EXCLUDED.link_clicks,
      opt_ins            = EXCLUDED.opt_ins,
      attendees          = EXCLUDED.attendees,
      attendees_at_offer = EXCLUDED.attendees_at_offer,
      updated_at         = NOW()
  `, [req.params.id, ad_spend||0, link_clicks||0, opt_ins||0, attendees||0, attendees_at_offer||0]);
  res.json({ ok: true });
});

// GET /api/ad-stats/all-time — aggregate across all webinars
router.get('/ad-stats/all-time', async (req, res) => {
  const result = await pool.query(`
    SELECT
      SUM(ad_spend)           AS ad_spend,
      SUM(link_clicks)        AS link_clicks,
      SUM(opt_ins)            AS opt_ins,
      SUM(attendees)          AS attendees,
      SUM(attendees_at_offer) AS attendees_at_offer
    FROM webinar_ad_stats
  `);
  const row = result.rows[0];
  res.json({
    ad_spend:           parseFloat(row.ad_spend)           || 0,
    link_clicks:        parseInt(row.link_clicks)          || 0,
    opt_ins:            parseInt(row.opt_ins)              || 0,
    attendees:          parseInt(row.attendees)            || 0,
    attendees_at_offer: parseInt(row.attendees_at_offer)   || 0,
  });
});

// POST /api/admin/dedup — normalize names and merge duplicate webinars
router.post('/admin/dedup', async (req, res) => {
  // Step 1: normalize all webinar names (replace non-breaking spaces etc.)
  await pool.query(`UPDATE webinars SET name = regexp_replace(trim(name), '[\\u00a0\\s]+', ' ', 'g')`);
  // Step 2: merge duplicates
  const dupes = await pool.query(`
    SELECT name, MIN(id) AS keep_id, array_agg(id ORDER BY id) AS all_ids
    FROM webinars GROUP BY name HAVING COUNT(*) > 1
  `);
  let cleaned = 0;
  for (const row of dupes.rows) {
    await pool.query('UPDATE leads    SET webinar_id=$1 WHERE webinar_id=ANY($2)', [row.keep_id, row.all_ids]);
    await pool.query('UPDATE payments SET webinar_id=$1 WHERE webinar_id=ANY($2)', [row.keep_id, row.all_ids]);
    await pool.query('DELETE FROM webinars WHERE id=ANY($1) AND id<>$2', [row.all_ids, row.keep_id]);
    cleaned++;
  }
  res.json({ ok: true, duplicates_removed: cleaned });
});

module.exports = router;
