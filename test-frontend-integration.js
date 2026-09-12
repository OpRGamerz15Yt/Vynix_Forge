process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.STRIPE_SECRET_KEY;

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'vynix.sqlite');
['','-wal','-shm'].forEach(ext => { if (fs.existsSync(dbPath+ext)) fs.unlinkSync(dbPath+ext); });

const http = require('http');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');
const { JSDOM } = require('jsdom');
const db = require('./db');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
function check(label, cond){ if(cond){pass++;console.log('PASS:',label);} else {fail++;console.log('FAIL:',label);} }

(async () => {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ---- Fetch the page while logged out -- expect the login gate ----
  const dom = new JSDOM('', { runScripts: 'dangerously', resources: 'usable', url: base+'/' });
  // jsdom's fetch/cookie handling across real network calls is limited, so
  // drive this with real Node http + a manual cookie jar instead -- this
  // exercises the REAL server the same way a browser would.
  let cookie = '';
  function req(pathname, opts={}){
    return new Promise((resolve, reject) => {
      const r = http.request(base+pathname, { method: opts.method||'GET', headers: { ...(opts.headers||{}), ...(cookie?{Cookie:cookie}:{}) } }, (res) => {
        if(res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
      if(opts.body) r.write(opts.body);
      r.end();
    });
  }

  console.log('=== Logged-out root request still serves index.html (auth gate is client-side) ===');
  const loggedOutRoot = await req('/');
  check('Root returns 200 (static file always serves)', loggedOutRoot.status === 200);
  check('Contains the app shell', loggedOutRoot.body.toString().includes('id="app"'));

  console.log('\n=== /api/me correctly 401s before login ===');
  const meBefore = await req('/api/me');
  check('401 before login', meBefore.status === 401);

  console.log('\n=== Real OAuth login flow ===');
  __setGithubClientForTesting({
    exchangeCodeForToken: async () => 'fake-token',
    getAuthenticatedUser: async () => ({ id: '424242', login: 'integration-tester' })
  });
  const loginRedirect = await req('/auth/github/login');
  const state = new URL(loginRedirect.headers.location).searchParams.get('state');
  await req(`/auth/github/callback?code=x&state=${state}`);
  const meAfter = await req('/api/me');
  const meBody = JSON.parse(meAfter.body.toString());
  check('Logged in, plan resolved', meAfter.status === 200 && meBody.plan === 'free');

  console.log('\n=== Create project via real API (as the frontend now does) ===');
  const createRes = await req('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: 'Integration Test Launcher' }) });
  const createBody = JSON.parse(createRes.body.toString());
  check('Project created', createRes.status === 201 && createBody.id);

  console.log('\n=== Free plan supports multiple projects via the same API the frontend calls ===');
  const secondProj = await req('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: 'Second' }) });
  check('Second project created', secondProj.status === 201);

  console.log('\n=== Real source build via the endpoint the frontend now calls ===');
  const sampleProject = {
    identity:{launcherName:'Integration Test Launcher',version:'0.1.0',publisher:'',description:'',website:'',discord:''},
    branding:{primaryColor:'#c4632e',accentColor:'#5b7065',textColor:'#ede8e1',icon:null,logo:null,background:null,splash:null},
    layout:{sidebar:true,home:true,news:true,serverSelector:true,profile:true,settings:true,footer:true},
    features:{news:true,serverStatus:true,discord:false,modManager:true,settings:true,updates:true,accountManagement:true},
    minecraft:{version:'1.20.4',loader:'vanilla',javaRequirement:'',ram:{min:2048,max:4096}}
  };
  const sourceRes = await req(`/api/builds/source/${createBody.id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project: sampleProject, servers: [] }) });
  check('Source build returns a real zip', sourceRes.status===200 && sourceRes.body[0]===0x50 && sourceRes.body[1]===0x4B);

  console.log('\n=== Cloud build correctly blocked for free plan via the endpoint the frontend calls ===');
  const cloudRes = await req(`/api/builds/cloud/${createBody.id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project: sampleProject, servers: [] }) });
  check('Cloud build blocked (403 plan_restricted)', cloudRes.status === 403 && JSON.parse(cloudRes.body.toString()).error === 'plan_restricted');

  console.log('\n=== Upgrade to Pro, then cloud build works via the SAME endpoint ===');
  db.setUserPlan(db.getUserByGithubId('424242').id, 'pro', 0, 'test');
  const cloudRes2 = await req(`/api/builds/cloud/${createBody.id}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project: sampleProject, servers: [] }) });
  check('Cloud build accepted after upgrade (202)', cloudRes2.status === 202);
  const buildId = JSON.parse(cloudRes2.body.toString()).buildId;

  console.log('\n=== Poll status the same way the frontend\'s pollRemoteBuild() does ===');
  let finalStatus = null;
  for(let i=0;i<150;i++){
    const s = await req(`/api/builds/${buildId}`);
    const sb = JSON.parse(s.body.toString());
    if(sb.status==='completed' || sb.status==='failed'){ finalStatus = sb; break; }
    await sleep(2000);
  }
  check('Real cloud build reaches a terminal state', finalStatus && (finalStatus.status==='completed'||finalStatus.status==='failed'));
  console.log('Final status:', finalStatus && finalStatus.status, finalStatus && finalStatus.error);

  if(finalStatus && finalStatus.status === 'completed'){
    const dl = await req(`/api/builds/${buildId}/download`);
    check('Download returns real ELF binary', dl.status===200 && dl.body[0]===0x7f && dl.body[1]===0x45);
  }

  console.log('\n=== Billing checkout correctly refuses (not configured) rather than faking ===');
  const checkoutRes = await req('/api/billing/checkout/pro', { method:'POST' });
  check('Checkout returns billing_not_configured, not a fake success', checkoutRes.status===501 && JSON.parse(checkoutRes.body.toString()).error==='billing_not_configured');

  server.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail>0?1:0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
