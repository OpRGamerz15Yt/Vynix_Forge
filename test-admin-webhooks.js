process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.STRIPE_SECRET_KEY;

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const dbPath = path.join(__dirname, 'vynix.sqlite');
['','-wal','-shm'].forEach(ext => { if (fs.existsSync(dbPath+ext)) fs.unlinkSync(dbPath+ext); });

const request = require('supertest');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');
const db = require('./db');

async function loginAs(agent, githubId, githubLogin){
  __setGithubClientForTesting({ exchangeCodeForToken: async () => 'fake-'+githubId, getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin }) });
  const loginRes = await agent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get(`/auth/github/callback?code=x&state=${state}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass=0, fail=0;
function check(label, cond){ if(cond){pass++;console.log('PASS:',label);} else {fail++;console.log('FAIL:',label);} }

(async () => {
  const ownerAgent = request.agent(app);
  await loginAs(ownerAgent, '999999', 'the-owner');
  const targetAgent = request.agent(app);
  await loginAs(targetAgent, '424242', 'target-user');

  console.log('=== Admin: search/list users ===');
  const search = await ownerAgent.get('/api/admin/users?q=target');
  check('Search finds the target user', search.body.some(u => u.github_login === 'target-user'));

  console.log('\n=== Admin: view a specific user with usage stats ===');
  const targetDbUser = db.getUserByGithubId('424242');
  const view = await ownerAgent.get(`/api/admin/users/${targetDbUser.id}`);
  check('View returns usage object', view.status === 200 && view.body.usage);
  console.log('Usage:', JSON.stringify(view.body.usage));

  console.log('\n=== Admin: grant Pro, verify audit log message format ===');
  const grant = await ownerAgent.post(`/api/admin/users/${targetDbUser.id}/plan`).send({ plan: 'pro' });
  check('Grant succeeds', grant.status === 200 && grant.body.plan === 'pro');
  const targetMeAfter = await targetAgent.get('/api/me');
  check('Target user immediately sees the new plan', targetMeAfter.body.plan === 'pro');

  const auditLog = await ownerAgent.get('/api/admin/audit-log');
  const entry = auditLog.body[0];
  check('Audit log recorded the change', entry && entry.detail.includes('free -> pro'));
  console.log('Audit entry:', JSON.stringify(entry));

  console.log('\n=== Admin: cannot grant "owner" via this endpoint ===');
  const grantOwnerAttempt = await ownerAgent.post(`/api/admin/users/${targetDbUser.id}/plan`).send({ plan: 'owner' });
  check('Granting "owner" via admin API is rejected', grantOwnerAttempt.status === 400);

  console.log('\n=== Admin: revoke back to free ===');
  const revoke = await ownerAgent.post(`/api/admin/users/${targetDbUser.id}/plan`).send({ plan: 'free' });
  check('Revoke succeeds', revoke.body.plan === 'free');

  console.log('\n=== Admin: usage summary + build log viewing ===');
  const summary = await ownerAgent.get('/api/admin/usage-summary');
  check('Usage summary responds', summary.status === 200 && Array.isArray(summary.body.usersByPlan));

  console.log('\n=== Non-owner (even after being granted pro earlier) cannot touch ANY admin route ===');
  const blocked1 = await targetAgent.get('/api/admin/users');
  const blocked2 = await targetAgent.post(`/api/admin/users/${targetDbUser.id}/plan`).send({ plan: 'dev' });
  check('Non-owner blocked from listing users', blocked1.status === 403);
  check('Non-owner blocked from granting plans (even to themselves)', blocked2.status === 403);
  const targetMeStillFree = await targetAgent.get('/api/me');
  check('Self-grant attempt had no effect', targetMeStillFree.body.plan === 'free');

  console.log('\n=== Real webhook dispatch (Dev tier) with HMAC verification ===');
  const devAgent = request.agent(app);
  await loginAs(devAgent, '535353', 'webhook-dev-user');
  db.setUserPlan(db.getUserByGithubId('535353').id, 'dev', 0, 'test');

  // Spin up a real local HTTP server to receive the webhook
  let received = null;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received = { headers: req.headers, body };
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise(r => receiver.listen(0, r));
  const port = receiver.address().port;
  const receiverUrl = `http://127.0.0.1:${port}/hook`;

  const hookRes = await devAgent.post('/api/webhooks').send({ url: receiverUrl, events: ['build.created','build.completed','build.failed'] });
  check('Webhook created', hookRes.status === 201 && hookRes.body.secret);
  const secret = hookRes.body.secret;

  const sampleProject = {
    identity:{launcherName:'Webhook Test',version:'0.1.0',publisher:'',description:'',website:'',discord:''},
    branding:{primaryColor:'#c4632e',accentColor:'#5b7065',textColor:'#ede8e1',icon:null,logo:null,background:null,splash:null},
    layout:{sidebar:true,home:true,news:true,serverSelector:true,profile:true,settings:true,footer:true},
    features:{news:true,serverStatus:true,discord:false,modManager:true,settings:true,updates:true,accountManagement:true},
    minecraft:{version:'1.20.4',loader:'fabric',javaRequirement:'Java 17+',ram:{min:2048,max:4096}}
  };
  const devProj = await devAgent.post('/api/projects').send({ name: 'Webhook Proj' });
  // Use production-exe with a bad setup path deliberately? No -- just trigger cloud build; we only need build.created to fire quickly.
  await devAgent.post(`/api/builds/cloud/${devProj.body.id}`).send({ project: sampleProject, servers: [] });

  await sleep(1500); // give the fire-and-forget webhook dispatch time to land
  check('Webhook receiver got a real HTTP POST', !!received);
  if(received){
    const sig = received.headers['x-vynix-signature'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(received.body).digest('hex');
    check('HMAC signature is valid and verifiable with the real secret', sig === expected);
    const parsed = JSON.parse(received.body);
    check('Payload event type is build.created', parsed.event === 'build.created');
  }
  receiver.close();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
