function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path === '/login' || req.path.startsWith('/webhooks/')) return next();
  res.redirect('/login');
}

function requireWebhookSecret(req, res, next) {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (!process.env.WEBHOOK_SECRET || secret === process.env.WEBHOOK_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAuth, requireWebhookSecret };
