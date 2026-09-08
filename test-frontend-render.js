process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';

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

function rawReq(base, pathname, cookie){
  return new Promise((resolve, reject) => {
    const r = http.request(base+pathname, { method:'GET', headers: cookie?{Cookie:cookie}:{} }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject); r.end();
  });
}

// jsdom has no global fetch, and even if it did, it has no real browser
// cookie-jar<->network integration. This gives the page's own script a
// real, working fetch that behaves like a browser's for THIS test's
// purposes: it reads document.cookie for outgoing requests and stores any
// Set-Cookie it gets back, so the actual app code (which calls plain
// fetch(url, {credentials:'include'})) works unmodified.
function makeCookieAwareFetch(win){
  return async (url, opts={}) => {
    const absoluteUrl = new URL(url, win.location.href).toString();
    const headers = Object.assign({}, opts.headers||{});
    if(win.document.cookie) headers['Cookie'] = win.document.cookie;
    const res = await require('node-fetch')(absoluteUrl, { ...opts, headers, redirect: 'manual' });
    const setCookie = res.headers.raw()['set-cookie'];
    if(setCookie) win.document.cookie = setCookie[0].split(';')[0];
    return res;
  };
}

(async () => {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('=== Load the real page from the real running server, while logged OUT ===');
  const loggedOut = await rawReq(base, '/');
  const dom = new JSDOM(loggedOut.body, {
    runScripts: 'dangerously', resources: 'usable', url: base+'/',
    beforeParse(win){ win.fetch = makeCookieAwareFetch(win); }
  });
  await sleep(500);
  check('Shows login gate (not the dashboard) while logged out', dom.window.document.getElementById('app').innerHTML.includes('Sign in with GitHub'));

  console.log('\n=== Real login flow ===');
  __setGithubClientForTesting({ exchangeCodeForToken: async () => 'tok', getAuthenticatedUser: async () => ({ id: '555999', login: 'render-test-user' }) });
  const loginRes = await rawReq(base, '/auth/github/login');
  const loginCookie = loginRes.headers['set-cookie'][0].split(';')[0];
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cbRes = await rawReq(base, '/auth/github/callback?code=x&state='+state, loginCookie);
  const cookieValue = (cbRes.headers['set-cookie'] ? cbRes.headers['set-cookie'][0].split(';')[0] : loginCookie);

  console.log('\n=== Load the real page again, now authenticated, with a real working fetch ===');
  const loggedIn = await rawReq(base, '/', cookieValue);
  const dom2 = new JSDOM(loggedIn.body, {
    runScripts: 'dangerously', resources: 'usable', url: base+'/',
    beforeParse(win){ win.document.cookie = cookieValue; win.fetch = makeCookieAwareFetch(win); }
  });
  await sleep(700);
  const bodyHtml = dom2.window.document.getElementById('app').innerHTML;
  check('Dashboard renders (not login gate) once authenticated', bodyHtml.includes('Vynix Forge') && !bodyHtml.includes('Sign in with GitHub'));
  check('Real plan badge shown (Free)', bodyHtml.includes('Free'));
  check('Signed-in username shown', bodyHtml.includes('render-test-user'));

  console.log('\n=== Click "New launcher", create one -- real network call, real limit enforcement ===');
  const doc = dom2.window.document;
  const click = (pred) => { const el=[...doc.querySelectorAll('button')].find(pred); if(!el) return false; el.click(); return true; };
  const setVal = (sel, val) => { const el=doc.querySelector(sel); if(!el) return false; el.value=val; el.dispatchEvent(new dom2.window.Event('input',{bubbles:true})); return true; };

  check('New launcher button clicked', click(b=>b.textContent.includes('New launcher')));
  check('Name field set', setVal('#npName', 'Render Test Launcher'));
  click(b=>b.textContent.trim()==='Create launcher');
  await sleep(800);

  check('Now in the project studio (real project id assigned by backend)', doc.body.innerHTML.includes('Launcher studio'));

  console.log('\n=== Build tab -- Free plan shows real lock messaging, not fake buttons ===');
  dom2.window.eval("setState({studioTab:'build'})");
  await sleep(100);
  const buildTabHtml = doc.getElementById('app').innerHTML;
  check('Cloud build shows real lock (Free plan)', buildTabHtml.includes('requires Pro'));
  check('Production .exe shows real lock (Free plan)', buildTabHtml.includes('requires Dev'));
  check('No fake "Connect GitHub" stub button remains', !buildTabHtml.includes('Connect repository'));

  console.log('\n=== Upgrade to Pro server-side, reload, verify UI unlocks for real ===');
  db.setUserPlan(db.getUserByGithubId('555999').id, 'pro', 0, 'test');
  const localStorageSnapshot = dom2.window.localStorage.getItem('vynix_forge_data_v1');
  const reloaded = await rawReq(base, '/', cookieValue);
  const dom3 = new JSDOM(reloaded.body, {
    runScripts: 'dangerously', resources: 'usable', url: base+'/',
    beforeParse(win){
      win.document.cookie = cookieValue;
      win.fetch = makeCookieAwareFetch(win);
      if(localStorageSnapshot) win.localStorage.setItem('vynix_forge_data_v1', localStorageSnapshot); // simulates a real same-origin reload
    }
  });
  await sleep(700);
  const projectId = dom3.window.eval('DB.projects[0] ? DB.projects[0].id : null');
  dom3.window.eval(`setState({route:'studio', studioProjectId: ${JSON.stringify(projectId)}, studioTab:'build'})`);
  await sleep(100);
  const buildTabHtml2 = dom3.window.document.getElementById('app').innerHTML;
  check('Pro plan now shows real "Request cloud build" button', buildTabHtml2.includes('Request cloud build'));
  check('Pro plan still shows lock for production .exe (Dev-only)', buildTabHtml2.includes('requires Dev'));

  server.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail>0?1:0);
})().catch(e => { console.error('HARNESS ERROR:', e.stack); process.exit(1); });
