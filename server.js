require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb } = require('./db');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
}));

// Webhook routes bypass auth
app.use('/webhooks', require('./routes/webhooks'));

// Auth routes
app.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// All other routes require auth
app.use(requireAuth);

// API routes
app.use('/api', require('./routes/api'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Page routes
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/va', (req, res) => res.sendFile(path.join(__dirname, 'public', 'va.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

async function start() {
  await initDb();
  app.listen(PORT, () => console.log(`Webinar dashboard running on port ${PORT}`));
}

start().catch(err => { console.error(err); process.exit(1); });
