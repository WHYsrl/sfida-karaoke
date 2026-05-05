const express = require('express');
const router = express.Router();
const pool = require('../db');
const { Resend } = require('resend');

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// ========== GET invite info by token ==========
router.get('/invite/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, company FROM email_invites WHERE token = $1',
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invito non trovato' });

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

// ========== CHECK EMAIL before registration ==========
router.post('/check-email', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });

    // 1. Check if already a candidate (contact_email)
    const asCandidate = await pool.query(
      `SELECT r.id, r.type, r.contact_name, r.group_name, r.status
       FROM registrations r
       WHERE LOWER(r.contact_email) = $1`,
      [email]
    );
    if (asCandidate.rows.length > 0) {
      const reg = asCandidate.rows[0];
      return res.json({
        conflict: 'candidate',
        message: 'Hai gia inviato una candidatura.',
        registration: {
          id: reg.id,
          type: reg.type,
          name: reg.contact_name,
          group_name: reg.group_name,
          status: reg.status
        }
      });
    }

    // 2. Check if listed as group member in someone else's candidacy
    const asMember = await pool.query(
      `SELECT gm.name as member_name, r.id as registration_id, r.contact_name, r.group_name, r.company
       FROM group_members gm
       JOIN registrations r ON r.id = gm.registration_id
       WHERE LOWER(gm.email) = $1`,
      [email]
    );
    if (asMember.rows.length > 0) {
      const m = asMember.rows[0];
      const companyLabel = m.company === 'ourfilms' ? 'Our Films' : 'Frame by Frame';
      return res.json({
        conflict: 'member',
        message: `Il tuo nome risulta gia inserito nel gruppo "${m.group_name}" di ${m.contact_name} (${companyLabel}).`,
        detail: {
          group_name: m.group_name,
          candidate_name: m.contact_name,
          company: m.company
        }
      });
    }

    // No conflicts
    res.json({ conflict: null });
  } catch (err) {
    console.error('Check email error:', err);
    res.status(500).json({ error: 'Errore interno' });
  }
});

// ========== CHECK SONG DUPLICATE ==========
router.post('/check-song', async (req, res) => {
  try {
    const song = (req.body.song || '').trim().toLowerCase();
    if (!song) return res.json({ duplicate: false });

    const { rows } = await pool.query(`
      SELECT r.contact_name, r.group_name, r.type, r.company,
        CASE WHEN LOWER(TRIM(r.song_1)) = $1 THEN 1 ELSE 2 END as song_num
      FROM registrations r
      WHERE LOWER(TRIM(r.song_1)) = $1 OR LOWER(TRIM(r.song_2)) = $1
    `, [song]);

    if (rows.length > 0) {
      return res.json({
        duplicate: true,
        matches: rows.map(r => ({
          name: r.type === 'gruppo' ? r.group_name : r.contact_name,
          company: r.company === 'ourfilms' ? 'Our Films' : 'Frame by Frame',
          type: r.type,
        }))
      });
    }

    res.json({ duplicate: false });
  } catch (err) {
    console.error('Check song error:', err);
    res.json({ duplicate: false });
  }
});

// ========== REQUEST OTP to edit existing candidacy ==========
router.post('/request-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });

    // Find existing registration
    const { rows } = await pool.query(
      'SELECT id FROM registrations WHERE LOWER(contact_email) = $1',
      [email]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Nessuna candidatura trovata per questa email' });
    }
    const registrationId = rows[0].id;

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Save OTP
    await pool.query(
      `INSERT INTO otp_codes (email, code, registration_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [email, code, registrationId]
    );

    // Send OTP via email
    const resend = getResend();
    if (resend) {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
        to: [email],
        subject: 'Il tuo codice di verifica — Sfida Karaoke',
        html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; background: #0c0c0e; color: #e8e6e1; border-radius: 12px; overflow: hidden;">
          <div style="background: #c9a84c; padding: 24px; text-align: center;">
            <h1 style="margin: 0; font-size: 20px; color: #0c0c0e; font-weight: 600;">Sfida Karaoke</h1>
          </div>
          <div style="padding: 32px;">
            <p style="color: #9a9890; font-size: 14px;">Usa questo codice per accedere alla tua candidatura:</p>
            <div style="text-align: center; margin: 24px 0;">
              <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #c9a84c;">${code}</span>
            </div>
            <p style="color: #5a5850; font-size: 12px; text-align: center;">Il codice scade tra 10 minuti.</p>
          </div>
        </div>`
      });
    }

    res.json({ success: true, message: 'Codice inviato alla tua email' });
  } catch (err) {
    console.error('OTP request error:', err);
    res.status(500).json({ error: 'Errore nell\'invio del codice' });
  }
});

