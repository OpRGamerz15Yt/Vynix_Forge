require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { router: authRouter } = require('./auth');
const { requireAuth } = require('./requireAuth');
const db = require('./db');
const { getPlan } = require('./plans');
const { getOwnerUserId } = require('./ownerAuth');

const app = express();

const allowedOrigins = new Set([
  process.env.APP_URL,
  'https://vynixforge.indevs.in',
  'https://www.vynixforge.indevs.in'
].filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if(origin && allowedOrigins.has(origin)){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// CRITICAL ORDERING: the Stripe webhook needs the raw request body to verify
// its signature, so it must be registered with express.raw() BEFORE the
// global express.json() middleware below -- otherwise json() would already
// have consumed/parsed the stream and signature verification would fail.
const { webhookHandler } = require('./billing');
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json());

// Serves the existing Vynix Forge dashboard (public/index.html). Note:
// this frontend still runs entirely on its own client-side localStorage
// logic as before -- serving the file here does NOT yet mean it's talking
// to this backend's /api/* routes. That wiring (auth, projects, builds)
// is a separate step. This just fixes "visiting the server shows nothing."
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production' }
}));

app.use('/auth', authRouter);

// Sanity check at boot -- makes a misconfigured OWNER_USER_ID loudly visible
// rather than silently insecure.
if(!getOwnerUserId()){
  console.warn('=====================================================');
  console.warn(' OWNER_USER_ID is not set. No account will be Owner.');
  console.warn(' This is the SAFE default -- set it in .env once you');
  console.warn(' know your own GitHub numeric user ID.');
  console.warn('=====================================================');
}

app.get('/api/me', requireAuth, (req, res) => {
  const plan = getPlan(req.user.plan);
  res.json({
    githubLogin: req.user.githubLogin,
    plan: req.user.plan,
    storedPlan: req.user.storedPlan,
    isOwnerOverride: req.user.plan === 'owner' && req.user.storedPlan !== 'owner',
    limits: plan,
    usage: {
      activeProjects: db.countActiveProjects(req.user.id),
      buildsToday: db.countBuildsToday(req.user.id)
    }
  });
});

const projectsRouter = require('./projects');
const buildsRouter = require('./builds');
const { router: billingRouter } = require('./billing');
const adminRouter = require('./admin');
const webhooksRouter = require('./webhooks');
const devApiKeyRouter = require('./devApiKey');
app.use('/api/projects', projectsRouter);
app.use('/api/builds', buildsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/dev', devApiKeyRouter);

const swept = db.sweepInterruptedBuilds();
if(swept > 0) console.log(`Swept ${swept} build(s) interrupted by a previous restart into failed.`);

if(require.main === module){
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Vynix Forge backend listening on :${PORT}`));
}

module.exports = app;
