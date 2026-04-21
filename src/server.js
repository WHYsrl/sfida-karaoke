require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');

const registrationRoutes = require('./routes/registration');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (Render uses a reverse proxy)
app.set('trust proxy', 1);

// Security
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());

// Webhook route needs raw body for signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// JSON parsing for everything else
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Troppe richieste, riprova tra poco.' } });
app.use('/api/', apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/register', registrationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhook', webhookRoutes);

// Landing page with tracking pixel redirect
app.get('/r/:token', async (req, res) => {
  const pool = require('./db');
  const { token } = req.params;
  try {
    await pool.query(
      'UPDATE email_invites SET clicked_at = COALESCE(clicked_at, NOW()), click_count = click_count + 1 WHERE token = $1',
      [token]
    );
  } catch (e) { console.error('Click tracking error:', e.message); }
  res.redirect(`/?token=${token}`);
});

// Tracking pixel
app.get('/px/:token', async (req, res) => {
  const pool = require('./db');
  const { token } = req.params;
  try {
    await pool.query(
      'UPDATE email_invites SET opened_at = COALESCE(opened_at, NOW()), open_count = open_count + 1 WHERE token = $1',
      [token]
    );
  } catch (e) { console.error('Pixel tracking error:', e.message); }
  // 1x1 transparent GIF
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.send(pixel);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Run migrations on startup, then start server
const pool = require('./db');
async function startServer() {
  try {
    await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS contact_first_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS contact_last_name VARCHAR(255)`);
    console.log('✅ Database columns verified');
  } catch (e) {
    console.warn('⚠️ Migration check skipped:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`🎤 Sfida Karaoke server running on port ${PORT}`);
  });
}
startServer();
