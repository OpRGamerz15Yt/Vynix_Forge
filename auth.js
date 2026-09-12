const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/github/callback';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')){
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored){
  if(!stored || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
function validEmail(value){ return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }
function validPassword(value){ return typeof value === 'string' && value.length >= 8 && value.length <= 200; }
function establishSession(req, user){
  req.session.userId = user.id;
  req.session.githubId = user.github_id;
}
function applyRememberMe(req, remember){
  if(remember) req.session.cookie.maxAge = 30*24*60*60*1000;
}

// Injectable so tests can stub the network calls to github.com/api.github.com
// without needing real OAuth app credentials. In production these default
// to the real endpoints.
function makeGithubClient(overrides={}){
  return {
    exchangeCodeForToken: overrides.exchangeCodeForToken || (async (code) => {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
        body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: CALLBACK_URL })
      });
      const data = await res.json();
      if(!data.access_token) throw new Error(data.error_description || 'GitHub token exchange failed.');
      return data.access_token;
    }),
    getAuthenticatedUser: overrides.getAuthenticatedUser || (async (accessToken) => {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'vynix-forge-backend' }
      });
      if(!res.ok) throw new Error('GitHub /user lookup failed with status '+res.status);
      return res.json(); // { id, login, ... } -- id is the numeric, immutable GitHub user ID
    })
  };
}

router.get('/github/login', (req, res) => {
  if(!testGithubClientOverride && (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET)){
    return res.status(503).send('GitHub login is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, then restart the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=read:user&state=${state}`;
  res.redirect(url);
});

let testGithubClientOverride = null;
// Test-only seam: lets tests substitute a fake GitHub API without needing
// real OAuth app credentials. Never used in production (server.js never
// calls this).
function __setGithubClientForTesting(client){ testGithubClientOverride = client; }

router.get('/github/callback', async (req, res) => {
  try{
    const { code, state } = req.query;
    if(!state || state !== req.session.oauthState){
      return res.status(400).send('Invalid OAuth state -- possible CSRF attempt, login aborted.');
    }
    const github = testGithubClientOverride || makeGithubClient();
    const accessToken = await github.exchangeCodeForToken(code);
    const ghUser = await github.getAuthenticatedUser(accessToken);

    // This is the ONLY place a session's identity is ever set, and it comes
    // straight from GitHub's verified response -- never from anything the
    // client submitted in the request.
    const user = db.upsertUserFromGitHub(ghUser.id, ghUser.login);
    establishSession(req, user);
    delete req.session.oauthState;
    res.redirect('/');
  }catch(e){
    console.error('OAuth callback error:', e);
    res.status(500).send('Login failed: '+e.message);
  }
});

router.get('/google/login', (req, res) => {
  if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET){
    return res.status(503).send('Google login is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOauthState = state;
  const params = new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, redirect_uri:GOOGLE_CALLBACK_URL, response_type:'code', scope:'openid email profile', state, access_type:'online' });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?'+params.toString());
});

router.get('/google/callback', async (req, res) => {
  try{
    if(!req.query.state || req.query.state !== req.session.googleOauthState) return res.status(400).send('Invalid Google OAuth state -- login aborted.');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({code:req.query.code, client_id:GOOGLE_CLIENT_ID, client_secret:GOOGLE_CLIENT_SECRET, redirect_uri:GOOGLE_CALLBACK_URL, grant_type:'authorization_code'}) });
    const tokens = await tokenResponse.json();
    if(!tokenResponse.ok || !tokens.access_token) throw new Error(tokens.error_description || 'Google token exchange failed.');
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers:{Authorization:'Bearer '+tokens.access_token} });
    const profile = await profileResponse.json();
    if(!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified === false) throw new Error('Google did not return a verified email address.');
    establishSession(req, db.upsertUserFromGoogle(profile.sub, profile.email, profile.name));
    delete req.session.googleOauthState;
    res.redirect('/');
  }catch(error){
    console.error('Google OAuth callback error:', error);
    res.status(500).send('Google login failed: '+error.message);
  }
});

router.post('/local/register', (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const displayName = String(req.body && req.body.displayName || '').trim().slice(0, 80);
  const password = req.body && req.body.password;
  if(!validEmail(email)) return res.status(400).json({error:'Enter a valid email address.'});
  if(!validPassword(password)) return res.status(400).json({error:'Password must be at least 8 characters.'});
  if(db.getUserByEmail(email)) return res.status(409).json({error:'An account with that email already exists.'});
  const user = db.createLocalUser(email, displayName, hashPassword(password));
  establishSession(req, user);
  applyRememberMe(req, req.body && req.body.remember);
  res.status(201).json({ok:true});
});

router.post('/local/login', (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const password = req.body && req.body.password;
  const user = db.getUserByEmail(email);
  if(!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({error:'Email or password is incorrect.'});
  establishSession(req, user);
  applyRememberMe(req, req.body && req.body.remember);
  res.json({ok:true});
});

router.post('/local/forgot-password', (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const user = db.getUserByEmail(email);
  if(user){
    const token = crypto.randomBytes(32).toString('hex');
    db.setPasswordResetToken(user.id, crypto.createHash('sha256').update(token).digest('hex'), Date.now()+15*60*1000);
    console.warn(`Password reset requested for ${email}; configure email delivery before exposing reset links.`);
  }
  res.status(501).json({error:'Password reset email delivery is not configured yet.'});
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok:true }));
});

module.exports = { router, makeGithubClient, __setGithubClientForTesting };
