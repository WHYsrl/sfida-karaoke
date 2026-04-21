const express = require('express');
const router = express.Router();
const pool = require('../db');

// Resend webhook endpoint
router.post('/', async (req, res) => {
  try {
    // Parse the raw body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) :
                 Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;

    const { type, data } = body;

    if (!type || !data) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Log the event
    await pool.query(
      'INSERT INTO email_events (resend_message_id, event_type, email, metadata) VALUES ($1, $2, $3, $4)',
      [data.email_id || null, type, data.to?.[0] || data.email || null, JSON.stringify(data)]
    );

    // Update invite tracking based on event type
    if (data.email_id) {
      switch (type) {
        case 'email.delivered':
          // Mark as delivered (no specific column, but logged)
          break;
        case 'email.opened':
          await pool.query(
            'UPDATE email_invites SET opened_at = COALESCE(opened_at, NOW()), open_count = open_count + 1 WHERE resend_message_id = $1',
            [data.email_id]
          );
          break;
        case 'email.clicked':
          await pool.query(
            'UPDATE email_invites SET clicked_at = COALESCE(clicked_at, NOW()), click_count = click_count + 1 WHERE resend_message_id = $1',
            [data.email_id]
          );
          break;
        case 'email.bounced':
        case 'email.complained':
          // Log is sufficient
          break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

module.exports = router;