// ========== VERIFY OTP and return existing registration data ==========
router.post('/verify-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();

    if (!email || !code) return res.status(400).json({ error: 'Email e codice sono obbligatori' });

    // Find valid OTP
    const { rows: otpRows } = await pool.query(
      `SELECT id, registration_id FROM otp_codes
       WHERE email = $1 AND code = $2 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email, code]
    );
    if (otpRows.length === 0) {
      return res.status(400).json({ error: 'Codice non valido o scaduto' });
    }

    const otpId = otpRows[0].id;
    const registrationId = otpRows[0].registration_id;

    // Mark OTP as used
    await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [otpId]);

    // Fetch full registration data
    const { rows: regRows } = await pool.query(
      `SELECT r.*,
        COALESCE(json_agg(json_build_object('id', gm.id, 'name', gm.name, 'email', gm.email))
          FILTER (WHERE gm.id IS NOT NULL), '[]') as members
       FROM registrations r
       LEFT JOIN group_members gm ON gm.registration_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [registrationId]
    );

    if (regRows.length === 0) {
      return res.status(404).json({ error: 'Candidatura non trovata' });
    }

    res.json({ success: true, registration: regRows[0] });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Errore nella verifica' });
  }
});

// ========== UPDATE existing registration (after OTP verification) ==========
router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const regId = req.params.id;
    const {
      otp_email, company, type, group_name,
      contact_first_name, contact_last_name, contact_email,
      song_1, song_1_artist, song_2, song_2_artist,
      members
    } = req.body;

    // Verify the requester has a recently used OTP for this registration
    const { rows: otpCheck } = await pool.query(
      `SELECT id FROM otp_codes
       WHERE email = $1 AND registration_id = $2 AND used_at IS NOT NULL
         AND used_at > NOW() - INTERVAL '30 minutes'
       ORDER BY used_at DESC LIMIT 1`,
      [(otp_email || '').trim().toLowerCase(), regId]
    );
    if (otpCheck.length === 0) {
      return res.status(403).json({ error: 'Sessione scaduta. Richiedi un nuovo codice.' });
    }

    const firstName = (contact_first_name || '').trim();
    const lastName = (contact_last_name || '').trim();
    const fullName = `${firstName} ${lastName}`.trim();

    await client.query('BEGIN');

    // Update registration
    await client.query(
      `UPDATE registrations SET
        company = $1, type = $2, group_name = $3,
        contact_first_name = $4, contact_last_name = $5, contact_name = $6, contact_email = $7,
        song_1 = $8, song_1_artist = $9, song_2 = $10, song_2_artist = $11,
        status = 'pending', updated_at = NOW()
       WHERE id = $12`,
      [company, type, group_name || null, firstName, lastName, fullName, contact_email,
       song_1, song_1_artist || null, song_2, song_2_artist || null, regId]
    );

    // Replace group members
    await client.query('DELETE FROM group_members WHERE registration_id = $1', [regId]);
    if (type === 'gruppo' && members && members.length > 0) {
      for (const member of members) {
        await client.query(
          'INSERT INTO group_members (registration_id, name, email) VALUES ($1, $2, $3)',
          [regId, member.name, member.email || null]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Candidatura aggiornata. Sara rivalutata dal team.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update registration error:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento' });
  } finally {
    client.release();
  }
});

