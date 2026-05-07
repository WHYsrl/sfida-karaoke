require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');

const registrationRoutes = require('./routes/registration');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhook');
const votingRoutes = require('./routes/voting');

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

// Static files — no cache on HTML
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// API Routes
app.use('/api/register', registrationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/vote', votingRoutes);

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
    // Allow 'pubblico' type and nullable songs
    await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_type_check`);
    await pool.query(`ALTER TABLE registrations ADD CONSTRAINT registrations_type_check CHECK (type IN ('solista', 'gruppo', 'pubblico'))`);
    await pool.query(`ALTER TABLE registrations ALTER COLUMN song_1 DROP NOT NULL`);
    await pool.query(`ALTER TABLE registrations ALTER COLUMN song_2 DROP NOT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(6) NOT NULL,
      registration_id INT REFERENCES registrations(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Voting system migrations
    await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS voting_open BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS voting_order INT`);
    await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS current_song_num INT DEFAULT 1`);
    await pool.query(`CREATE TABLE IF NOT EXISTS voter_tokens (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      token UUID NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      voter_email VARCHAR(255) NOT NULL,
      registration_id INT NOT NULL REFERENCES registrations(id),
      score_preparation INT NOT NULL CHECK (score_preparation >= 0 AND score_preparation <= 5),
      score_performance INT NOT NULL CHECK (score_performance >= 0 AND score_performance <= 5),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(voter_email, registration_id)
    )`);
    console.log('✅ Database schema verified (incl. voting)');
  } catch (e) {
    console.warn('⚠️ Migration check skipped:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`🎤 Sfida Karaoke server running on port ${PORT}`);
  });
}
startServer();
