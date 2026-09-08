const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const archiver = require('archiver');
const db = require('./db');
const { getPlan } = require('./plans');
const { requireAuthOrApiKey } = require('./requireAuth');
const { requirePlanFeature } = require('./requirePlan');
const buildWorker = require('./buildWorker');
const { generateFiles } = require('./electronTemplate');
const { dispatchEvent } = require('./webhookDispatch');

const router = express.Router();
router.use(requireAuthOrApiKey);

function newId(prefix){ return prefix+'_'+Date.now().toString(36)+crypto.randomBytes(4).toString('hex'); }

function checkDailyLimit(req, res, next){
  const plan = getPlan(req.user.plan);
  const used = db.countBuildsToday(req.user.id);
  if(used >= plan.maxBuildsPerDay){
    return res.status(429).json({
      error: 'rate_limited',
      message: `Your ${plan.label} plan allows ${plan.maxBuildsPerDay === Infinity ? 'unlimited' : plan.maxBuildsPerDay} builds per day. You've used ${used}. This limit exists even on unlimited-feeling plans to protect shared build infrastructure from abuse.`
    });
  }
  next();
}

function loadProjectOr404(req, res){
  const project = db.getProject(req.params.projectId || req.body.projectId);
  if(!project || project.user_id !== req.user.id){
    res.status(404).json({ error: 'Project not found.' });
    return null;
  }
  return project;
}

// ---- FREE (and everyone): generate + download real source, no compiling ----
router.post('/source/:projectId', checkDailyLimit, async (req, res) => {
  const project = loadProjectOr404(req, res); if(!project) return;
  const fullProject = req.body.project;
  const servers = req.body.servers || [];
  if(!fullProject || !fullProject.identity || !fullProject.minecraft){
    return res.status(400).json({ error: 'Request must include the full project config.' });
  }
  const buildId = newId('build');
  db.createBuild(buildId, req.user.id, project.id, 'source');
  try{
    const { files, slug } = generateFiles(fullProject, servers);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-source.zip"`);
    const archive = archiver('zip');
    archive.pipe(res);
    for(const [rel, content] of Object.entries(files)) archive.append(content, { name: rel });
    await archive.finalize();
    db.completeBuildWithArtifact(buildId, 'inline-stream', 1);
    db.appendBuildLog(buildId, 'Source project streamed directly to the client (no server-side compiling for this tier).');
  }catch(e){
    db.failBuild(buildId, e.message);
    if(!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ---- PRO: real cloud build ----
router.post('/cloud/:projectId', requirePlanFeature('cloudBuild'), checkDailyLimit, (req, res) => {
  const project = loadProjectOr404(req, res); if(!project) return;
  const fullProject = req.body.project;
  const servers = req.body.servers || [];
  if(!fullProject) return res.status(400).json({ error: 'Request must include the full project config.' });

  const buildId = newId('build');
  db.createBuild(buildId, req.user.id, project.id, 'cloud');
  dispatchEvent(req.user.id, 'build.created', { buildId, kind: 'cloud' });
  buildWorker.enqueue({ buildId, userId: req.user.id, project: fullProject, servers, kind: 'cloud' });
  res.status(202).json({ buildId, status: 'queued' });
});

// ---- DEV: real production Windows .exe ----
router.post('/production-exe/:projectId', requirePlanFeature('productionExe'), checkDailyLimit, (req, res) => {
  const project = loadProjectOr404(req, res); if(!project) return;
  const fullProject = req.body.project;
  const servers = req.body.servers || [];
  if(!fullProject) return res.status(400).json({ error: 'Request must include the full project config.' });

  const buildId = newId('build');
  db.createBuild(buildId, req.user.id, project.id, 'production_exe');
  dispatchEvent(req.user.id, 'build.created', { buildId, kind: 'production_exe' });
  buildWorker.enqueue({ buildId, userId: req.user.id, project: fullProject, servers, kind: 'production_exe' });
  res.status(202).json({ buildId, status: 'queued' });
});

// ---- Status polling (all plans) ----
router.get('/:buildId', (req, res) => {
  const build = db.getBuild(req.params.buildId);
  if(!build || build.user_id !== req.user.id) return res.status(404).json({ error: 'Build not found.' });
  res.json({
    id: build.id, kind: build.kind, status: build.status, progress: build.progress,
    error: build.error, log: JSON.parse(build.log||'[]'),
    createdAt: build.created_at, startedAt: build.started_at, completedAt: build.completed_at,
    downloadReady: build.status === 'completed' && build.kind !== 'source'
  });
});

router.get('/', (req, res) => {
  res.json(db.listBuildsForUser(req.user.id).map(b => ({
    id: b.id, kind: b.kind, status: b.status, progress: b.progress, error: b.error,
    createdAt: b.created_at, completedAt: b.completed_at
  })));
});

// ---- Real artifact download -- re-verifies the file on disk every time ----
router.get('/:buildId/download', (req, res) => {
  const build = db.getBuild(req.params.buildId);
  if(!build || build.user_id !== req.user.id) return res.status(404).json({ error: 'Build not found.' });
  if(build.status !== 'completed') return res.status(409).json({ error: 'Build is not completed yet.' });
  if(build.kind === 'source') return res.status(409).json({ error: 'Source builds stream directly and are not stored for re-download.' });
  if(!build.artifact_path || !fs.existsSync(build.artifact_path)){
    return res.status(410).json({ error: 'Artifact no longer exists on disk.' });
  }
  const stat = fs.statSync(build.artifact_path);
  if(stat.size === 0) return res.status(410).json({ error: 'Artifact file is empty -- refusing to serve it.' });
  res.download(build.artifact_path);
});

module.exports = router;