// ========== POST new registration ==========
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      token, company, type, group_name,
      contact_first_name, contact_last_name, contact_name, contact_email,
      song_1, song_1_artist, song_2, song_2_artist,
      members
    } = req.body;

    const firstName = (contact_first_name || '').trim();
    const lastName = (contact_last_name || '').trim();
    const fullName = contact_name || `${firstName} ${lastName}`.trim();
    const emailLower = (contact_email || '').trim().toLowerCase();

    // Validation
    if (!company || !['ourfilms', 'framebyframe'].includes(company)) {
      return res.status(400).json({ error: 'Societa non valida' });
    }
    if (!type || !['solista', 'gruppo', 'pubblico'].includes(type)) {
      return res.status(400).json({ error: 'Tipo partecipazione non valido' });
    }

    // Check if solista/gruppo candidatures are blocked
    if (type !== 'pubblico') {
      try {
        const { rows: settingsRows } = await pool.query(
          "SELECT value FROM app_settings WHERE key = 'candidature_blocked'"
        );
        if (settingsRows.length > 0 && settingsRows[0].value === 'true') {
          return res.status(403).json({ error: 'Le candidature come solista e gruppo sono chiuse. Puoi ancora registrarti come pubblico.' });
        }
      } catch (e) { /* table might not exist yet, allow */ }
    }
    if (!firstName || !lastName || !contact_email) {
      return res.status(400).json({ error: 'Nome, cognome e email sono obbligatori' });
    }
    if (type !== 'pubblico' && (!song_1 || !song_2)) {
      return res.status(400).json({ error: 'Devi indicare 2 canzoni' });
    }
    if (type === 'gruppo' && (!members || members.length === 0)) {
      return res.status(400).json({ error: 'Un gruppo deve avere almeno un altro membro oltre al contatto' });
    }
    if (type === 'gruppo' && !group_name) {
      return res.status(400).json({ error: 'Il nome del gruppo e obbligatorio' });
    }

    // Double-check for duplicate email (in case frontend check was bypassed)
    const dupCheck = await pool.query(
      'SELECT id FROM registrations WHERE LOWER(contact_email) = $1', [emailLower]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Esiste gia una candidatura con questa email. Usa la funzione di modifica.' });
    }

    await client.query('BEGIN');

    let invite_id = null;
    if (token) {
      const inv = await client.query('SELECT id FROM email_invites WHERE token = $1', [token]);
      if (inv.rows.length > 0) invite_id = inv.rows[0].id;
    }

    const regResult = await client.query(
      `INSERT INTO registrations (invite_id, company, type, group_name, contact_first_name, contact_last_name, contact_name, contact_email, song_1, song_1_artist, song_2, song_2_artist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [invite_id, company, type, group_name || null, firstName, lastName, fullName, contact_email, song_1 || null, song_1_artist || null, song_2 || null, song_2_artist || null]
    );
    const registrationId = regResult.rows[0].id;

    if (type === 'gruppo' && members && members.length > 0) {
      for (const member of members) {
        await client.query(
          'INSERT INTO group_members (registration_id, name, email) VALUES ($1, $2, $3)',
          [registrationId, member.name, member.email || null]
        );
      }
    }

    await client.query('COMMIT');

    // Send confirmation emails (non-blocking — don't fail the registration if email fails)
    try {
      const resend = getResend();
      if (resend) {
        const companyLabel = company === 'ourfilms' ? 'Our Films' : 'Frame by Frame';
        const participant = type === 'gruppo' ? `gruppo "${group_name}"` : (type === 'pubblico' ? 'pubblico' : fullName);

        // Email to the contact/soloist/pubblico
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
          to: [contact_email],
          subject: type === 'pubblico' ? '🎤 Registrazione Confermata — Sfida Karaoke' : '🎤 Candidatura Ricevuta — Sfida Karaoke',
          html: type === 'pubblico'
            ? buildPubblicoConfirmationEmail(fullName, companyLabel)
            : buildConfirmationEmail(fullName, participant, companyLabel, song_1, song_1_artist, song_2, song_2_artist, type === 'gruppo' ? members : null),
        });

        // If group, email each member who has an email
        if (type === 'gruppo' && members && members.length > 0) {
          for (const member of members) {
            if (member.email) {
              try {
                await resend.emails.send({
                  from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
                  to: [member.email],
                  subject: '🎤 Candidatura Ricevuta — Sfida Karaoke',
                  html: buildMemberConfirmationEmail(member.name, group_name, fullName, companyLabel, song_1, song_1_artist, song_2, song_2_artist),
                });
              } catch (memberEmailErr) {
                console.error(`Error sending confirmation to member ${member.email}:`, memberEmailErr.message);
              }
            }
          }
        }
      }
    } catch (emailErr) {
      console.error('Error sending confirmation email:', emailErr.message);
    }

    res.status(201).json({ success: true, registrationId, message: 'Candidatura inviata! Riceverai una email con l\'esito della valutazione.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  } finally {
    client.release();
  }
});

const REGOLAMENTO_URL = process.env.REGOLAMENTO_PDF_URL || 'https://sfida-karaoke.onrender.com/docs/regolamento.pdf';

// ========== EMAIL TEMPLATE: Confirmation for contact/soloist ==========
function buildConfirmationEmail(name, participant, companyLabel, song1, song1Artist, song2, song2Artist, members) {
  const membersHtml = members && members.length > 0
    ? `<div style="margin-top:12px;">
        <p style="color:#999;margin:0 0 6px;font-size:13px;">Membri del gruppo:</p>
        ${members.map(m => `<p style="color:#ccc;margin:2px 0;font-size:13px;">→ ${m.name}${m.email ? ` (${m.email})` : ''}</p>`).join('')}
      </div>`
    : '';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;background:#0c0c0e;color:#e8e6e1;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#b8860b,#c9a84c,#b8860b);padding:28px;text-align:center;">
      <h1 style="margin:0;font-size:22px;color:#0c0c0e;font-weight:700;">🎤 SFIDA KARAOKE</h1>
      <p style="margin:6px 0 0;color:#0c0c0e;font-size:14px;">Our Films vs Frame by Frame</p>
    </div>
    <div style="padding:28px;">
      <div style="background:rgba(34,197,94,0.1);border-left:4px solid #22c55e;padding:14px;border-radius:0 8px 8px 0;margin-bottom:20px;">
        <h2 style="margin:0;color:#22c55e;font-size:18px;">Candidatura Ricevuta!</h2>
      </div>
      <p style="color:#ccc;line-height:1.6;">Ciao <strong style="color:#c9a84c;">${name}</strong>,</p>
      <p style="color:#ccc;line-height:1.6;">Abbiamo ricevuto la tua candidatura come <strong>${participant}</strong> per il team <strong style="color:#c9a84c;">${companyLabel}</strong>.</p>
      <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="color:#999;margin:0 0 8px;font-size:13px;">Le tue canzoni:</p>
        <p style="color:#c9a84c;margin:0;">🎵 ${song1}${song1Artist ? ` — ${song1Artist}` : ''}</p>
        <p style="color:#c9a84c;margin:6px 0 0;">🎵 ${song2}${song2Artist ? ` — ${song2Artist}` : ''}</p>
        ${membersHtml}
      </div>
      <p style="color:#ccc;line-height:1.6;">La tua candidatura sarà valutata dal team organizzativo. Riceverai una email con l'esito.</p>
      <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">📅 Giovedì 7 Maggio 2026</p>
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">🕗 Ore 19:30 — 24:00</p>
        <p style="color:#c9a84c;margin:0;font-weight:600;">📍 Jackie'O — Via Boncompagni 11, Roma</p>
      </div>
      <p style="color:#ccc;line-height:1.6;">📄 <a href="${REGOLAMENTO_URL}" style="color:#c9a84c;">Consulta il regolamento della serata</a></p>
    </div>
    <div style="padding:16px;text-align:center;border-top:1px solid #222;">
      <p style="color:#666;font-size:12px;margin:0;">Sfida Karaoke 2026 — Jackie'O, Via Boncompagni 11, Roma</p>
    </div>
  </div>`;
}

