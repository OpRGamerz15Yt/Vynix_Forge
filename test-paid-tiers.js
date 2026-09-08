process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'vynix.sqlite');
['','-wal','-shm'].forEach(ext => { if (fs.existsSync(dbPath+ext)) fs.unlinkSync(dbPath+ext); });

const request = require('supertest');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');
const db = require('./db');

async function loginAs(agent, githubId, githubLogin){
  __setGithubClientForTesting({
    exchangeCodeForToken: async () => 'fake-'+githubId,
    getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin })
  });
  const loginRes = await agent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get(`/auth/github/callback?code=x&state=${state}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sampleProject = {
  identity: { launcherName: 'Cloud Test Launcher', version: '0.1.0', publisher: 'Me', description: '', website: '', discord: '' },
  branding: { primaryColor: '#c4632e', accentColor: '#5b7065', textColor: '#ede8e1', icon: null, logo: null, background: null, splash: null },
  layout: { sidebar:true, home:true, news:true, serverSelector:true, profile:true, settings:true, footer:true },
  features: { news:true, serverStatus:true, discord:false, modManager:true, settings:true, updates:true, accountManagement:true },
  minecraft: { version: '1.20.4', loader: 'vanilla', javaRequirement: '', ram: { min: 2048, max: 4096 } }
};

async function pollBuild(agent, buildId, label){
  for(let i=0;i<180;i++){ // up to 6 minutes
    const res = await agent.get(`/api/builds/${buildId}`);
    if(res.body.status==='completed' || res.body.status==='failed'){
      console.log(`[${label}] Final status:`, res.body.status);
      console.log(`[${label}] Progress:`, res.body.progress);
      console.log(`[${label}] Log:`, JSON.stringify(res.body.log, null, 2));
      if(res.body.error) console.log(`[${label}] Error:`, res.body.error);
      return res.body;
    }
    await sleep(2000);
  }
  console.log(`[${label}] TIMED OUT waiting for terminal status`);
  return null;
}

(async () => {
  console.log('=== Setup: PRO user ===');
  const proAgent = request.agent(app);
  await loginAs(proAgent, '777777', 'pro-user');
  const proMe1 = await proAgent.get('/api/me');
  console.log('Initial plan (expect free):', proMe1.body.plan);
  // Simulate what a real Stripe webhook would eventually do -- direct DB
  // grant, since billing isn't implemented yet. This exercises the EXACT
  // same enforcement path a real paid user would hit.
  db.setUserPlan(proMe1.body ? require('./db').getUserByGithubId('777777').id : null, 'pro', 0, 'test setup');
  const proMe2 = await proAgent.get('/api/me');
  console.log('After grant (expect pro):', proMe2.body.plan);

  const proProject = await proAgent.post('/api/projects').send({ name: 'Pro Launcher' });
  console.log('\n=== PRO: request real cloud build ===');
  const cloudReq = await proAgent.post(`/api/builds/cloud/${proProject.body.id}`).send({ project: sampleProject, servers: [] });
  console.log('Request status:', cloudReq.status, cloudReq.body);
  const cloudResult = await pollBuild(proAgent, cloudReq.body.buildId, 'PRO cloud build');

  console.log('\n=== PRO: download the real artifact ===');
  const dl = await proAgent.get(`/api/builds/${cloudReq.body.buildId}/download`)
    .buffer(true).parse((res, cb) => { const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>cb(null,Buffer.concat(chunks))); });
  console.log('Download status:', dl.status, '| bytes:', dl.body ? dl.body.length : 0);
  console.log('Looks like a real ELF binary:', dl.body && dl.body[0]===0x7f && dl.body[1]===0x45);

  console.log('\n=== PRO tries production .exe (should be BLOCKED) ===');
  const exeBlocked = await proAgent.post(`/api/builds/production-exe/${proProject.body.id}`).send({ project: sampleProject, servers: [] });
  console.log('Status (expect 403):', exeBlocked.status);

  console.log('\nDONE WITH PRO. Starting DEV test...\n');

  const devAgent = request.agent(app);
  await loginAs(devAgent, '888888', 'dev-user');
  db.setUserPlan(db.getUserByGithubId('888888').id, 'dev', 0, 'test setup');
  const devProject = await devAgent.post('/api/projects').send({ name: 'Dev Launcher' });

  console.log('=== DEV: request real production .exe ===');
  const exeReq = await devAgent.post(`/api/builds/production-exe/${devProject.body.id}`).send({ project: sampleProject, servers: [] });
  console.log('Request status:', exeReq.status, exeReq.body);
  const exeResult = await pollBuild(devAgent, exeReq.body.buildId, 'DEV production .exe');

  console.log('\n=== DEV: download the real .exe ===');
  const exeDl = await devAgent.get(`/api/builds/${exeReq.body.buildId}/download`)
    .buffer(true).parse((res, cb) => { const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>cb(null,Buffer.concat(chunks))); });
  console.log('Download status:', exeDl.status, '| bytes:', exeDl.body ? exeDl.body.length : 0);
  console.log('Looks like a real PE (MZ header):', exeDl.body && exeDl.body[0]===0x4D && exeDl.body[1]===0x5A);

  console.log('\nALL PAID-TIER TESTS DONE.');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
