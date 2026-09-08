const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { getPlan } = require('./plans');
const { requireAuth } = require('./requireAuth');

const router = express.Router();
router.use(requireAuth);

function newId(prefix){ return prefix+'_'+Date.now().toString(36)+crypto.randomBytes(4).toString('hex'); }

router.post('/', (req, res) => {
  const { name } = req.body || {};
  if(!name || typeof name !== 'string' || !name.trim()){
    return res.status(400).json({ error: 'Project name is required.' });
  }
  const plan = getPlan(req.user.plan);
  const activeCount = db.countActiveProjects(req.user.id);
  if(activeCount >= plan.maxActiveProjects){
    return res.status(403).json({
      error: 'plan_restricted',
      feature: 'maxActiveProjects',
      yourPlan: plan.id,
      message: `Your ${plan.label} plan allows ${plan.maxActiveProjects === Infinity ? 'unlimited' : plan.maxActiveProjects} active project(s). You have ${activeCount}. Upgrade to create more.`
    });
  }
  const project = db.createProject(newId('proj'), req.user.id, name.trim());
  res.status(201).json(project);
});

router.get('/', (req, res) => {
  res.json(db.listProjectsForUser(req.user.id));
});

module.exports = router;
