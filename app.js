const express = require('express');
const session = require('express-session');
const path = require('path');
const dns = require('dns');
require('dotenv').config();

const { logger } = require('./config/logger');
const db = require('./config/database');
const acsServer = require('./services/acsServer');
const adminRoutes = require('./routes/admin');
const customerRoutes = require('./routes/customer');

// Prefer IPv4 to avoid timeouts on local interfaces
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 5000;

// Setup EJS views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session Setup
const sessionSecret = db.getSetting('session_secret', 'acs-lite-secret-session-key-12345');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if deploying over HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Route: Root redirect
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
    if (req.session.user.role === 'customer') return res.redirect('/customer/dashboard');
  }
  res.redirect('/login');
});

// Route: Login Page
app.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
    if (req.session.user.role === 'customer') return res.redirect('/customer/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const { sha256 } = require('./config/database');
    const hash = sha256(password);

    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ? AND is_active = 1').get(username, hash);

    if (!user) {
      return res.render('login', { error: 'Username atau password salah.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
      assigned_device_id: user.assigned_device_id
    };

    logger.info(`User logged in: ${user.username} (${user.role})`);

    if (user.role === 'admin') {
      res.redirect('/admin/dashboard');
    } else {
      res.redirect('/customer/dashboard');
    }
  } catch (err) {
    logger.error('Login error: ' + err.message);
    res.render('login', { error: 'Terjadi kesalahan sistem.' });
  }
});

// Route: Logout
app.get('/logout', (req, res) => {
  if (req.session) {
    const username = req.session.user ? req.session.user.username : 'unknown';
    req.session.destroy(() => {
      logger.info(`User logged out: ${username}`);
      res.redirect('/login');
    });
  } else {
    res.redirect('/login');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Mount TR-069 ACS server endpoint
app.post('/acs', express.raw({ type: ['text/xml', 'application/soap+xml', 'application/xml', 'text/plain'], limit: '2mb' }), acsServer.handleCwmpRequest);

// Mount portal routes
app.use('/admin', adminRoutes);
app.use('/customer', customerRoutes);

// 404 Route handler
app.use((req, res) => {
  res.status(404).render('login', { error: 'Halaman tidak ditemukan.' });
});

// Start listening
app.listen(PORT, () => {
  logger.info(`===================================================`);
  logger.info(` ACS Lite standalone server is running on port ${PORT}`);
  logger.info(` Web Admin Portal:   http://localhost:${PORT}/admin`);
  logger.info(` Customer Portal:    http://localhost:${PORT}/customer`);
  logger.info(` ACS TR-069 URL:     http://<Server-IP>:${PORT}/acs`);
  logger.info(`===================================================`);

  // Auto-start WhatsApp Bot if enabled in SQLite settings
  const { getSetting } = require('./config/database');
  const { startWhatsAppBot } = require('./services/whatsapp');
  if (parseInt(getSetting('whatsapp_enabled', '0'), 10) === 1) {
    startWhatsAppBot();
  }
});

module.exports = app;
