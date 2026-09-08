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

  __setGithubClientForTesting({ exchangeCodeForToken: async () => 'tok', getAuthenticatedUser: async () => ({ id: '909090', login: 'currency-ui-tester' }) });
  const loginRes = await rawReq(base, '/auth/github/login');
  const loginCookie = loginRes.headers['set-cookie'][0].split(';')[0];
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cbRes = await rawReq(base, '/auth/github/callback?code=x&state='+state, loginCookie);
  const cookieValue = cbRes.headers['set-cookie'] ? cbRes.headers['set-cookie'][0].split(';')[0] : loginCookie;

  const page = await rawReq(base, '/', cookieValue);
  const dom = new JSDOM(page.body, {
    runScripts: 'dangerously', resources: 'usable', url: base+'/',
    beforeParse(win){ win.document.cookie = cookieValue; win.fetch = makeCookieAwareFetch(win); }
  });
  await sleep(700);

  console.log('=== Navigate to Settings > Billing ===');
  dom.window.eval("setState({route:'settings', settingsSection:'Billing'})");
  await sleep(600); // allow the async pricing fetch to land
  const doc = dom.window.document;
  let html = doc.getElementById('app').innerHTML;

  check('Shows USD price for Pro by default', html.includes('$4.99/month'));
  check('Shows currency selector (USD/BDT tabs)', html.includes('>USD<') && html.includes('>BDT<'));
  check('Real usage numbers shown', html.includes('Active projects:'));

  console.log('\n=== Switch to BDT ===');
  const click = (pred) => { const el=[...doc.querySelectorAll('button')].find(pred); if(!el) return false; el.click(); return true; };
  check('BDT tab clicked', click(b=>b.textContent.trim()==='BDT'));
  await sleep(100);
  html = doc.getElementById('app').innerHTML;
  check('Shows BDT price for Pro (৳500/month)', html.includes('\u09f3500/month'));
  check('Shows BDT price for Dev (৳1,000/month)', html.includes('\u09f31,000/month'));
  check('Shows honest "not connected to real payment" note (no Stripe configured)', html.includes("isn't connected to a real payment yet") || html.includes('informational'));

  server.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail>0?1:0);
})().catch(e => { console.error('HARNESS ERROR:', e.stack); process.exit(1); });
