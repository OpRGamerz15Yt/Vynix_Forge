process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'test-secret';
// Deliberately NOT setting STRIPE_SECRET_KEY for the first half of this test.

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
  const agent = request.agent(app);
  await loginAs(agent, '333333', 'billing-user');

  console.log('=== TEST: Checkout with NO Stripe configured -- must refuse, not fake ===');
  const checkoutNoConfig = await agent.post('/api/billing/checkout/pro');
  console.log('Status (expect 501):', checkoutNoConfig.status);
  console.log('Message:', checkoutNoConfig.body.message);

  console.log('\n=== TEST: Plan is unaffected by the failed checkout attempt ===');
  const meAfter = await agent.get('/api/me');
  console.log('Plan (expect still free):', meAfter.body.plan);

  console.log('\n=== TEST: Owner cannot even attempt checkout ===');
  const ownerAgent = request.agent(app);
  await loginAs(ownerAgent, '999999', 'owner');
  const ownerCheckout = await ownerAgent.post('/api/billing/checkout/pro');
  console.log('Status (expect 400):', ownerCheckout.status, ownerCheckout.body.error);

  console.log('\n=== TEST: Real webhook signature verification (using Stripe test helper) ===');
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_but_correctly_formatted_for_sdk_init';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_123';
  delete require.cache[require.resolve('stripe')];
  const Stripe = require('stripe');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const targetUser = db.getUserByGithubId('333333');
  const fakeSessionPayload = JSON.stringify({
    id: 'evt_test_1', type: 'checkout.session.completed',
    data: { object: {
      client_reference_id: String(targetUser.id),
      customer: 'cus_fake123', subscription: 'sub_fake123',
      metadata: { vynixUserId: String(targetUser.id), targetPlan: 'pro' }
    }}
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload: fakeSessionPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });

  console.log('\n--- Sending a FORGED webhook (wrong signature) ---');
  const forged = await request(app).post('/api/billing/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=deadbeef00000000000000000000000000000000000000000000000000000000')
    .send(fakeSessionPayload);
  console.log('Status (expect 400, rejected):', forged.status);
  const meAfterForged = await agent.get('/api/me');
  console.log('Plan after forged webhook (expect still free):', meAfterForged.body.plan);

  console.log('\n--- Sending a REAL, correctly-signed webhook ---');
  const real = await request(app).post('/api/billing/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', header)
    .send(fakeSessionPayload);
  console.log('Status (expect 200):', real.status, real.body);

  const meAfterReal = await agent.get('/api/me');
  console.log('Plan after genuinely-signed webhook (expect pro):', meAfterReal.body.plan);

  const subRow = db.db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(targetUser.id);
  console.log('Subscription record created:', !!subRow, subRow && subRow.status);

  console.log('\nDONE.');
  process.exit(0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
