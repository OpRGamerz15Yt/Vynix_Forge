const express = require('express');
const { requireAuth } = require('./requireAuth');
const { requireOwner } = require('./requirePlan');
const db = require('./db');
const { PLANS, getPlan } = require('./plans');

const router = express.Router();
router.use(requireAuth, requireOwner); // EVERY route below requires the real, server-resolved Owner override

router.get('/users', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const rows = db.db.prepare('SELECT id, github_id, github_login, plan, created_at FROM users').all();
  const filtered = q ? rows.filter(u => u.github_login.toLowerCase().includes(q)) : rows;
  res.json(filtered);
});

router.get('/users/:id', (req, res) => {
  const user = db.getUserById(req.params.id);
  if(!user) return res.status(404).json({ error: 'User not found.' });
  const builds = db.listBuildsForUser(user.id);
  const projects = db.listProjectsForUser(user.id);
  res.json({
    id: user.id, githubLogin: user.github_login, plan: user.plan, createdAt: user.created_at,
    usage: {
      projects: projects.length,
      buildsTotal: builds.length,
      buildsToday: db.countBuildsToday(user.id),
      storageBytes: builds.filter(b=>b.artifact_size).reduce((s,b)=>s+b.artifact_size,0)
    }
  });
});

// Grant/revoke a plan. Owner itself is never settable here -- it can ONLY
// ever come from the OWNER_USER_ID environment variable check, never from
// this or any other database write.
router.post('/users/:id/plan', (req, res) => {
  const { plan } = req.body || {};
  if(!['free','pro','dev'].includes(plan)){
    return res.status(400).json({ error: 'Invalid plan. Owner cannot be granted through this endpoint -- it is never a database value.' });
  }
  const user = db.getUserById(req.params.id);
  if(!user) return res.status(404).json({ error: 'User not found.' });
  const before = user.plan;
  const updated = db.setUserPlan(user.id, plan, req.user.id, 'manual admin grant');
  console.log(`[ADMIN ACTION] Owner (${req.user.githubLogin}) changed user ${user.github_login} from ${before.toUpperCase()} -> ${plan.toUpperCase()}`);
  res.json(updated);
});

router.get('/builds', (req, res) => {
  const rows = db.db.prepare(`
    SELECT b.*, u.github_login FROM builds b JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC LIMIT 200
  `).all();
  res.json(rows.map(b => ({
    id: b.id, user: b.github_login, kind: b.kind, status: b.status,
    progress: b.progress, error: b.error, createdAt: b.created_at, completedAt: b.completed_at,
    artifactSize: b.artifact_size
  })));
});

router.get('/builds/:id/log', (req, res) => {
  const build = db.getBuild(req.params.id);
  if(!build) return res.status(404).json({ error: 'Build not found.' });
  res.json({ id: build.id, status: build.status, log: JSON.parse(build.log||'[]'), error: build.error });
});

router.get('/usage-summary', (req, res) => {
  const users = db.db.prepare('SELECT plan, COUNT(*) c FROM users GROUP BY plan').all();
  const storage = db.db.prepare('SELECT COALESCE(SUM(artifact_size),0) total FROM builds WHERE artifact_size IS NOT NULL').get();
  const buildsByStatus = db.db.prepare('SELECT status, COUNT(*) c FROM builds GROUP BY status').all();
  res.json({ usersByPlan: users, totalArtifactBytes: storage.total, buildsByStatus });
});

router.get('/audit-log', (req, res) => {
  res.json(db.listAdminAuditLog(200));
});

router.get('/plans', (req, res) => {
  res.json(PLANS);
});

module.exports = router;
