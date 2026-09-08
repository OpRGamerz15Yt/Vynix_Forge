const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'vynix.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT UNIQUE NOT NULL,      -- GitHub's numeric user ID -- immutable, unlike username
  github_login TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',   -- free | pro | dev | owner -- NEVER trust a client-submitted value into this column
  api_key_hash TEXT,                   -- sha256 of the Dev-tier API key; the raw key is never stored
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,                  -- pro | dev (free/owner are never real Stripe subscriptions)
  currency TEXT NOT NULL DEFAULT 'USD',-- the currency this subscription was actually billed in
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,                -- active | past_due | canceled | incomplete
  billing_period TEXT,                 -- e.g. 'monthly'
  current_period_start INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                  -- 'source' | 'cloud' | 'production_exe'
  status TEXT NOT NULL DEFAULT 'queued', -- queued | starting | building | completed | failed
  progress INTEGER DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]',      -- JSON array of real milestone messages
  error TEXT,
  artifact_path TEXT,                  -- real filesystem path, only set once the file genuinely exists
  artifact_size INTEGER,
  github_run_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,                -- used to HMAC-sign outgoing payloads so receivers can verify authenticity
  events TEXT NOT NULL,                -- JSON array, e.g. ["build.completed","build.failed"]
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

function now(){ return Date.now(); }

// ===== Users =====
// This is the ONLY place a user's plan can change server-side. Every caller
// must go through here (Stripe webhook, admin grant, or the Owner check at
// login) -- never a raw UPDATE from request-body input elsewhere.
function upsertUserFromGitHub(githubId, githubLogin){
  const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(githubId));
  if(existing){
    db.prepare('UPDATE users SET github_login=?, updated_at=? WHERE id=?').run(githubLogin, now(), existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const info = db.prepare('INSERT INTO users (github_id, github_login, plan, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(String(githubId), githubLogin, 'free', now(), now()); // every new user defaults to free -- no exceptions
  return db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
}

function getUserById(id){ return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function getUserByGithubId(githubId){ return db.prepare('SELECT * FROM users WHERE github_id=?').get(String(githubId)); }

function setUserPlan(userId, plan, actorUserId, reason){
  const before = getUserById(userId);
  db.prepare('UPDATE users SET plan=?, updated_at=? WHERE id=?').run(plan, now(), userId);
  logAdminAction(actorUserId, 'plan_change', userId, `${before.plan} -> ${plan}${reason ? ' ('+reason+')' : ''}`);
  return getUserById(userId);
}

// ===== Admin audit log =====
function logAdminAction(actorUserId, action, targetUserId, detail){
  db.prepare('INSERT INTO admin_audit_log (actor_user_id, action, target_user_id, detail, created_at) VALUES (?,?,?,?,?)')
    .run(actorUserId, action, targetUserId||null, detail||null, now());
}
function listAdminAuditLog(limit){
  return db.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?').all(limit||100);
}

// ===== Projects =====
function countActiveProjects(userId){
  return db.prepare('SELECT COUNT(*) c FROM projects WHERE user_id=? AND archived=0').get(userId).c;
}
function createProject(id, userId, name){
  db.prepare('INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,userId,name,now(),now());
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id);
}
function getProject(id){ return db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
function listProjectsForUser(userId){ return db.prepare('SELECT * FROM projects WHERE user_id=?').all(userId); }

// ===== Builds =====
function countBuildsToday(userId){
  const since = now() - 24*60*60*1000;
  return db.prepare('SELECT COUNT(*) c FROM builds WHERE user_id=? AND created_at > ?').get(userId, since).c;
}
function createBuild(id, userId, projectId, kind){
  db.prepare('INSERT INTO builds (id,user_id,project_id,kind,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, projectId, kind, 'queued', now());
  return getBuild(id);
}
function getBuild(id){ return db.prepare('SELECT * FROM builds WHERE id=?').get(id); }
function listBuildsForUser(userId){ return db.prepare('SELECT * FROM builds WHERE user_id=? ORDER BY created_at DESC').all(userId); }
function updateBuild(id, patch){
  const fields = Object.keys(patch);
  if(fields.length===0) return getBuild(id);
  const setClause = fields.map(f=>`${f}=?`).join(', ');
  db.prepare(`UPDATE builds SET ${setClause} WHERE id=?`).run(...fields.map(f=>patch[f]), id);
  return getBuild(id);
}
// Hard safety net matching the spec: a build can only be marked completed if
// it is passed a real, non-empty artifact_path/size at the same time -- this
// function is the ONLY way to mark a build completed anywhere in the codebase.
function completeBuildWithArtifact(id, artifactPath, artifactSize){
  if(!artifactPath || !artifactSize || artifactSize <= 0){
    throw new Error('Refusing to mark build completed: no real artifact was provided.');
  }
  return updateBuild(id, { status:'completed', progress:100, artifact_path:artifactPath, artifact_size:artifactSize, completed_at: now() });
}
function failBuild(id, error){
  return updateBuild(id, { status:'failed', error, completed_at: now() });
}

// Startup sweep -- same reasoning as the frontend fix: a build left in a
// non-terminal state from a previous process crash/restart can never
// resume, so it must never be shown as permanently "queued"/"building".
function sweepInterruptedBuilds(){
  const stuck = db.prepare(`SELECT id FROM builds WHERE status IN ('queued','starting','building')`).all();
  const stmt = db.prepare(`UPDATE builds SET status='failed', error=?, completed_at=? WHERE id=?`);
  stuck.forEach(b => stmt.run('Interrupted: the build server restarted before this build finished.', now(), b.id));
  return stuck.length;
}

// ===== Webhooks (Dev tier) =====
function createWebhook(userId, url, events){
  const secret = crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO webhooks (user_id,url,secret,events,created_at) VALUES (?,?,?,?,?)')
    .run(userId, url, secret, JSON.stringify(events), now());
  return db.prepare('SELECT * FROM webhooks WHERE id=?').get(info.lastInsertRowid);
}
function listWebhooksForUser(userId){ return db.prepare('SELECT * FROM webhooks WHERE user_id=?').all(userId); }
function deleteWebhook(id, userId){ db.prepare('DELETE FROM webhooks WHERE id=? AND user_id=?').run(id, userId); }
function webhooksForEvent(userId, event){
  return listWebhooksForUser(userId).filter(w => JSON.parse(w.events).includes(event));
}

function appendBuildLog(id, line){
  const build = getBuild(id);
  if(!build) return;
  const log = JSON.parse(build.log || '[]');
  log.push(line);
  updateBuild(id, { log: JSON.stringify(log.slice(-100)) });
}

module.exports = {
  db,
  upsertUserFromGitHub, getUserById, getUserByGithubId, setUserPlan,
  logAdminAction, listAdminAuditLog,
  countActiveProjects, createProject, getProject, listProjectsForUser,
  countBuildsToday, createBuild, getBuild, listBuildsForUser, updateBuild, appendBuildLog,
  completeBuildWithArtifact, failBuild, sweepInterruptedBuilds,
  createWebhook, listWebhooksForUser, deleteWebhook, webhooksForEvent
};
