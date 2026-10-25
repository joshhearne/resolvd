// MSP billing setup (shown when customer companies / MSP mode is on).
//
//   GET    /api/billing/rate-cards                         — Admin/Manager
//   POST   /api/billing/rate-cards                         — Admin { name, hourly_rate, after_hours_multiplier?, weekend_multiplier?, is_default? }
//   PATCH  /api/billing/rate-cards/:id                     — Admin
//   DELETE /api/billing/rate-cards/:id                     — Admin (retired if a contract uses it)
//   PUT    /api/billing/rate-cards/:id/rates               — Admin { work_type_id?, user_id?, hourly_rate } (upsert)
//   DELETE /api/billing/rate-cards/:id/rates/:rateId       — Admin
//
//   GET    /api/billing/types                              — Admin/Manager
//   POST   /api/billing/types                              — Admin { name, behavior, external_code?, description? }
//   PATCH  /api/billing/types/:id                          — Admin
//   DELETE /api/billing/types/:id                          — Admin (retired if a contract uses it)
//
//   GET    /api/billing/companies/:companyId/contracts     — Admin/Manager
//   POST   /api/billing/companies/:companyId/contracts     — Admin/Manager
//   PATCH  /api/billing/companies/:companyId/contracts/:id — Admin/Manager
//   DELETE /api/billing/companies/:companyId/contracts/:id — Admin/Manager
//
//   GET    /api/billing/report/utilisation?from=&to=       — Admin/Manager

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const billing = require('../services/billing');

const router = express.Router();
router.use(requireAuth, requireRole('Admin', 'Manager'));
const adminOnly = requireRole('Admin');

function fail(res, err, label) {
  if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  console.error(`billing ${label}:`, err);
  return res.status(500).json({ error: 'Database error' });
}

const id = (v) => Number(v);
const wrap = (label, fn, status = 200) => async (req, res) => {
  try { res.status(status).json(await fn(req)); } catch (err) { fail(res, err, label); }
};

router.get('/rate-cards', wrap('rate-cards list', () => billing.listRateCards()));
router.post('/rate-cards', adminOnly, wrap('rate-cards create', (req) => billing.createRateCard(req.body), 201));
router.patch('/rate-cards/:id', adminOnly, wrap('rate-cards update', (req) => billing.updateRateCard(id(req.params.id), req.body)));
router.delete('/rate-cards/:id', adminOnly, wrap('rate-cards delete', (req) => billing.deleteRateCard(id(req.params.id))));
router.put('/rate-cards/:id/rates', adminOnly, wrap('rates set', (req) => billing.setRate(id(req.params.id), req.body || {})));
router.delete('/rate-cards/:id/rates/:rateId', adminOnly,
  wrap('rates delete', (req) => billing.deleteRate(id(req.params.id), id(req.params.rateId))));

router.get('/types', wrap('types list', () => billing.listBillingTypes()));
router.post('/types', adminOnly, wrap('types create', (req) => billing.createBillingType(req.body), 201));
router.patch('/types/:id', adminOnly, wrap('types update', (req) => billing.updateBillingType(id(req.params.id), req.body)));
router.delete('/types/:id', adminOnly, wrap('types delete', (req) => billing.deleteBillingType(id(req.params.id))));

router.get('/companies/:companyId/contracts',
  wrap('contracts list', (req) => billing.listContracts(id(req.params.companyId))));
router.post('/companies/:companyId/contracts',
  wrap('contracts create', (req) => billing.createContract(id(req.params.companyId), req.body), 201));
router.patch('/companies/:companyId/contracts/:id',
  wrap('contracts update', (req) => billing.updateContract(id(req.params.companyId), id(req.params.id), req.body)));
router.delete('/companies/:companyId/contracts/:id',
  wrap('contracts delete', (req) => billing.deleteContract(id(req.params.companyId), id(req.params.id))));

router.get('/report/utilisation',
  wrap('utilisation', (req) => billing.utilisation({ from: req.query.from, to: req.query.to })));

module.exports = router;
