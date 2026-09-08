const express = require('express');
const { requireAuth } = require('./requireAuth');
const { requirePlanFeature } = require('./requirePlan');
const db = require('./db');

const router = express.Router();
router.use(requireAuth, requirePlanFeature('webhooks')); // Dev/Owner only, enforced server-side

const VALID_EVENTS = ['build.created','build.started','build.completed','build.failed'];

router.post('/', (req, res) => {
  const { url, events } = req.body || {};
  if(!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'A valid https:// URL is required.' });
  const filteredEvents = (Array.isArray(events) ? events : []).filter(e => VALID_EVENTS.includes(e));
  if(filteredEvents.length === 0) return res.status(400).json({ error: 'At least one valid event is required.', validEvents: VALID_EVENTS });
  const hook = db.createWebhook(req.user.id, url, filteredEvents);
  // The secret is only ever shown once, at creation -- exactly like a real API key.
  res.status(201).json({ id: hook.id, url: hook.url, events: filteredEvents, secret: hook.secret });
});

router.get('/', (req, res) => {
  res.json(db.listWebhooksForUser(req.user.id).map(h => ({
    id: h.id, url: h.url, events: JSON.parse(h.events), createdAt: h.created_at
    // secret intentionally omitted from list responses
  })));
});

router.delete('/:id', (req, res) => {
  db.deleteWebhook(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