// ========== EMAIL TEMPLATE: Confirmation for group member ==========
function buildMemberConfirmationEmail(memberName, groupName, contactName, companyLabel, song1, song1Artist, song2, song2Artist) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;background:#0c0c0e;color:#e8e6e1;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#b8860b,#c9a84c,#b8860b);padding:28px;text-align:center;">
      <h1 style="margin:0;font-size:22px;color:#0c0c0e;font-weight:700;">🎤 SFIDA KARAOKE</h1>
      <p style="margin:6px 0 0;color:#0c0c0e;font-size:14px;">Our Films vs Frame by Frame</p>
    </div>
    <div style="padding:28px;">
      <div style="background:rgba(34,197,94,0.1);border-left:4px solid #22c55e;padding:14px;border-radius:0 8px 8px 0;margin-bottom:20px;">
        <h2 style="margin:0;color:#22c55e;font-size:18px;">Sei nel gruppo!</h2>
      </div>
      <p style="color:#ccc;line-height:1.6;">Ciao <strong style="color:#c9a84c;">${memberName}</strong>,</p>
      <p style="color:#ccc;line-height:1.6;"><strong>${contactName}</strong> ti ha inserito nel gruppo <strong style="color:#c9a84c;">"${groupName}"</strong> per la Sfida Karaoke, team <strong style="color:#c9a84c;">${companyLabel}</strong>.</p>
      <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="color:#999;margin:0 0 8px;font-size:13px;">Le canzoni scelte dal gruppo:</p>
        <p style="color:#c9a84c;margin:0;">🎵 ${song1}${song1Artist ? ` — ${song1Artist}` : ''}</p>
        <p style="color:#c9a84c;margin:6px 0 0;">🎵 ${song2}${song2Artist ? ` — ${song2Artist}` : ''}</p>
      </div>
      <p style="color:#ccc;line-height:1.6;">La candidatura sarà valutata dal team organizzativo. Riceverete una comunicazione con l'esito.</p>
      <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">📅 Giovedì 7 Maggio 2026</p>
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">🕗 Ore 19:30 — 24:00</p>
        <p style="color:#c9a84c;margin:0;font-weight:600;">📍 Jackie'O — Via Boncompagni 11, Roma</p>
      </div>
      <p style="color:#ccc;line-height:1.6;">📄 <a href="${REGOLAMENTO_URL}" style="color:#c9a84c;">Consulta il regolamento della serata</a></p>
    </div>
    <div style="padding:16px;text-align:center;border-top:1px solid #222;">
      <p style="color:#666;font-size:12px;margin:0;">Sfida Karaoke 2026 — Jackie'O, Via Boncompagni 11, Roma</p>
    </div>
  </div>`;
}

// ========== EMAIL TEMPLATE: Confirmation for pubblico ==========
function buildPubblicoConfirmationEmail(name, companyLabel) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;background:#0c0c0e;color:#e8e6e1;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#b8860b,#c9a84c,#b8860b);padding:28px;text-align:center;">
      <h1 style="margin:0;font-size:22px;color:#0c0c0e;font-weight:700;">🎤 SFIDA KARAOKE</h1>
      <p style="margin:6px 0 0;color:#0c0c0e;font-size:14px;">Our Films vs Frame by Frame</p>
    </div>
    <div style="padding:28px;">
      <div style="background:rgba(34,197,94,0.1);border-left:4px solid #22c55e;padding:14px;border-radius:0 8px 8px 0;margin-bottom:20px;">
        <h2 style="margin:0;color:#22c55e;font-size:18px;">Registrazione Confermata!</h2>
      </div>
      <p style="color:#ccc;line-height:1.6;">Ciao <strong style="color:#c9a84c;">${name}</strong>,</p>
      <p style="color:#ccc;line-height:1.6;">La tua registrazione come <strong>pubblico</strong> per il team <strong style="color:#c9a84c;">${companyLabel}</strong> è confermata. Ti aspettiamo per tifare e divertirti!</p>
      <div style="background:#1a1a1a;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">📅 Giovedì 7 Maggio 2026</p>
        <p style="color:#c9a84c;margin:0 0 6px;font-weight:600;">🕗 Ore 19:30 — 24:00</p>
        <p style="color:#c9a84c;margin:0;font-weight:600;">📍 Jackie'O — Via Boncompagni 11, Roma</p>
      </div>
      <p style="color:#ccc;line-height:1.6;">📄 <a href="${REGOLAMENTO_URL}" style="color:#c9a84c;">Consulta il regolamento della serata</a></p>
    </div>
    <div style="padding:16px;text-align:center;border-top:1px solid #222;">
      <p style="color:#666;font-size:12px;margin:0;">Sfida Karaoke 2026 — Jackie'O, Via Boncompagni 11, Roma</p>
    </div>
  </div>`;
}

module.exports = router;
