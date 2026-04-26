const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { randomUUID } = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWritePatch, decryptRow, decryptRows, getMode } = require('../services/fields');
const { encrypt, decrypt } = require('../services/crypto');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Use memory storage so the file body can be encrypted in-process before
// hitting disk. The 50MB default cap (env-configurable) keeps RAM bounded.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024 },
});

function fileCtx(filename) {
  return `attachments.file:${filename}`;
}

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
    await decryptRows('attachments', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/tickets/:ticketId/attachments
router.post('/tickets/:ticketId/attachments', requireAuth, requireRole('Admin', 'Manager', 'Submitter'),
  upload.array('files', 20), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const writtenPaths = [];
    try {
      const ticket = await pool.query('SELECT id FROM tickets WHERE id = $1', [req.params.ticketId]);
      if (!ticket.rows[0]) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const commentId = req.body.comment_id ? Number(req.body.comment_id) : null;
      if (commentId) {
        const c = await pool.query('SELECT id FROM comments WHERE id = $1 AND ticket_id = $2', [commentId, req.params.ticketId]);
        if (!c.rows[0]) {
          return res.status(400).json({ error: 'Invalid comment_id' });
        }
      }

      const mode = await getMode(pool);
      const inserted = [];
      for (const file of req.files) {
        const ext = path.extname(file.originalname);
        const filename = `${randomUUID()}${ext}`;
        const filePath = path.join(UPLOADS_DIR, filename);

        // Encrypt the file body when standard mode is on. Plaintext in
        // memory is freed when the buffer goes out of scope.
        const encryptedAtRest = mode === 'standard';
        const onDisk = encryptedAtRest
          ? await encrypt(file.buffer, fileCtx(filename))
          : file.buffer;
        await fsp.writeFile(filePath, onDisk);
        writtenPaths.push(filePath);

        const patch = await buildWritePatch(pool, 'attachments', {
          original_name: file.originalname,
        });
        const baseCols = ['ticket_id', 'user_id', 'comment_id', 'filename', 'mimetype', 'size', 'encrypted_at_rest'];
        const baseValues = [
          Number(req.params.ticketId),
          req.session.user.id,
          commentId,
          filename,
          file.mimetype,
          file.size, // logical (plaintext) size for UI
          encryptedAtRest,
        ];
        const cols = [...baseCols, ...patch.cols];
        const values = [...baseValues, ...patch.values];
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const result = await pool.query(
          `INSERT INTO attachments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          values
        );
        const row = result.rows[0];
        await decryptRow('attachments', row);
        inserted.push(row);
      }

      // Touch ticket updated_at
      await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.ticketId]);

      res.status(201).json(inserted);
    } catch (err) {
      console.error(err);
      writtenPaths.forEach(p => fs.unlink(p, () => {}));
      res.status(500).json({ error: 'Database error' });
    }
  }
);

async function readAttachmentBody(attachment) {
  const filePath = path.join(UPLOADS_DIR, attachment.filename);
  const raw = await fsp.readFile(filePath);
  if (!attachment.encrypted_at_rest) return raw;
  return decrypt(raw, fileCtx(attachment.filename), { raw: true });
}

// GET /api/attachments/:id/view — inline (for export/print image embedding)
router.get('/attachments/:id/view', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const attachment = result.rows[0];
    if (!attachment) return res.status(404).end();
    await decryptRow('attachments', attachment);
    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    const body = await readAttachmentBody(attachment);
    res.setHeader('Content-Type', attachment.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name || attachment.filename}"`);
    res.send(body);
  } catch (err) {
    console.error('attachment view error:', err);
    res.status(500).end();
  }
});

// GET /api/attachments/:id  — download
router.get('/attachments/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    const attachment = result.rows[0];
    if (!attachment) return res.status(404).json({ error: 'Not found' });
    await decryptRow('attachments', attachment);

    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const body = await readAttachmentBody(attachment);
    const downloadName = attachment.original_name || attachment.filename;
    res.setHeader('Content-Type', attachment.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.send(body);
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
