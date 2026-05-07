const express = require('express');
const router = express.Router();
const pool = require('../db');
const { Resend } = require('resend');
const { v4: uuidv4 } = require('uuid');
const { adminAuth } = require('../middleware/auth');

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// ========== SSE: Server-Sent Events for real-time updates ==========
const sseClients = new Set();

router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // for nginx/render proxy
  });
  res.write(':\n\n'); // comment to keep connection alive

  const client = { res };
  sseClients.add(client);

  // Keep-alive ping every 25s
  const keepAlive = setInterval(() => { res.write(':\n\n'); }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
});

function broadcast(event = 'update', data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// ========== VOTER AUTH: Quick login (no OTP) ==========
router.post('/quick-login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email non valida' });

    // Create voter token directly (valid 24h)
    const token = uuidv4();
    await pool.query(
      `INSERT INTO voter_tokens (email, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [email, token]
    );

    res.json({ success: true, token, email });
  } catch (err) {
    console.error('Quick login error:', err);
    res.status(500).json({ error: 'Errore nel login' });
  }
});

// ========== VOTER AUTH: Request OTP (legacy, kept for compatibility) ==========
router.post('/auth', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });

    // Check the voter is a registered participant (contact or group member)
    const { rows: asContact } = await pool.query(
      "SELECT id FROM registrations WHERE LOWER(contact_email) = $1 AND status = 'accepted'", [email]
    );
    const { rows: asMember } = await pool.query(
      `SELECT gm.id FROM group_members gm
       JOIN registrations r ON r.id = gm.registration_id
       WHERE LOWER(gm.email) = $1 AND r.status = 'accepted'`, [email]
    );
    // Also check pubblico
    const { rows: asPubblico } = await pool.query(
      "SELECT id FROM registrations WHERE LOWER(contact_email) = $1 AND type = 'pubblico'", [email]
    );

    if (asContact.length === 0 && asMember.length === 0 && asPubblico.length === 0) {
      return res.status(404).json({ error: 'Nessuna registrazione trovata per questa email. Devi essere registrato per votare.' });
    }

    // Generate 6-digit OTP
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await pool.query(
      `INSERT INTO otp_codes (email, code, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
      [email, code]
    );

    // Send OTP via email
    const resend = getResend();
    if (resend) {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'Sfida Karaoke <karaoke@yourdomain.com>',
        to: [email],
        subject: 'Il tuo codice per votare — Sfida Karaoke',
        html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:0 auto;background:#0c0c0e;color:#e8e6e1;border-radius:12px;overflow:hidden;">
          <div style="background:#c9a84c;padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:20px;color:#0c0c0e;font-weight:600;">Sfida Karaoke — Vota!</h1>
          </div>
          <div style="padding:32px;">
            <p style="color:#9a9890;font-size:14px;">Usa questo codice per accedere al voto:</p>
            <div style="text-align:center;margin:24px 0;">
              <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#c9a84c;">${code}</span>
            </div>
            <p style="color:#5a5850;font-size:12px;text-align:center;">Il codice scade tra 30 minuti.</p>
          </div>
        </div>`
      });
    }

    res.json({ success: true, message: 'Codice inviato alla tua email' });
  } catch (err) {
    console.error('Vote auth error:', err);
    res.status(500).json({ error: 'Errore nell\'invio del codice' });
  }
});

// ========== VOTER AUTH: Verify OTP ==========
router.post('/verify', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'Email e codice obbligatori' });

    const MASTER_OTP = process.env.MASTER_OTP || '666666';
    const isMaster = code === MASTER_OTP;

    if (!isMaster) {
      var { rows } = await pool.query(
        `SELECT id FROM otp_codes
         WHERE email = $1 AND code = $2 AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [email, code]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'Codice non valido o scaduto' });
      }
      // Mark OTP as used
      await pool.query('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [rows[0].id]);
    }

    // Create voter token (valid 24h)
    const token = uuidv4();
    await pool.query(
      `INSERT INTO voter_tokens (email, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [email, token]
    );

    // Get voter's own registration IDs (to prevent self-voting)
    const { rows: ownRegs } = await pool.query(
      "SELECT id FROM registrations WHERE LOWER(contact_email) = $1", [email]
    );
    const { rows: ownGroups } = await pool.query(
      `SELECT r.id FROM group_members gm
       JOIN registrations r ON r.id = gm.registration_id
       WHERE LOWER(gm.email) = $1`, [email]
    );
    const selfRegIds = [...new Set([
      ...ownRegs.map(r => r.id),
      ...ownGroups.map(r => r.id)
    ])];

    res.json({ success: true, token, email, selfRegIds });
  } catch (err) {
    console.error('Vote verify error:', err);
    res.status(500).json({ error: 'Errore nella verifica' });
  }
});

// ========== MIDDLEWARE: Verify voter token ==========
async function voterAuth(req, res, next) {
  const token = req.headers['x-voter-token'];
  if (!token) return res.status(401).json({ error: 'Token di voto mancante' });

  try {
    const { rows } = await pool.query(
      'SELECT email FROM voter_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Sessione scaduta. Effettua di nuovo l\'accesso.' });
    req.voterEmail = rows[0].email;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Errore di autenticazione' });
  }
}

// ========== GET performers list (for voter) ==========
router.get('/performers', voterAuth, async (req, res) => {
  try {
    const voterEmail = req.voterEmail;

    // Get all accepted registrations (solista + gruppo only, not pubblico)
    const { rows: performers } = await pool.query(`
      SELECT r.id, r.type, r.contact_name, r.contact_email, r.group_name, r.company,
        r.song_1, r.song_1_artist, r.song_2, r.song_2_artist,
        r.current_song_num, r.voting_open,
        COALESCE(json_agg(json_build_object('name', gm.name, 'email', LOWER(gm.email)))
          FILTER (WHERE gm.id IS NOT NULL), '[]') as members
      FROM registrations r
      LEFT JOIN group_members gm ON gm.registration_id = r.id
      WHERE r.status = 'accepted' AND r.type != 'pubblico'
      GROUP BY r.id
      ORDER BY r.voting_order NULLS LAST, r.created_at
    `);

    // Get voter's existing votes
    const { rows: myVotes } = await pool.query(
      'SELECT registration_id, score_preparation, score_performance FROM votes WHERE LOWER(voter_email) = $1',
      [voterEmail.toLowerCase()]
    );
    const votesMap = {};
    myVotes.forEach(v => { votesMap[v.registration_id] = v; });

    // Get voter's own registrations (for self-vote prevention)
    const { rows: ownRegs } = await pool.query(
      "SELECT id FROM registrations WHERE LOWER(contact_email) = $1", [voterEmail.toLowerCase()]
    );
    const { rows: ownGroups } = await pool.query(
      `SELECT r.id FROM group_members gm
       JOIN registrations r ON r.id = gm.registration_id
       WHERE LOWER(gm.email) = $1`, [voterEmail.toLowerCase()]
    );
    const selfRegIds = new Set([
      ...ownRegs.map(r => r.id),
      ...ownGroups.map(r => r.id)
    ]);

    const result = performers.map(p => {
      const songNum = p.current_song_num || 1;
      const currentSong = songNum === 2 ? p.song_2 : p.song_1;
      const currentArtist = songNum === 2 ? p.song_2_artist : p.song_1_artist;
      // For groups, include contact (leader) + member names
      const memberNames = p.type === 'gruppo'
        ? [p.contact_name, ...p.members.filter(m => m.name).map(m => m.name)].filter(Boolean)
        : [];

      return {
        id: p.id,
        type: p.type,
        name: p.type === 'gruppo' ? p.group_name : p.contact_name,
        company: p.company,
        song: currentSong,
        song_artist: currentArtist,
        voting_open: p.voting_open,
        is_self: selfRegIds.has(p.id),
        my_vote: votesMap[p.id] || null,
        members: memberNames,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Performers list error:', err);
    res.status(500).json({ error: 'Errore nel recupero concorrenti' });
  }
});

// ========== CAST VOTE ==========
router.post('/cast', voterAuth, async (req, res) => {
  try {
    const voterEmail = req.voterEmail.toLowerCase();
    const { registration_id, score_preparation, score_performance } = req.body;

    // Validate scores
    if (score_preparation < 0 || score_preparation > 5 || score_performance < 0 || score_performance > 5) {
      return res.status(400).json({ error: 'Il voto deve essere compreso tra 0 e 5' });
    }
    if (!Number.isInteger(score_preparation) || !Number.isInteger(score_performance)) {
      return res.status(400).json({ error: 'Il voto deve essere un numero intero' });
    }

    // Check registration exists and voting is open
    const { rows: regRows } = await pool.query(
      "SELECT id, type, contact_email, voting_open FROM registrations WHERE id = $1 AND status = 'accepted' AND type != 'pubblico'",
      [registration_id]
    );
    if (regRows.length === 0) {
      return res.status(404).json({ error: 'Concorrente non trovato' });
    }
    if (!regRows[0].voting_open) {
      return res.status(403).json({ error: 'Le votazioni per questo concorrente non sono ancora aperte' });
    }

    // Check self-voting
    if (regRows[0].contact_email.toLowerCase() === voterEmail) {
      return res.status(403).json({ error: 'Non puoi votare per te stesso' });
    }
    // Check if voter is a group member of this registration
    const { rows: memberCheck } = await pool.query(
      'SELECT id FROM group_members WHERE registration_id = $1 AND LOWER(email) = $2',
      [registration_id, voterEmail]
    );
    if (memberCheck.length > 0) {
      return res.status(403).json({ error: 'Non puoi votare per il tuo gruppo' });
    }

    // Check duplicate vote
    const { rows: existingVote } = await pool.query(
      'SELECT id FROM votes WHERE LOWER(voter_email) = $1 AND registration_id = $2',
      [voterEmail, registration_id]
    );
    if (existingVote.length > 0) {
      return res.status(409).json({ error: 'Hai già votato per questo concorrente. Il voto non è modificabile.' });
    }

    // Insert vote
    await pool.query(
      `INSERT INTO votes (voter_email, registration_id, score_preparation, score_performance)
       VALUES ($1, $2, $3, $4)`,
      [voterEmail, registration_id, score_preparation, score_performance]
    );

    res.json({ success: true, message: 'Voto registrato!' });
  } catch (err) {
    console.error('Cast vote error:', err);
    res.status(500).json({ error: 'Errore nella registrazione del voto' });
  }
});

// ========== PUBLIC LEADERBOARD ==========
router.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.type, r.contact_name, r.group_name, r.company, r.song_1, r.song_1_artist,
        COALESCE(SUM(v.score_preparation), 0) as total_preparation,
        COALESCE(SUM(v.score_performance), 0) as total_performance,
        COALESCE(SUM(v.score_preparation + v.score_performance), 0) as total_score,
        COUNT(v.id) as vote_count
      FROM registrations r
      LEFT JOIN votes v ON v.registration_id = r.id
      WHERE r.status = 'accepted' AND r.type != 'pubblico'
      GROUP BY r.id
      ORDER BY total_score DESC, total_performance DESC, r.contact_name
    `);

    res.json(rows.map(r => ({
      id: r.id,
      name: r.type === 'gruppo' ? r.group_name : r.contact_name,
      type: r.type,
      company: r.company,
      song: r.song_1,
      song_artist: r.song_1_artist,
      total_preparation: parseInt(r.total_preparation),
      total_performance: parseInt(r.total_performance),
      total_score: parseInt(r.total_score),
      vote_count: parseInt(r.vote_count),
    })));
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Errore nel recupero classifica' });
  }
});

