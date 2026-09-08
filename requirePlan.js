const { planAllows, getPlan } = require('./plans');

// Usage: router.post('/api/cloud-build', requireAuth, requirePlanFeature('cloudBuild'), handler)
// This is the actual enforcement. The frontend's "🔒 Cloud builds require
// Pro." message is just UI -- this middleware is what makes it real: it
// runs against req.user.plan, which requireAuth already resolved
// server-side (including the Owner override), and nothing the client sends
// in the request body/headers/query string can affect this decision.
function requirePlanFeature(feature){
  return (req, res, next) => {
    if(!req.user){
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if(!planAllows(req.user.plan, feature)){
      const plan = getPlan(req.user.plan);
      return res.status(403).json({
        error: 'plan_restricted',
        feature,
        yourPlan: plan.id,
        message: `This requires a higher plan than ${plan.label}.`
      });
    }
    next();
  };
}

// For admin-only (Owner-only) endpoints.
function requireOwner(req, res, next){
  if(!req.user || req.user.plan !== 'owner'){
    return res.status(403).json({ error: 'owner_only', message: 'This endpoint is restricted to the Owner account.' });
  }
  next();
}

module.exports = { requirePlanFeature, requireOwner };
