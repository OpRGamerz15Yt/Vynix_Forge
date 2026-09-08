const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/github/callback';

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
    req.session.githubId = String(ghUser.id);
    req.session.userId = user.id;
    delete req.session.oauthState;
    res.redirect('/');
  }catch(e){
    console.error('OAuth callback error:', e);
    res.status(500).send('Login failed: '+e.message);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok:true }));
});

module.exports = { router, makeGithubClient, __setGithubClientForTesting };
