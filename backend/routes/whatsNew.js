// What's new pop-up and bell entries (services/whatsNew.js). Every signed-in
// user can read these; entries are filtered to the ones their role may see.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { visibleReleases, markSeen } = require('../services/whatsNew');

const router = express.Router();

// GET /api/whats-new/unseen: releases since the user last closed the
// pop-up. The client shows the pop-up when this isn't empty.
router.get('/unseen', requireAuth, async (req, res) => {
  try {
    res.json({ releases: await visibleReleases(req.session.user.id, { unseen: true, limit: 10 }) });
  } catch (err) {
    console.error('whats-new unseen error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/whats-new/seen { release_id }
router.post('/seen', requireAuth, async (req, res) => {
  const releaseId = Number(req.body.release_id);
  if (!Number.isInteger(releaseId) || releaseId < 1) {
    return res.status(400).json({ error: 'release_id must be a positive integer' });
  }
  try {
    await markSeen(req.session.user.id, releaseId);
    res.json({ ok: true });
  } catch (err) {
    console.error('whats-new seen error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/whats-new: recent releases (history).
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json({ releases: await visibleReleases(req.session.user.id, { limit: 20 }) });
  } catch (err) {
    console.error('whats-new list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/whats-new/:id: one release, opened from the bell.
router.get('/:id', numericId, requireAuth, async (req, res) => {
  try {
    const [release] = await visibleReleases(req.session.user.id, { releaseId: Number(req.params.id), limit: 1 });
    if (!release) return res.status(404).json({ error: 'Not found' });
    res.json({ release });
  } catch (err) {
    console.error('whats-new get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
