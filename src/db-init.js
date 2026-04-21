require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const schema = `
-- Inviti email inviati
CREATE TABLE IF NOT EXISTS email_invites (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  company VARCHAR(50) NOT NULL CHECK (company IN ('ourfilms', 'framebyframe')),
  token UUID NOT NULL UNIQUE,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  open_count INT DEFAULT 0,
  click_count INT DEFAULT 0,
  resend_message_id VARCHAR(255)
);

-- Registrazioni (una per solista o gruppo)
CREATE TABLE IF NOT EXISTS registrations (
  id SERIAL PRIMARY KEY,
  invite_id INT REFERENCES email_invites(id),
  company VARCHAR(50) NOT NULL CHECK (company IN ('ourfilms', 'framebyframe')),
  type VARCHAR(10) NOT NULL CHECK (type IN ('solista', 'gruppo')),
  group_name VARCHAR(255),
  contact_name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  song_1 VARCHAR(500) NOT NULL,
  song_1_artist VARCHAR(500),
  song_2 VARCHAR(500) NOT NULL,
  song_2_artist VARCHAR(500),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revision', 'rejected')),
  admin_notes TEXT,
  revision_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Membri del gruppo
CREATE TABLE IF NOT EXISTS group_members (
  id SERIAL PRIMARY KEY,
  registration_id INT REFERENCES registrations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255)
);

-- Log eventi email (webhook Resend)
CREATE TABLE IF NOT EXISTS email_events (
  id SERIAL PRIMARY KEY,
  resend_message_id VARCHAR(255),
  event_type VARCHAR(50) NOT NULL,
  email VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log email di risposta inviate dall'admin
CREATE TABLE IF NOT EXISTS admin_emails (
  id SERIAL PRIMARY KEY,
  registration_id INT REFERENCES registrations(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('accepted', 'revision', 'rejected')),
  message TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  resend_message_id VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_email_invites_token ON email_invites(token);
CREATE INDEX IF NOT EXISTS idx_email_invites_email ON email_invites(email);
CREATE INDEX IF NOT EXISTS idx_registrations_company ON registrations(company);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_email_events_message_id ON email_events(resend_message_id);
`;

async function init() {
  try {
    await pool.query(schema);
    console.log('✅ Database schema created successfully');
  } catch (err) {
    console.error('❌ Error creating schema:', err.message);
  } finally {
    await pool.end();
  }
}

init();
