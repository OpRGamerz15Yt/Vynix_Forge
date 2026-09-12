process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'vynix.sqlite');
['','-wal','-shm'].forEach(ext => { if (fs.existsSync(dbPath+ext)) fs.unlinkSync(dbPath+ext); });

const request = require('supertest');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');

async function loginAs(agent, githubId, githubLogin){
  __setGithubClientForTesting({
    exchangeCodeForToken: async () => 'fake-'+githubId,
    getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin })
  });
  const loginRes = await agent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get(`/auth/github/callback?code=x&state=${state}`);
}

const sampleProject = {
  identity: { launcherName: 'Test Launcher', version: '0.1.0', publisher: 'Me', description: '', website: '', discord: '' },
  branding: { primaryColor: '#c4632e', accentColor: '#5b7065', textColor: '#ede8e1', icon: null, logo: null, background: null, splash: null },
  layout: { sidebar:true, home:true, news:true, serverSelector:true, profile:true, settings:true, footer:true },
  features: { news:true, serverStatus:true, discord:false, modManager:true, settings:true, updates:true, accountManagement:true },
  minecraft: { version: '1.20.4', loader: 'vanilla', javaRequirement: '', ram: { min: 2048, max: 4096 } }
};

(async () => {
  const agent = request.agent(app);
  await loginAs(agent, '555555', 'free-user');

  console.log('=== TEST: Free user identity ===');
  const me = await agent.get('/api/me');
  console.log('Plan:', me.body.plan, '| maxActiveProjects:', me.body.limits.maxActiveProjects);

  console.log('\n=== TEST: Create first project (should succeed) ===');
  const p1 = await agent.post('/api/projects').send({ name: 'Launcher One' });
  console.log('Status:', p1.status, '| id:', p1.body.id);

  console.log('\n=== TEST: Create second project (Free supports multiple projects) ===');
  const p2 = await agent.post('/api/projects').send({ name: 'Launcher Two' });
  console.log('Status (expect 201):', p2.status, '| id:', p2.body.id);

  console.log('\n=== TEST: Request real source build (should succeed, real zip streamed) ===');
  const sourceRes = await agent.post(`/api/builds/source/${p1.body.id}`)
    .send({ project: sampleProject, servers: [{name:'Main',address:'play.example.net',port:25565,loader:'vanilla',autoConnect:false,isDefault:true}] })
    .buffer(true).parse((res, cb) => { const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>cb(null,Buffer.concat(chunks))); });
  console.log('Status:', sourceRes.status);
  console.log('Content-Type:', sourceRes.headers['content-type']);
  console.log('Zip size (bytes):', sourceRes.body.length);
  console.log('Zip magic bytes correct (PK):', sourceRes.body[0]===0x50 && sourceRes.body[1]===0x4B);

  console.log('\n=== TEST: Free user tries cloud build (should be BLOCKED) ===');
  const cloudRes = await agent.post(`/api/builds/cloud/${p1.body.id}`).send({ project: sampleProject, servers: [] });
  console.log('Status (expect 403):', cloudRes.status, '| error:', cloudRes.body.error, '| message:', cloudRes.body.message);

  console.log('\n=== TEST: Free user tries production .exe (should be BLOCKED) ===');
  const exeRes = await agent.post(`/api/builds/production-exe/${p1.body.id}`).send({ project: sampleProject, servers: [] });
  console.log('Status (expect 403):', exeRes.status, '| error:', exeRes.body.error);

  console.log('\nDONE.');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