// ========== ADMIN: Voting management ==========
router.get('/admin/status', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.type, r.status, r.contact_name, r.group_name, r.company,
        r.song_1, r.song_1_artist, r.song_2, r.song_2_artist,
        r.current_song_num, r.voting_open, r.voting_order,
        COALESCE(SUM(v.score_preparation), 0) as total_preparation,
        COALESCE(SUM(v.score_performance), 0) as total_performance,
        COALESCE(SUM(v.score_preparation + v.score_performance), 0) as total_score,
        COUNT(v.id) as vote_count
      FROM registrations r
      LEFT JOIN votes v ON v.registration_id = r.id
      WHERE r.type != 'pubblico'
      GROUP BY r.id
      ORDER BY r.status DESC, r.voting_order NULLS LAST, r.company, r.contact_name
    `);

    // Fetch group members for each gruppo
    const gruppoIds = rows.filter(r => r.type === 'gruppo').map(r => r.id);
    let membersMap = {};
    if (gruppoIds.length) {
      const { rows: members } = await pool.query(
        'SELECT registration_id, name, email FROM group_members WHERE registration_id = ANY($1) ORDER BY id',
        [gruppoIds]
      );
      members.forEach(m => {
        if (!membersMap[m.registration_id]) membersMap[m.registration_id] = [];
        membersMap[m.registration_id].push({ name: m.name, email: m.email });
      });
    }

    res.json({ performers: rows.map(r => ({
      id: r.id,
      name: r.type === 'gruppo' ? r.group_name : r.contact_name,
      type: r.type,
      status: r.status,
      company: r.company,
      song_1: r.song_1,
      song_1_artist: r.song_1_artist,
      song_2: r.song_2,
      song_2_artist: r.song_2_artist,
      current_song_num: r.current_song_num || 1,
      voting_open: r.voting_open,
      voting_order: r.voting_order,
      members: membersMap[r.id] || [],
      total_preparation: parseInt(r.total_preparation),
      total_performance: parseInt(r.total_performance),
      total_score: parseInt(r.total_score),
      vote_count: parseInt(r.vote_count),
    })) });
  } catch (err) {
    console.error('Admin voting status error:', err);
    res.status(500).json({ error: 'Errore nel recupero stato votazioni' });
  }
});

router.put('/admin/toggle', adminAuth, async (req, res) => {
  try {
    const { ids, open, song_num } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Nessun concorrente selezionato' });
    }
    if (open && song_num && [1, 2].includes(song_num)) {
      await pool.query(
        `UPDATE registrations SET voting_open = true, current_song_num = $1
         WHERE id = ANY($2::int[]) AND status = 'accepted' AND type != 'pubblico'`,
        [song_num, ids]
      );
    } else {
      await pool.query(
        `UPDATE registrations SET voting_open = $1
         WHERE id = ANY($2::int[]) AND status = 'accepted' AND type != 'pubblico'`,
        [!!open, ids]
      );
    }
    broadcast('voting-changed', { ids, open: !!open });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin voting toggle error:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento' });
  }
});

// Admin: update songs for a performer (last-minute changes)
router.put('/admin/songs/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { song_1, song_1_artist, song_2, song_2_artist } = req.body;
    await pool.query(
      `UPDATE registrations SET song_1 = $1, song_1_artist = $2, song_2 = $3, song_2_artist = $4, updated_at = NOW()
       WHERE id = $5 AND type != 'pubblico'`,
      [song_1 || null, song_1_artist || null, song_2 || null, song_2_artist || null, id]
    );
    broadcast('songs-changed', { id: parseInt(id) });
    res.json({ success: true });
  } catch (err) {
    console.error('Update songs error:', err);
    res.status(500).json({ error: 'Errore aggiornamento canzoni' });
  }
});

router.put('/admin/order', adminAuth, async (req, res) => {
  try {
    const { order } = req.body; // array of { id, position }
    if (!order || !Array.isArray(order)) {
      return res.status(400).json({ error: 'Ordine non valido' });
    }
    for (const item of order) {
      await pool.query(
        'UPDATE registrations SET voting_order = $1 WHERE id = $2',
        [item.position, item.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Admin voting order error:', err);
    res.status(500).json({ error: 'Errore nell\'aggiornamento ordine' });
  }
});

router.get('/admin/detailed-results', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id as registration_id,
        CASE WHEN r.type = 'gruppo' THEN r.group_name ELSE r.contact_name END as name,
        r.type, r.company,
        ROUND(AVG(v.score_preparation)::numeric, 2) as avg_preparation,
        ROUND(AVG(v.score_performance)::numeric, 2) as avg_performance,
        ROUND(((AVG(v.score_preparation) + AVG(v.score_performance)) / 2)::numeric, 2) as media,
        COUNT(v.id) as vote_count
      FROM registrations r
      INNER JOIN votes v ON v.registration_id = r.id
      GROUP BY r.id
      ORDER BY media DESC NULLS LAST
    `);
    res.json({ results: rows });
  } catch (err) {
    console.error('Detailed results error:', err);
    res.status(500).json({ error: 'Errore nel recupero risultati dettagliati' });
  }
});

