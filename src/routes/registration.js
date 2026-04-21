const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET invite info by token
router.get('/invite/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, company FROM email_invites WHERE token = $1',
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invito non trovato' });

    // Check if already registered
    const existing = await pool.query(
      'SELECT id, status FROM registrations WHERE invite_id = $1',
      [rows[0].id]
    );
    res.json({
      invite: rows[0],
      existingRegistration: existing.rows[0] || null
    });
  } catch (err) {
    console.error('Error fetching invite:', err);
    res.status(500).json({ error: 'Errore interno' });
  }
});

// POST new registration
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      token, company, type, group_name,
      contact_name, contact_email,
      song_1, song_1_artist, song_2, song_2_artist,
      members // array of { name, email }
    } = req.body;

    // Validation
    if (!company || !['ourfilms', 'framebyframe'].includes(company)) {
      return res.status(400).json({ error: 'Società non valida' });
    }
    if (!type || !['solista', 'gruppo'].includes(type)) {
      return res.status(400).json({ error: 'Tipo partecipazione non valido' });
    }
    if (!contact_name || !contact_email) {
      return res.status(400).json({ error: 'Nome e email del contatto sono obbligatori' });
    }
    if (!song_1 || !song_2) {
      return res.status(400).json({ error: 'Devi indicare 2 canzoni' });
    }
    if (type === 'gruppo' && (!members || members.length === 0)) {
      return res.status(400).json({ error: 'Un gruppo deve avere almeno un altro membro oltre al contatto' });
    }
    if (type === 'gruppo' && !group_name) {
      return res.status(400).json({ error: 'Il nome del gruppo è obbligatorio' });
    }

    await client.query('BEGIN');

    // Find invite_id if token provided
    let invite_id = null;
    if (token) {
      const inv = await client.query('SELECT id FROM email_invites WHERE token = $1', [token]);
      if (inv.rows.length > 0) invite_id = inv.rows[0].id;
    }

    // Insert registration
    const regResult = await client.query(
      `INSERT INTO registrations (invite_id, company, type, group_name, contact_name, contact_email, song_1, song_1_artist, song_2, song_2_artist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [invite_id, company, type, group_name || null, contact_name, contact_email, song_1, song_1_artist || null, song_2, song_2_artist || null]
    );
    const registrationId = regResult.rows[0].id;

    // Insert group members
    if (type === 'gruppo' && members && members.length > 0) {
      for (const member of members) {
        await client.query(
          'INSERT INTO group_members (registration_id, name, email) VALUES ($1, $2, $3)',
          [registrationId, member.name, member.email || null]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, registrationId, message: 'Iscrizione completata! Riceverai una conferma via email.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  } finally {
    client.release();
  }
});

module.exports = router;
