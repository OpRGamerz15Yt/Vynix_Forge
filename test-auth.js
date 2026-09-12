process.env.OWNER_USER_ID = '999999';
process.env.SESSION_SECRET = 'auth-test-secret';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const request = require('supertest');
const app = require('./server');
const db = require('./db');

(async () => {
  const email = `auth-${Date.now()}@example.com`;
  const agent = request.agent(app);
  const registered = await agent.post('/auth/local/register').send({ email, displayName:'Auth Tester', password:'StrongPass!123', remember:true });
  if(registered.status !== 201) throw new Error('Registration failed: '+registered.status+' '+JSON.stringify(registered.body));
  const me = await agent.get('/api/me');
  if(me.status !== 200 || me.body.githubLogin !== email || me.body.plan !== 'free') throw new Error('Registered session is invalid.');
  await agent.post('/auth/logout');
  const wrongPassword = await request(app).post('/auth/local/login').send({ email, password:'wrong-password' });
  if(wrongPassword.status !== 401) throw new Error('Wrong password was not rejected.');
  const login = await agent.post('/auth/local/login').send({ email, password:'StrongPass!123' });
  if(login.status !== 200) throw new Error('Local login failed: '+login.status+' '+JSON.stringify(login.body));
  const duplicate = await request(app).post('/auth/local/register').send({ email, password:'AnotherPass!123' });
  if(duplicate.status !== 409) throw new Error('Duplicate email was not rejected.');
  const google = await request(app).get('/auth/google/login');
  if(google.status !== 503) throw new Error('Unconfigured Google login did not fail clearly.');
  console.log('AUTH TESTS PASSED');
})().catch(error => { console.error(error.stack); process.exit(1); });
