process.env.OWNER_USER_ID = '999999'; // pretend this is YOUR real GitHub numeric ID
process.env.SESSION_SECRET = 'test-secret';

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'vynix.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); // fresh DB per test run
if (fs.existsSync(dbPath+'-wal')) fs.unlinkSync(dbPath+'-wal');
if (fs.existsSync(dbPath+'-shm')) fs.unlinkSync(dbPath+'-shm');

const request = require('supertest');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');

async function loginAs(agent, githubId, githubLogin){
  __setGithubClientForTesting({
    exchangeCodeForToken: async () => 'fake-token-'+githubId,
    getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin })
  });
  // Get the login redirect first so session.oauthState is set on this agent's cookie jar
  const loginRes = await agent.get('/auth/github/login');
  const location = loginRes.headers.location;
  const state = new URL(location).searchParams.get('state');
  const cb = await agent.get(`/auth/github/callback?code=anything&state=${state}`);
  return cb;
}

(async () => {
  console.log('=== TEST 1: Unauthenticated request is rejected ===');
  const anon = await request(app).get('/api/me');
  console.log('Status (expect 401):', anon.status);

  console.log('\n=== TEST 2: The configured OWNER_USER_ID gets Owner, even with plan=free in DB ===');
  const ownerAgent = request.agent(app);
  await loginAs(ownerAgent, '999999', 'the-real-owner');
  const ownerMe = await ownerAgent.get('/api/me');
  console.log('Resolved plan (expect owner):', ownerMe.body.plan);
  console.log('Stored DB plan (expect free -- override, not a DB write):', ownerMe.body.storedPlan);
  console.log('isOwnerOverride flag:', ownerMe.body.isOwnerOverride);

  console.log('\n=== TEST 3: A different, normal user gets FREE, never Owner ===');
  const normalAgent = request.agent(app);
  await loginAs(normalAgent, '111111', 'random-new-user');
  const normalMe = await normalAgent.get('/api/me');
  console.log('Resolved plan (expect free):', normalMe.body.plan);

  console.log('\n=== TEST 4: A user claiming to BE the owner via username, not ID, does NOT get Owner ===');
  const impostorAgent = request.agent(app);
  await loginAs(impostorAgent, '222222', 'the-real-owner'); // same LOGIN NAME as the owner, different numeric ID
  const impostorMe = await impostorAgent.get('/api/me');
  console.log('Resolved plan for username-impostor (expect free, NOT owner):', impostorMe.body.plan);

  console.log('\n=== TEST 5: Missing OWNER_USER_ID -> nobody is Owner, fails safe ===');
  delete process.env.OWNER_USER_ID;
  delete require.cache[require.resolve('./ownerAuth')];
  delete require.cache[require.resolve('./requireAuth')];
  delete require.cache[require.resolve('./server')];
  const appNoOwner = require('./server');
  const noOwnerAgent = request.agent(appNoOwner);
  __setGithubClientForTesting({
    exchangeCodeForToken: async () => 'fake-token',
    getAuthenticatedUser: async () => ({ id: '999999', login: 'the-real-owner' }) // even the "owner" ID
  });
  const loginRes = await noOwnerAgent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await noOwnerAgent.get(`/auth/github/callback?code=x&state=${state}`);
  const noOwnerMe = await noOwnerAgent.get('/api/me');
  console.log('Resolved plan with OWNER_USER_ID unset (expect free, NOT owner):', noOwnerMe.body.plan);

  console.log('\n=== TEST 6: Forged OAuth state is rejected (CSRF protection) ===');
  const csrfAgent = request.agent(app);
  await csrfAgent.get('/auth/github/login'); // sets a real state in session
  const forged = await csrfAgent.get('/auth/github/callback?code=x&state=totally-made-up-state');
  console.log('Status for forged state (expect 400):', forged.status);

  console.log('\nALL CORE TESTS DONE.');
  process.exit(0);
})().catch(e => { console.error('TEST HARNESS ERROR:', e); process.exit(1); });
