require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');

const { pool } = require('./db/pool');
const { initSchema } = require('./db/schema');

const authRoutes = require('./routes/auth');
const inviteRoutes = require('./routes/invites');
const authSettingsRoutes = require('./routes/authSettings');
const ticketRoutes = require('./routes/tickets');
const commentRoutes = require('./routes/comments');
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
const { requireSupportAccessIfSupport } = require('./middleware/supportAccess');

const app = express();
const PORT = process.env.PORT || 3001;

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

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Punchlist backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Schema init failed:', err);
    process.exit(1);
  });
