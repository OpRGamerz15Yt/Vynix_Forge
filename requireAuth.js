const crypto = require('crypto');
const db = require('./db');
const { resolveEffectivePlan } = require('./ownerAuth');

// Attaches req.user = { id, githubId, githubLogin, plan } where `plan` is
// the REAL, server-resolved effective plan (owner override applied here,
// server-side, on every single request -- never cached into a client
// cookie/token that could go stale or be forged).
function requireAuth(req, res, next){
  if(!req.session || !req.session.userId){
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const dbUser = db.getUserById(req.session.userId);
  if(!dbUser){
    return res.status(401).json({ error: 'Session user no longer exists.' });
  }
  const effectivePlan = resolveEffectivePlan(dbUser.github_id, dbUser.plan);
  req.user = {
    id: dbUser.id,
    githubId: dbUser.github_id,
    githubLogin: dbUser.github_login,
    plan: effectivePlan,       // what the request should actually be authorized against
    storedPlan: dbUser.plan    // the real paid/free plan on file, ignoring any Owner override
  };
  next();
}

// Same as requireAuth, but also accepts a Dev-tier API key via
// "Authorization: Bearer <key>" instead of a session cookie -- for
// programmatic/CI use. Deliberately never resolves to 'owner', even if the
// key happens to belong to the Owner's account: Owner/admin capability is
// session-login-only by design, so a leaked or long-lived API key can never
// be used to reach admin endpoints ("Do not expose Owner/admin APIs to Dev
// users" -- this makes that true even in the degenerate case).
function requireAuthOrApiKey(req, res, next){
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if(bearerMatch){
    const rawKey = bearerMatch[1];
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const dbUser = db.db.prepare('SELECT * FROM users WHERE api_key_hash = ?').get(hash);
    if(!dbUser){
      return res.status(401).json({ error: 'Invalid API key.' });
    }
    let effectivePlan = resolveEffectivePlan(dbUser.github_id, dbUser.plan);
    if(effectivePlan === 'owner') effectivePlan = 'dev'; // hard cap, see comment above
    if(effectivePlan !== 'dev'){
      return res.status(403).json({ error: 'API access requires the Dev plan.' });
    }
    req.user = { id: dbUser.id, githubId: dbUser.github_id, githubLogin: dbUser.github_login, plan: effectivePlan, storedPlan: dbUser.plan, viaApiKey: true };
    return next();
  }
  return requireAuth(req, res, next);
}

module.exports = { requireAuth, requireAuthOrApiKey };
