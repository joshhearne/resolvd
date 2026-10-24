// Express 5 (path-to-regexp v8) dropped inline regex params like
// '/:id(\\d+)'. Put this first on a '/:id' route to get the same effect:
// non-numeric ids skip to the next matching route instead of hitting
// this handler.
function numericId(req, res, next) {
  if (/^\d+$/.test(req.params.id)) return next();
  next('route');
}

module.exports = { numericId };