// ========== TIMER: save/get timer state for projector ==========
router.put('/admin/timer', adminAuth, async (req, res) => {
  try {
    const { ends_at } = req.body; // ISO string or null to cancel
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('voting_timer_ends_at', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [ends_at || '']
    );
    broadcast('timer-changed', { ends_at: ends_at || null });
    res.json({ success: true });
  } catch (err) {
    console.error('Timer save error:', err);
    res.status(500).json({ error: 'Errore salvataggio timer' });
  }
});

// ========== PUBLIC: voting status for projector ==========
router.get('/projector-status', async (req, res) => {
  try {
    // Get performers with open voting
    const { rows: openPerformers } = await pool.query(`
      SELECT id, type, contact_name, group_name, company, song_1, song_1_artist, song_2, song_2_artist, current_song_num
      FROM registrations
      WHERE voting_open = true AND type != 'pubblico'
      ORDER BY voting_order NULLS LAST, created_at
    `);
    // Get timer
    const { rows: timerRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'voting_timer_ends_at'`
    );
    const timerEndsAt = timerRows.length && timerRows[0].value ? timerRows[0].value : null;

    res.json({
      voting_open: openPerformers.length > 0,
      open_count: openPerformers.length,
      open_performers: openPerformers.map(p => {
        const sn = p.current_song_num || 1;
        return {
          id: p.id,
          name: p.type === 'gruppo' ? p.group_name : p.contact_name,
          company: p.company,
          type: p.type,
          song: sn === 2 ? p.song_2 : p.song_1,
          song_artist: sn === 2 ? p.song_2_artist : p.song_1_artist,
        };
      }),
      timer_ends_at: timerEndsAt
    });
  } catch (err) {
    console.error('Projector status error:', err);
    res.status(500).json({ error: 'Errore stato proiettore' });
  }
});

// Admin: get voter count (how many unique voters)
router.get('/admin/voter-stats', adminAuth, async (req, res) => {
  try {
    const { rows: voterCount } = await pool.query(
      'SELECT COUNT(DISTINCT LOWER(voter_email)) as total_voters FROM votes'
    );
    const { rows: totalVotes } = await pool.query('SELECT COUNT(*) as total FROM votes');
    const { rows: voters } = await pool.query(
      'SELECT LOWER(voter_email) as email, COUNT(*) as vote_count FROM votes GROUP BY LOWER(voter_email) ORDER BY vote_count DESC'
    );
    res.json({
      total_voters: parseInt(voterCount[0]?.total_voters || 0),
      total_votes: parseInt(totalVotes[0]?.total || 0),
      voters: voters,
    });
  } catch (err) {
    console.error('Voter stats error:', err);
    res.status(500).json({ error: 'Errore statistiche votanti' });
  }
});

// ========== ADMIN: Reset all votes ==========
router.delete('/admin/reset-votes', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM votes');
    // Also close all voting and clear timer
    await pool.query(`UPDATE registrations SET voting_open = false WHERE type != 'pubblico'`);
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('voting_timer_ends_at', '')
       ON CONFLICT (key) DO UPDATE SET value = '', updated_at = NOW()`
    );
    broadcast('reset');
    res.json({ success: true, deleted: rowCount });
  } catch (err) {
    console.error('Reset votes error:', err);
    res.status(500).json({ error: 'Errore nel reset delle votazioni' });
  }
});

