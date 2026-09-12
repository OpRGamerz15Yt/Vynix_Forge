const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { getPlan } = require('./plans');
const { requireAuth } = require('./requireAuth');

const router = express.Router();
router.use(requireAuth);

function newId(prefix){ return prefix+'_'+Date.now().toString(36)+crypto.randomBytes(4).toString('hex'); }

function publicProject(row){
  if(!row) return null;
  let config = null;
  try{ config = row.config_json ? JSON.parse(row.config_json) : null; }catch(e){ config = null; }
  const { config_json, ...project } = row;
  return { ...project, config };
}

router.post('/', (req, res) => {
  const { name, description, config } = req.body || {};
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
  if(description !== undefined && (typeof description !== 'string' || description.length > 2000)){
    return res.status(400).json({ error: 'Description must be a string of 2,000 characters or fewer.' });
  }
  const project = db.createProject(newId('proj'), req.user.id, name.trim(), description || '', config || null);
  res.status(201).json(publicProject(project));
});

router.get('/', (req, res) => {
  res.json(db.listProjectsForUser(req.user.id).map(publicProject));
});

router.patch('/:id', (req, res) => {
  const existing = db.getProject(req.params.id);
  if(!existing || existing.user_id !== req.user.id){
    return res.status(404).json({ error: 'Project not found.' });
  }
  const { name, description, config, archived } = req.body || {};
  if(name !== undefined && (typeof name !== 'string' || !name.trim())){
    return res.status(400).json({ error: 'Project name is required.' });
  }
  if(description !== undefined && (typeof description !== 'string' || description.length > 2000)){
    return res.status(400).json({ error: 'Description must be a string of 2,000 characters or fewer.' });
  }
  if(archived !== undefined && typeof archived !== 'boolean'){
    return res.status(400).json({ error: 'Archived must be a boolean.' });
  }
  const updated = db.updateProject(req.params.id, req.user.id, {
    name: name === undefined ? undefined : name.trim(), description, config, archived: archived === undefined ? undefined : (archived ? 1 : 0)
  });
  res.json(publicProject(updated));
});

router.delete('/:id', (req, res) => {
  const deleted = db.deleteProject(req.params.id, req.user.id);
  if(!deleted) return res.status(404).json({ error: 'Project not found.' });
  res.status(204).end();
});

module.exports = router;
