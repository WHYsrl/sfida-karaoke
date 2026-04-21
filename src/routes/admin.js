const express = require('express');
const router = express.Router();
const pool = require('../db');
const { adminAuth } = require('../middleware/auth');
const { Resend } = require('resend');

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — email sending disabled');
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// All admin routes require authentication
router.use(adminAuth);

// ========== DASHBOARD STATS ==========
router.get('/stats', async (req, res) => {
  try {
    // Email stats
    const emailStats = await pool.query(`
      SELECT
        COUNT(*) as total_sent,
        COUNT(opened_at) as total_opened,
        COUNT(clicked_at) as total_clicked,
        COUNT(*) FILTER (WHERE company = 'ourfilms') as sent_ourfilms,
        COUNT(*) FILTER (WHERE company = 'framebyframe') as sent_framebyframe,
        COUNT(opened_at) FILTER (WHERE company = 'ourfilms') as opened_ourfilms,
        COUNT(opened_at) FILTER (WHERE company = 'framebyframe') as opened_framebyframe,
        COUNT(clicked_at) FILTER (WHERE company = 'ourfilms') as clicked_ourfilms,
        COUNT(clicked_at) FILTER (WHERE company = 'framebyframe') as clicked_framebyframe
      FROM email_invites
    `);

    // Registration stats
    const regStats = await pool.query(`
      SELECT
        COUNT(*) as total_registrations,
        COUNT(*) FILTER (WHERE type = 'solista') as total_solisti,
        COUNT(*) FILTER (WHERE type = 'gruppo') as total_gruppi,
        COUNT(*) FILTER (WHERE company = 'ourfilms') as reg_ourfilms,
        COUNT(*) FILTER (WHERE company = 'framebyframe') as reg_framebyframe,
        COUNT(*) FILTER (WHERE company = 'ourfilms' AND type = 'solista') as solisti_ourfilms,
        COUNT(*) FILTER (WHERE company = 'ourfilms' AND type = 'gruppo') as gruppi_ourfilms,
        COUNT(*) FILTER (WHERE company = 'framebyframe' AND type = 'solista') as solisti_framebyframe,
        COUNT(*) FILTER (WHERE company = 'framebyframe' AND type = 'gruppo') as gruppi_framebyframe,
        COUNT(*) FILTER (WHERE status = 'pending') as status_pending,
        COUNT(*) FILTER (WHERE status = 'accepted') as status_accepted,
        COUNT(*) FILTER (WHERE status = 'revision') as status_revision,
        COUNT(*) FILTER (WHERE status = 'rejected') as status_rejected
      FROM registrations
    `);

    // Total participants (solisti + members of groups + contact of groups)
    const participantCount = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM registrations WHERE type = 'solista') +
        (SELECT COUNT(*) FROM group_members) +
        (SELECT COUNT(*) FROM registrations WHERE type = 'gruppo') as total_participants
    `);

    // Average group size
    const avgGroup = await pool.query(`
      SELECT COALESCE(AVG(member_count + 1), 0) as avg_group_size FROM (
        SELECT r.id, COUNT(gm.id) as member_count
        FROM registrations r
        LEFT JOIN group_members gm ON gm.registration_id = r.id
        WHERE r.type = 'gruppo'
        GROUP BY r.id
      ) sub
    `);

    res.json({
      email: emailStats.rows[0],
      registrations: regStats.rows[0],
      totalParticipants: parseInt(participantCount.rows[0].total_participants),
      avgGroupSize: parseFloat(avgGroup.rows[0].avg_group_size).toFixed(1)
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Errore nel recupero statistiche' });
  }
});

// ========== ALL REGISTRATIONS ==========
router.get('/registrations', async (req, res) => {
  try {
    const { company, status, type } = req.query;
    let where = [];
    let params = [];
    let i = 1;

    if (company) { where.push(`r.company = $${i++}`); params.push(company); }
    if (status) { where.push(`r.status = $${i++}`); params.push(status); }
    if (type) { where.push(`r.type = $${i++}`); params.push(type); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT r.*,
        COALESCE(json_agg(json_build_object('id', gm.id, 'name', gm.name, 'email', gm.email))
          FILTER (WHERE gm.id IS NOT NULL), '[]') as members
      FROM registrations r
      LEFT JOIN group_members gm ON gm.registration_id = r.id
      ${whereClause}
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error('Registrations fetch error:', err);
    res.status(500).json({ error: 'Errore nel recupero registrazioni' });
  }
});

// ========== DUPLICATE SONGS ALERT ==========
router.get('/duplicate-songs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH all_songs AS (
        SELECT id, company, contact_name, group_name, type, LOWER(TRIM(song_1)) as song, song_1_artist as artist, 1 as song_num FROM registrations
        UNION ALL
        SELECT id, company, contact_name, group_name, type, LOWER(TRIM(song_2)) as song, song_2_artist as artist, 2 as song_num FROM registrations
      )
      SELECT song, artist, json_agg(json_build_object(
        'registration_id', id, 'company', company, 'contact_name', contact_name,
        'group_name', group_name, 'type', type, 'song_num', song_num
      )) as participants, COUNT(*) as count
      FROM all_songs
      GROUP BY song, artist
      HAVING COUNT(*) > 1
      ORDER BY count DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Duplicate songs error:', err);
    res.status(500).json({ error: 'Errore nel controllo duplicati' });
  }
});

// ========== ALL SONGS LIST ==========
router.get('/songs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.company, r.type, r.contact_name, r.group_name, r.status,
        r.song_1, r.song_1_artist, r.song_2, r.song_2_artist
      FROM registrations r
      ORDER BY r.company, r.contact_name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Songs error:', err);
    res.status(500).json({ error: 'Errore nel recupero canzoni' });
  }
});

// ========== UPDATE REGISTRATION STATUS + SEND EMAIL ==========
router.put('/registrations/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, message } = req.body;

  if (!['accepted', 'revision', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Stato non valido' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update status
    const updateFields = status === 'revision'
      ? 'status = $1, revision_message = $2, updated_at = NOW()'
      : 'status = $1, admin_notes = $2, updated_at = NOW()';

    const { rows } = await client.query(
      `UPDATE registrations SET ${updateFields} WHERE id = $3 RETURNING *`,
      [status, message || null, id]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Registrazione non trovata' });
    }

    const reg = rows[0];

    // Send email notification
    const emailContent = buildStatusEmail(reg, status, message);
    let resendMessageId = null;

    try {
      const resend = getResend();
      if (resend) {
        const emailResult = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
          to: [reg.contact_email],
          subject: emailContent.subject,
          html: emailContent.html,
        });
        resendMessageId = emailResult.data?.id || null;
      }
    } catch (emailErr) {
      console.error('Error sending status email:', emailErr);
      // Don't fail the whole operation if email fails
    }

    // Log admin email
    await client.query(
      'INSERT INTO admin_emails (registration_id, type, message, resend_message_id) VALUES ($1, $2, $3, $4)',
      [id, status, message || null, resendMessageId]
    );

    await client.query('COMMIT');
    res.json({ success: true, registration: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento dello stato' });
  } finally {
    client.release();
  }
});

// ========== SEND BULK INVITES ==========
router.post('/send-invites', async (req, res) => {
  const { recipients } = req.body; // array of { name, email, company }

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'Lista destinatari vuota' });
  }

  const results = { sent: 0, errors: 0, details: [] };
  const { v4: uuidv4 } = require('uuid');

  for (const r of recipients) {
    try {
      const token = uuidv4();
      const appUrl = process.env.APP_URL || 'http://localhost:3000';

      // Insert invite record
      await pool.query(
        'INSERT INTO email_invites (email, name, company, token) VALUES ($1, $2, $3, $4)',
        [r.email, r.name, r.company, token]
      );

      // Send email via Resend
      const resend = getResend();
      if (!resend) throw new Error('RESEND_API_KEY not configured');
      const emailResult = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
        to: [r.email],
        subject: '🎤 Sfida Karaoke — Our Films vs Frame by Frame — Sei dei nostri?',
        html: buildInviteEmail(r.name, r.company, token, appUrl),
      });

      // Update with resend message ID
      if (emailResult.data?.id) {
        await pool.query(
          'UPDATE email_invites SET resend_message_id = $1 WHERE token = $2',
          [emailResult.data.id, token]
        );
      }

      results.sent++;
      results.details.push({ email: r.email, status: 'sent' });
    } catch (err) {
      results.errors++;
      results.details.push({ email: r.email, status: 'error', error: err.message });
    }
  }

  res.json(results);
});

// ========== EMAIL TRACKING DATA ==========
router.get('/email-tracking', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ei.*,
        EXISTS(SELECT 1 FROM registrations r WHERE r.invite_id = ei.id) as has_registered
      FROM email_invites ei
      ORDER BY ei.sent_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Email tracking error:', err);
    res.status(500).json({ error: 'Errore nel recupero dati tracking' });
  }
});

// ========== EMAIL TEMPLATE BUILDERS ==========
function buildStatusEmail(reg, status, message) {
  const participant = reg.type === 'gruppo' ? `gruppo "${reg.group_name}"` : reg.contact_name;
  const statusLabels = {
    accepted: { subject: '✅ Iscrizione Accettata — Sfida Karaoke', color: '#22c55e', title: 'Iscrizione Accettata!' },
    revision: { subject: '📝 Richiesta Revisione — Sfida Karaoke', color: '#f59e0b', title: 'Revisione Richiesta' },
    rejected: { subject: '❌ Iscrizione Non Accettata — Sfida Karaoke', color: '#ef4444', title: 'Iscrizione Non Accettata' },
  };
  const s = statusLabels[status];

  return {
    subject: s.subject,
    html: `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #fff; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #b8860b, #daa520, #b8860b); padding: 30px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px; color: #0a0a0a;">🎤 SFIDA KARAOKE</h1>
        <p style="margin: 5px 0 0; color: #0a0a0a; font-size: 14px;">Our Films vs Frame by Frame</p>
      </div>
      <div style="padding: 30px;">
        <div style="background: ${s.color}20; border-left: 4px solid ${s.color}; padding: 15px; border-radius: 0 8px 8px 0; margin-bottom: 20px;">
          <h2 style="margin: 0; color: ${s.color};">${s.title}</h2>
        </div>
        <p style="color: #ccc; line-height: 1.6;">Ciao <strong style="color: #daa520;">${reg.contact_name}</strong>,</p>
        <p style="color: #ccc; line-height: 1.6;">La tua iscrizione come <strong>${participant}</strong> per la Sfida Karaoke è stata esaminata.</p>
        ${message ? `<div style="background: #1a1a1a; padding: 15px; border-radius: 8px; margin: 15px 0;"><p style="color: #ccc; margin: 0; line-height: 1.6;"><strong>Messaggio:</strong> ${message}</p></div>` : ''}
        <div style="background: #1a1a1a; padding: 15px; border-radius: 8px; margin: 15px 0;">
          <p style="color: #999; margin: 0 0 5px; font-size: 13px;">Le tue canzoni:</p>
          <p style="color: #daa520; margin: 0;">🎵 ${reg.song_1}${reg.song_1_artist ? ` — ${reg.song_1_artist}` : ''}</p>
          <p style="color: #daa520; margin: 5px 0 0;">🎵 ${reg.song_2}${reg.song_2_artist ? ` — ${reg.song_2_artist}` : ''}</p>
        </div>
        ${status === 'accepted' ? '<p style="color: #ccc; line-height: 1.6;">Ci vediamo il <strong style="color: #daa520;">7 maggio alle 20:00</strong> al <strong style="color: #daa520;">Jackie\'O</strong>, Via Boncompagni 11, Roma! 🎉</p>' : ''}
        ${status === 'revision' ? '<p style="color: #ccc; line-height: 1.6;">Ti preghiamo di rivedere la tua iscrizione e riprovare. Se hai domande, rispondi a questa email.</p>' : ''}
      </div>
      <div style="padding: 20px; text-align: center; border-top: 1px solid #222;">
        <p style="color: #666; font-size: 12px; margin: 0;">Sfida Karaoke 2026 — Jackie\'O, Via Boncompagni 11, Roma</p>
      </div>
    </div>`
  };
}

function buildInviteEmail(name, company, token, appUrl) {
  const companyName = company === 'ourfilms' ? 'Our Films' : 'Frame by Frame';
  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #fff; border-radius: 12px; overflow: hidden;">
    <div style="background: linear-gradient(135deg, #b8860b, #daa520, #b8860b); padding: 30px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px; color: #0a0a0a;">🎤 SFIDA KARAOKE</h1>
      <p style="margin: 8px 0 0; color: #0a0a0a; font-size: 16px; font-weight: bold;">Our Films vs Frame by Frame</p>
    </div>
    <div style="padding: 30px;">
      <p style="color: #ccc; line-height: 1.6; font-size: 16px;">Ciao <strong style="color: #daa520;">${name}</strong>!</p>
      <p style="color: #ccc; line-height: 1.6;">Sei invitato/a alla grande <strong style="color: #daa520;">Sfida Karaoke</strong> tra <strong>Our Films</strong> e <strong>Frame by Frame</strong>!</p>
      <div style="background: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="color: #daa520; margin: 0 0 8px; font-weight: bold;">📅 Giovedì 7 Maggio 2026</p>
        <p style="color: #daa520; margin: 0 0 8px; font-weight: bold;">🕗 Ore 20:00 — 24:00</p>
        <p style="color: #daa520; margin: 0; font-weight: bold;">📍 Jackie'O — Via Boncompagni 11, Roma</p>
      </div>
      <p style="color: #ccc; line-height: 1.6;">Partecipa come <strong>solista</strong> o in <strong>gruppo</strong> (con colleghi di ${companyName}). Scegli 2 canzoni e preparati a dare il massimo!</p>
      <div style="text-align: center; margin: 25px 0;">
        <a href="${appUrl}/r/${token}" style="display: inline-block; background: linear-gradient(135deg, #b8860b, #daa520); color: #0a0a0a; text-decoration: none; padding: 14px 40px; border-radius: 8px; font-weight: bold; font-size: 16px;">ISCRIVITI ORA</a>
      </div>
      <p style="color: #999; text-align: center; font-size: 13px;">La sfida è aperta — fai vincere ${companyName}! 🏆</p>
    </div>
    <div style="padding: 20px; text-align: center; border-top: 1px solid #222;">
      <p style="color: #666; font-size: 12px; margin: 0;">Sfida Karaoke 2026 — Jackie'O, Via Boncompagni 11, Roma</p>
    </div>
    <img src="${appUrl}/px/${token}" width="1" height="1" style="display:none;" alt="" />
  </div>`;
}

module.exports = router;
