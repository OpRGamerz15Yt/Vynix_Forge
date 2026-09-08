process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_PRICE_ID_PRO_USD;
delete process.env.STRIPE_PRICE_ID_PRO_BDT;

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, 'vynix.sqlite');
['','-wal','-shm'].forEach(ext => { if (fs.existsSync(dbPath+ext)) fs.unlinkSync(dbPath+ext); });

const request = require('supertest');
const app = require('./server');
const { __setGithubClientForTesting } = require('./auth');
const { formatPrice } = require('./plans');
const db = require('./db');

async function loginAs(agent, githubId, githubLogin){
  __setGithubClientForTesting({ exchangeCodeForToken: async () => 'fake-'+githubId, getAuthenticatedUser: async () => ({ id: githubId, login: githubLogin }) });
  const loginRes = await agent.get('/auth/github/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get(`/auth/github/callback?code=x&state=${state}`);
}

let pass=0, fail=0;
function check(label, cond){ if(cond){pass++;console.log('PASS:',label);} else {fail++;console.log('FAIL:',label);} }

(async () => {
  console.log('=== Price formatting matches the spec exactly ===');
  check('FREE USD', formatPrice('free','USD') === '$0/month');
  check('FREE BDT', formatPrice('free','BDT') === '\u09f30/month');
  check('PRO USD', formatPrice('pro','USD') === '$4.99/month');
  check('PRO BDT', formatPrice('pro','BDT') === '\u09f3500/month');
  check('DEV USD', formatPrice('dev','USD') === '$9.99/month');
  check('DEV BDT', formatPrice('dev','BDT') === '\u09f31,000/month');
  check('OWNER USD (never numeric)', formatPrice('owner','USD') === '$\u221e/sec');
  check('OWNER BDT (never numeric)', formatPrice('owner','BDT') === '\u09f3\u221e/sec');

  console.log('\n=== Public pricing endpoint (no auth needed) ===');
  const plansRes = await request(app).get('/api/billing/plans');
  check('Plans endpoint accessible without login', plansRes.status === 200);
  check('Lists both currencies', JSON.stringify(plansRes.body.currencies) === JSON.stringify(['USD','BDT']));
  check('Owner not purchasable in the public listing', plansRes.body.plans.owner.purchasable === false);
  console.log('Sample:', JSON.stringify(plansRes.body.plans.pro));

  const agent = request.agent(app);
  await loginAs(agent, '111222', 'currency-tester');

  console.log('\n=== Checkout in BDT with no BDT Stripe Price configured -- must refuse clearly, not fake ===');
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_PRICE_ID_PRO_USD = 'price_fake_usd';
  // Deliberately leaving STRIPE_PRICE_ID_PRO_BDT unset
  delete require.cache[require.resolve('./plans')];

  const bdtCheckout = await agent.post('/api/billing/checkout/pro').send({ currency: 'BDT' });
  check('BDT checkout refused with currency_not_supported (not faked)', bdtCheckout.status === 501 && bdtCheckout.body.error === 'currency_not_supported_by_payment_provider');
  console.log('Message:', bdtCheckout.body.message);

  console.log('\n=== Invalid currency rejected outright ===');
  const badCurrency = await agent.post('/api/billing/checkout/pro').send({ currency: 'XYZ' });
  check('Unsupported currency code rejected', badCurrency.status === 400 && badCurrency.body.error === 'unsupported_currency');

  console.log('\n=== Currency selection never affects plan permissions on its own ===');
  const meBefore = await agent.get('/api/me');
  check('Still free after failed BDT/invalid attempts', meBefore.body.plan === 'free');

  console.log('\n=== Real webhook with BDT metadata stores currency correctly ===');
  const Stripe = require('stripe');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const targetUser = db.getUserByGithubId('111222');
  const payload = JSON.stringify({
    id:'evt_bdt_1', type:'checkout.session.completed',
    data:{ object: { client_reference_id:String(targetUser.id), customer:'cus_x', subscription:'sub_x',
      metadata:{ vynixUserId:String(targetUser.id), targetPlan:'pro', currency:'BDT' } } }
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const webhookRes = await request(app).post('/api/billing/webhook').set('Content-Type','application/json').set('stripe-signature', header).send(payload);
  check('Webhook accepted', webhookRes.status === 200);
  const subRow = db.db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(targetUser.id);
  check('Subscription stored with currency=BDT', subRow && subRow.currency === 'BDT');
  const meAfter = await agent.get('/api/me');
  check('Plan granted regardless of currency used to pay', meAfter.body.plan === 'pro');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail>0?1:0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
