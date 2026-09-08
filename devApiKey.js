const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./requireAuth');
const { requirePlanFeature } = require('./requirePlan');
const db = require('./db');

const router = express.Router();

// Session-auth only (not API-key auth) to generate a NEW key -- you
// shouldn't be able to mint new API keys using an existing API key.
router.post('/api-key', requireAuth, requirePlanFeature('apiAccess'), (req, res) => {
  const rawKey = 'vnx_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  db.db.prepare('UPDATE users SET api_key_hash=?, updated_at=? WHERE id=?').run(hash, Date.now(), req.user.id);
  // Shown exactly once -- the raw key is never stored or retrievable again.
  res.json({ apiKey: rawKey, message: 'Store this now -- it will not be shown again.' });
});

router.delete('/api-key', requireAuth, (req, res) => {
  db.db.prepare('UPDATE users SET api_key_hash=NULL, updated_at=? WHERE id=?').run(Date.now(), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
