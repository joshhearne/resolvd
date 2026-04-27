const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { listForUser, unreadCount, markRead, markAllRead } = require('../services/notifications');

const router = express.Router();

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const [items, count] = await Promise.all([
      listForUser(req.session.user.id),
      unreadCount(req.session.user.id),
    ]);
    res.json({ items, unread: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    await markAllRead(req.session.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    await markRead(Number(req.params.id), req.session.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
