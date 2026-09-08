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
  __setGithubClientForTesting({ exchangeCodeForToken: async () => 'fake-'+githubId, getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin }) });
  const loginRes = await agent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get(`/auth/github/callback?code=x&state=${state}`);
}

(async () => {
  const ownerAgent = request.agent(app);
  await loginAs(ownerAgent, '999999', 'the-owner');

  console.log('=== Owner never appears in DB as "owner" (only the override matters) ===');
  const dbRow = db.getUserByGithubId('999999');
  console.log('Stored plan in DB (expect free, never mutated):', dbRow.plan);

  console.log('\n=== Owner creates unlimited projects ===');
  for(let i=0;i<3;i++){
    const p = await ownerAgent.post('/api/projects').send({ name: 'Owner Project '+i });
    console.log(`Project ${i} status:`, p.status);
  }

  console.log('\n=== Owner can request production .exe despite storedPlan=free ===');
  const sampleProject = {
    identity:{launcherName:'Owner Launcher',version:'0.1.0',publisher:'',description:'',website:'',discord:''},
    branding:{primaryColor:'#c4632e',accentColor:'#5b7065',textColor:'#ede8e1',icon:null,logo:null,background:null,splash:null},
    layout:{sidebar:true,home:true,news:true,serverSelector:true,profile:true,settings:true,footer:true},
    features:{news:true,serverStatus:true,discord:false,modManager:true,settings:true,updates:true,accountManagement:true},
    minecraft:{version:'1.20.4',loader:'vanilla',javaRequirement:'',ram:{min:2048,max:4096}}
  };
  const projects = await ownerAgent.get('/api/projects');
  const exeReq = await ownerAgent.post(`/api/builds/production-exe/${projects.body[0].id}`).send({ project: sampleProject, servers: [] });
  console.log('Request status (expect 202, not 403):', exeReq.status, exeReq.body);

  console.log('\nDONE.');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
