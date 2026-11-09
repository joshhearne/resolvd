// Storage for the optional source PDF on a local KB article. Same disk +
// encryption scheme as ticket attachments: UPLOADS_DIR, random filename,
// AES-GCM at rest when encryption mode is 'standard'.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { randomUUID } = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const { getMode } = require('./fields');

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';

const ctx = (filename) => `kb_articles.pdf:${filename}`;

function isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

async function writePdf(client, buffer) {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `kb-${randomUUID()}.pdf`;
  const encrypted = (await getMode(client)) === 'standard';
  const onDisk = encrypted ? await encrypt(buffer, ctx(filename)) : buffer;
  await fsp.writeFile(path.join(UPLOADS_DIR, filename), onDisk);
  return { filename, encrypted };
}

async function readPdf(article) {
  if (!article?.pdf_filename) return null;
  const p = path.join(UPLOADS_DIR, path.basename(article.pdf_filename));
  if (!fs.existsSync(p)) return null;
  const raw = await fsp.readFile(p);
  return article.pdf_encrypted ? decrypt(raw, ctx(article.pdf_filename), { raw: true }) : raw;
}

function removePdfFile(filename) {
  if (!filename) return;
  fs.unlink(path.join(UPLOADS_DIR, path.basename(filename)), () => {});
}

module.exports = { isPdf, writePdf, readPdf, removePdfFile };