// ========== ADMIN: Set which artist results to show on projector ==========
// value: 'none', 'all', or comma-separated IDs like '1,5,12'
router.put('/admin/show-results', adminAuth, async (req, res) => {
  try {
    const { mode, ids } = req.body; // mode: 'none'|'all'|'selected', ids: [1,2,3]
    let val = 'none';
    if (mode === 'all') val = 'all';
    else if (mode === 'selected' && ids && ids.length) val = ids.join(',');
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('projector_show_results', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [val]
    );
    broadcast('results-changed', { value: val });
    res.json({ success: true, value: val });
  } catch (err) {
    console.error('Show results error:', err);
    res.status(500).json({ error: 'Errore aggiornamento visibilità risultati' });
  }
});

router.get('/admin/show-results', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'projector_show_results'`
    );
    const val = rows.length ? rows[0].value : 'none';
    res.json({ value: val });
  } catch (err) {
    res.json({ value: 'none' });
  }
});

// ========== PUBLIC: full projector data (results + status) ==========
router.get('/projector-data', async (req, res) => {
  try {
    // Voting status + group members for open performers (include contact_name for leader)
    const { rows: openPerformers } = await pool.query(`
      SELECT r.id, r.type, r.contact_name, r.group_name, r.company,
        r.song_1, r.song_1_artist, r.song_2, r.song_2_artist, r.current_song_num
      FROM registrations r
      WHERE r.voting_open = true AND r.type != 'pubblico'
      ORDER BY r.voting_order NULLS LAST, r.created_at
    `);
    // Fetch members for open groups
    const openGroupIds = openPerformers.filter(p => p.type === 'gruppo').map(p => p.id);
    let openMembersMap = {};
    if (openGroupIds.length) {
      const { rows: gm } = await pool.query(
        'SELECT registration_id, name FROM group_members WHERE registration_id = ANY($1) ORDER BY id',
        [openGroupIds]
      );
      gm.forEach(m => {
        if (!openMembersMap[m.registration_id]) openMembersMap[m.registration_id] = [];
        openMembersMap[m.registration_id].push(m.name);
      });
    }

    // Timer
    const { rows: timerRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'voting_timer_ends_at'`
    );
    const timerEndsAt = timerRows.length && timerRows[0].value ? timerRows[0].value : null;

    // Show results setting
    const { rows: showRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'projector_show_results'`
    );
    const showVal = showRows.length ? showRows[0].value : 'none';

    // Results with MEDIA (average of prep+perf / 2)
    const { rows: results } = await pool.query(`
      SELECT r.id,
        CASE WHEN r.type = 'gruppo' THEN r.group_name ELSE r.contact_name END as name,
        r.type, r.company,
        ROUND(AVG(v.score_preparation)::numeric, 2) as avg_preparation,
        ROUND(AVG(v.score_performance)::numeric, 2) as avg_performance,
        ROUND(((AVG(v.score_preparation) + AVG(v.score_performance)) / 2)::numeric, 2) as media,
        COUNT(v.id) as vote_count
      FROM registrations r
      INNER JOIN votes v ON v.registration_id = r.id
      GROUP BY r.id
      ORDER BY media DESC NULLS LAST
    `);

    // Total unique voters
    const { rows: vc } = await pool.query('SELECT COUNT(DISTINCT LOWER(voter_email)) as c FROM votes');
    const totalVoters = parseInt(vc[0]?.c || 0);

    // Filter results based on show setting
    let visibleResults = [];
    if (showVal === 'all') {
      visibleResults = results;
    } else if (showVal !== 'none' && showVal !== '') {
      const visibleIds = showVal.split(',').map(Number);
      visibleResults = results.filter(r => visibleIds.includes(r.id));
    }

    res.json({
      voting_open: openPerformers.length > 0,
      open_performers: openPerformers.map(p => {
        const sn = p.current_song_num || 1;
        return {
          id: p.id,
          name: p.type === 'gruppo' ? p.group_name : p.contact_name,
          company: p.company, type: p.type,
          song: sn === 2 ? p.song_2 : p.song_1,
          song_artist: sn === 2 ? p.song_2_artist : p.song_1_artist,
          members: p.type === 'gruppo'
            ? [p.contact_name, ...(openMembersMap[p.id] || [])].filter(Boolean)
            : [],
        };
      }),
      timer_ends_at: timerEndsAt,
      show_results: showVal !== 'none' && showVal !== '',
      total_voters: totalVoters,
      results: visibleResults.map(r => ({
        id: r.id, name: r.name, type: r.type, company: r.company,
        avg_preparation: r.avg_preparation ? parseFloat(r.avg_preparation) : null,
        avg_performance: r.avg_performance ? parseFloat(r.avg_performance) : null,
        media: r.media ? parseFloat(r.media) : null,
        vote_count: parseInt(r.vote_count),
      })),
    });
  } catch (err) {
    console.error('Projector data error:', err);
    res.status(500).json({ error: 'Errore dati proiettore' });
  }
});

module.exports = router;
