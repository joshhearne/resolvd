const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024 },
});

const router = express.Router();

// GET /api/tickets/:ticketId/attachments
router.get('/tickets/:ticketId/attachments', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, u.display_name as uploaded_by_name
      FROM attachments a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.ticket_id = $1
      ORDER BY a.created_at ASC
    `, [req.params.ticketId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:ticketId/attachments
router.post('/tickets/:ticketId/attachments', requireAuth, requireRole('Admin', 'Submitter'),
  upload.array('files', 20), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    try {
      const ticket = await pool.query('SELECT id FROM tickets WHERE id = $1', [req.params.ticketId]);
      if (!ticket.rows[0]) {
        // Clean up uploaded files
        req.files.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const inserted = [];
      for (const file of req.files) {
        const result = await pool.query(`
          INSERT INTO attachments (ticket_id, user_id, filename, original_name, mimetype, size)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [
          Number(req.params.ticketId),
          req.session.user.id,
          file.filename,
          file.originalname,
          file.mimetype,
          file.size,
        ]);
        inserted.push(result.rows[0]);
      }

      // Touch ticket updated_at
      await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.ticketId]);

      res.status(201).json(inserted);
    } catch (err) {
      console.error(err);
      req.files.forEach(f => fs.unlink(f.path, () => {}));
      res.status(500).json({ error: 'Database error' });
    }
  }
);

// GET /api/attachments/:id/view — inline (for export/print image embedding)
router.get('/attachments/:id/view', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const attachment = result.rows[0];
    if (!attachment) return res.status(404).end();
    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type', attachment.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).end();
  }
});

// GET /api/attachments/:id  — download
router.get('/attachments/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const attachment = result.rows[0];
    if (!attachment) return res.status(404).json({ error: 'Not found' });

    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    res.download(filePath, attachment.original_name);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/attachments/:id — Admin or uploader
router.delete('/attachments/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const attachment = result.rows[0];
    if (!attachment) return res.status(404).json({ error: 'Not found' });

    const isAdmin = req.session.user.role === 'Admin';
    const isOwner = attachment.user_id === req.session.user.id;
    if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });

    await pool.query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    fs.unlink(path.join(UPLOADS_DIR, attachment.filename), () => {});

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
