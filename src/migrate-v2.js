require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const migration = `
-- Add first_name / last_name columns to registrations
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS contact_first_name VARCHAR(255);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS contact_last_name VARCHAR(255);

-- Backfill existing rows (split contact_name on first space)
UPDATE registrations
SET contact_first_name = split_part(contact_name, ' ', 1),
    contact_last_name = CASE
      WHEN position(' ' in contact_name) > 0 THEN substring(contact_name from position(' ' in contact_name) + 1)
      ELSE ''
    END
WHERE contact_first_name IS NULL;
`;

async function run() {
  try {
    await pool.query(migration);
    console.log('✅ Migration v2 completed — first/last name columns added');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    await pool.end();
  }
}

run();
