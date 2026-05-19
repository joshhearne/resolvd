require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');

const { pool } = require('./db/pool');
const { initSchema } = require('./db/schema');

const authRoutes = require('./routes/auth');
const versionRoutes = require('./routes/version');
const inviteRoutes = require('./routes/invites');
const authSettingsRoutes = require('./routes/authSettings');
const ticketRoutes = require('./routes/tickets');
const commentRoutes = require('./routes/comments');
const ticketNoteRoutes = require('./routes/ticketNotes');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboard');
const viewRoutes = require('./routes/views');
const projectRoutes = require('./routes/projects');
const attachmentRoutes = require('./routes/attachments');
const brandingRoutes = require('./routes/branding');
const exportRoutes = require('./routes/export');
const followerRoutes = require('./routes/followers');
const statusRoutes = require('./routes/statuses');
const supportRoutes = require('./routes/support');
const companyRoutes = require('./routes/companies');
const contactRoutes = require('./routes/contacts');
const emailTemplateRoutes = require('./routes/emailTemplates');
const inboundEmailRoutes = require('./routes/inboundEmail');
const inboundProviderRoutes = require('./routes/inboundProviders');
const emailBackendRoutes = require('./routes/emailBackends');
const notificationRoutes = require('./routes/notifications');
const pushRoutes = require('./routes/push');
const systemHealthRoutes = require('./routes/systemHealth');
const webhookRoutes = require('./routes/webhooks');
const alertSourceRoutes = require('./routes/alertSources');
const alertRoutes = require('./routes/alerts');
const assetRoutes = require('./routes/assets');
const assetTypeRoutes = require('./routes/assetTypes');
const labelPrinterRoutes = require('./routes/labelPrinter');
const consumableRoutes = require('./routes/consumables');
const cannedResponseRoutes = require('./routes/cannedResponses');
const slaRoutes = require('./routes/sla');
const assignmentPolicyRoutes = require('./routes/assignmentPolicies');
const escalationPolicyRoutes = require('./routes/escalationPolicies');
const agentRoutes = require('./routes/agents');
const customFieldRoutes = require('./routes/customFields');
const aiAssistRoutes = require('./routes/aiAssist');
const aiSettingsRoutes = require('./routes/aiSettings');
const securityRoutes = require('./routes/security');
const kbRoutes = require('./routes/kb');
const { requireSupportAccessIfSupport } = require('./middleware/supportAccess');
const { securityHeaders } = require('./middleware/securityHeaders');

const app = express();
const PORT = process.env.PORT || 3001;

// Set security response headers on every request. Cheap, runs first.
app.use(securityHeaders);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy (nginx sits in front)
app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'changeme-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    sameSite: 'lax',
  },
}));

// Routes
app.use('/auth', authRoutes);
// Webhook receivers authenticate via URL token, not session. Mount before
// the support JIT guard since they aren't tied to any user principal.
app.use('/api/webhooks', webhookRoutes);
// Build identity — public, no auth, no PII. Sits before the support
// guard since it's not user-scoped.
app.use('/api/version', versionRoutes);
// Support routes mounted BEFORE the JIT guard so support principals can
// poll their own grant status (/api/support/grants/me) and admins can
// approve/revoke without being self-locked out.
app.use('/api/support', supportRoutes);

// JIT guard: blocks role='Support' on every other /api/* path unless they
// have an active, non-expired grant. No-op for non-Support users.
app.use('/api', requireSupportAccessIfSupport);

app.use('/api/invites', inviteRoutes);
app.use('/api/auth-settings', authSettingsRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/tickets', commentRoutes);
app.use('/api/tickets', ticketNoteRoutes);
// commentRoutes also mounts /comments/:id/mute|unmute at /api/comments/...
app.use('/api', commentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/views', viewRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', attachmentRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/tickets/:ticketId', followerRoutes);
app.use('/api/statuses', statusRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api', contactRoutes);
app.use('/api/email-templates', emailTemplateRoutes);
app.use('/api/inbound', inboundEmailRoutes);
app.use('/api/inbound', inboundProviderRoutes);
app.use('/api/email-backends', emailBackendRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/system-health', systemHealthRoutes);
app.use('/api/alert-sources', alertSourceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/software-aliases', require('./routes/softwareAliases'));
app.use('/api/assets', assetRoutes);
app.use('/api/label-printer', labelPrinterRoutes);
app.use('/api/consumables', consumableRoutes);
app.use('/api/asset-types', assetTypeRoutes);
app.use('/api/canned-responses', cannedResponseRoutes);
app.use('/api/sla', slaRoutes);
app.use('/api/assignment-policies', assignmentPolicyRoutes);
app.use('/api/escalation-policies', escalationPolicyRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/custom-field-defs', customFieldRoutes);
app.use('/api/ai', aiAssistRoutes);
app.use('/api/ai-settings', aiSettingsRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/kb', kbRoutes);

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

initSchema()
  .then(() => {
    // Scheduled jobs: muted-vendor digest fires at the configured local
    // time once per day (cadence checked every 5 min).
    require('./services/mutedDigest').startScheduler();
    // Inbox monitor renewal: walks active subscriptions hourly and
    // renews any within 12h of expiring.
    require('./services/inboxMonitorScheduler').startScheduler();
    // Auto-close tickets sitting in a resolved_pending_close status
    // past their configured grace period. Hourly tick.
    require('./services/autoClose').startScheduler();
    // Notification outbox flusher: drains buffered email rows for users
    // whose email_digest cadence (hourly / 12h / daily) has elapsed.
    // 5-minute tick.
    require('./services/notificationOutbox').startScheduler();
    // SLA breach detector: every 5 min, find tickets past their
    // sla_response_due_at / sla_resolve_due_at without being responded
    // / resolved, mark breached, fan out to assignee + followers.
    require('./services/sla').startScheduler();
    // External alert source poller: pulls policy results from Action1 on
    // each source's configured cadence (Action1 has no webhook channel).
    // 30-second tick; each source fires per its poll_interval_minutes.
    require('./services/alertSourcePollScheduler').startScheduler();
    app.listen(PORT, () => {
      console.log(`Resolvd backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Schema init failed:', err);
    process.exit(1);
  });
