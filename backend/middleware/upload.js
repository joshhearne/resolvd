const multer = require('multer');

// Error for a multer fileFilter to reject a file with: handleUploadErrors
// turns it into a 400 instead of a 500.
function fileRejected(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Wrap a multer middleware (upload.single(...) / upload.array(...)) so a
// rejected upload gets a JSON error instead of Express's default HTML 500:
// 413 for files over `maxBytes`, 400 for other multer limits and
// fileRejected() errors. Anything else (e.g. a disk write failure) still
// goes to next(err).
function handleUploadErrors(upload, { maxBytes }) {
  return (req, res, next) => {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const mb = Number((maxBytes / (1024 * 1024)).toFixed(1));
          return res.status(413).json({ error: `File too large (max ${mb} MB)` });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    });
  };
}

module.exports = { handleUploadErrors, fileRejected };
