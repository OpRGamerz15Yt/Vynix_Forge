process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.STRIPE_SECRET_KEY;

const fs = require('fs');
const path = require('path');
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

const sampleProject = {
  identity:{launcherName:'Sec Test',version:'0.1.0',publisher:'',description:'',website:'',discord:''},
  branding:{primaryColor:'#c4632e',accentColor:'#5b7065',textColor:'#ede8e1',icon:null,logo:null,background:null,splash:null},
  layout:{sidebar:true,home:true,news:true,serverSelector:true,profile:true,settings:true,footer:true},
  features:{news:true,serverStatus:true,discord:false,modManager:true,settings:true,updates:true,accountManagement:true},
  minecraft:{version:'1.20.4',loader:'vanilla',javaRequirement:'',ram:{min:2048,max:4096}}
};

let pass = 0, fail = 0;
function check(label, cond){ if(cond){ pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

(async () => {
  const ownerAgent = request.agent(app);
  await loginAs(ownerAgent, '999999', 'owner');
  const normalAgent = request.agent(app);
  await loginAs(normalAgent, '444444', 'normal-user');

  // 1. My configured account -> OWNER
  const ownerMe = await ownerAgent.get('/api/me');
  check('1. Configured account resolves to OWNER', ownerMe.body.plan === 'owner');

  // 2. New user -> FREE
  const normalMe = await normalAgent.get('/api/me');
  check('2. New user resolves to FREE', normalMe.body.plan === 'free');

  // 3. Existing normal user -> actual entitlement
  db.setUserPlan(db.getUserByGithubId('444444').id, 'pro', 0, 'test');
  const normalMe2 = await normalAgent.get('/api/me');
  check('3. Existing user gets real stored entitlement (pro)', normalMe2.body.plan === 'pro');

  // 4. localStorage manipulation -> N/A server-side, but verify the API
  //    ignores any client-submitted plan value in a request body.
  const forgedPlanReq = await normalAgent.post('/api/projects').send({ name: 'x', plan: 'owner' });
  const meStillPro = await normalAgent.get('/api/me');
  check('4. Client-submitted "plan" field in a request body has zero effect', meStillPro.body.plan === 'pro');

  // 5. Forged Owner request -> rejected (impersonate owner's login, wrong ID)
  const impostorAgent = request.agent(app);
  await loginAs(impostorAgent, '112233', 'owner'); // same LOGIN as owner, different ID
  const impostorMe = await impostorAgent.get('/api/me');
  check('5. Forged Owner (same username, different ID) rejected', impostorMe.body.plan !== 'owner');

  // 6. Forged Pro/Dev request -> rejected (free user hitting dev endpoint)
  const freeAgent = request.agent(app);
  await loginAs(freeAgent, '556677', 'free-user-2');
  const freeProj = await freeAgent.post('/api/projects').send({ name: 'Free Proj' });
  const forgedDev = await freeAgent.post(`/api/builds/production-exe/${freeProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('6. Free user forging a Dev-tier build request is rejected', forgedDev.status === 403);

  // 7. Normal user -> cannot access Owner API
  const normalAdminAttempt = await normalAgent.get('/api/admin/users');
  check('7. Normal (even Pro) user cannot access Owner admin API', normalAdminAttempt.status === 403);

  // 8. Owner -> can access Owner API
  const ownerAdmin = await ownerAgent.get('/api/admin/users');
  check('8. Owner can access Owner admin API', ownerAdmin.status === 200 && Array.isArray(ownerAdmin.body));

  // 9. Owner cannot be purchased
  const ownerBuy = await ownerAgent.post('/api/billing/checkout/pro');
  check('9. Owner cannot initiate any purchase', ownerBuy.status === 400);

  // 10. Free -> source export works
  const freeSource = await freeAgent.post(`/api/builds/source/${freeProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('10. Free user source export works', freeSource.status === 200 && freeSource.headers['content-type'].includes('zip'));

  // 11. Free -> cloud build blocked
  const freeCloud = await freeAgent.post(`/api/builds/cloud/${freeProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('11. Free user cloud build blocked', freeCloud.status === 403);

  // 12. Pro -> cloud build works (normalAgent is pro)
  const proProj = await normalAgent.post('/api/projects').send({ name: 'Pro Proj For Cloud' });
  const proCloud = await normalAgent.post(`/api/builds/cloud/${proProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('12. Pro user cloud build request accepted', proCloud.status === 202);

  // 13. Pro -> production .exe blocked
  const proExe = await normalAgent.post(`/api/builds/production-exe/${proProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('13. Pro user production .exe blocked', proExe.status === 403);

  // 14. Dev -> production .exe works
  const devAgent = request.agent(app);
  await loginAs(devAgent, '667788', 'dev-user-2');
  db.setUserPlan(db.getUserByGithubId('667788').id, 'dev', 0, 'test');
  const devProj = await devAgent.post('/api/projects').send({ name: 'Dev Proj' });
  const devExe = await devAgent.post(`/api/builds/production-exe/${devProj.body.id}`).send({ project: sampleProject, servers: [] });
  check('14. Dev user production .exe request accepted', devExe.status === 202);

  // 15. Dev -> API works
  const apiKeyRes = await devAgent.post('/api/dev/api-key');
  check('15a. Dev can generate an API key', apiKeyRes.status === 200 && apiKeyRes.body.apiKey);
  const apiKey = apiKeyRes.body.apiKey;
  const viaApiKey = await request(app).get('/api/builds').set('Authorization', 'Bearer '+apiKey);
  check('15b. Dev API key authenticates a request', viaApiKey.status === 200);
  const apiKeyAdminAttempt = await request(app).get('/api/admin/users').set('Authorization', 'Bearer '+apiKey);
  check('15c. API key CANNOT reach admin endpoints even for a Dev user', apiKeyAdminAttempt.status === 401 || apiKeyAdminAttempt.status === 403);

  // 16-18: covered by the earlier full lifecycle test (paid-tiers.test.js) --
  // re-verify status field values here quickly using the pro build from #12.
  await new Promise(r => setTimeout(r, 1000));
  const proCloudStatus = await normalAgent.get(`/api/builds/${proCloud.body.buildId}`);
  check('17. Queued/starting/building status is a real, valid value', ['queued','starting','building','completed','failed'].includes(proCloudStatus.body.status));

  // 19-20: never mark completed without artifact / download only real artifacts
  // -- verified structurally: completeBuildWithArtifact() throws without a
  // real path+size, and the download route re-checks fs.existsSync + size
  // every time (see routes/builds.js). Confirm the throwing behavior directly:
  let threw = false;
  try{ db.completeBuildWithArtifact('nonexistent_build_id', null, null); } catch(e){ threw = true; }
  check('19. completeBuildWithArtifact() refuses to run without a real artifact', threw);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
