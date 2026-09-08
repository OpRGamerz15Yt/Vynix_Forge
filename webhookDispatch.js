const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('./db');

// Signs the payload the same way Stripe/GitHub do: HMAC-SHA256 over the raw
// JSON body, sent as a header, so the receiving endpoint can verify this
// request genuinely came from Vynix Forge and wasn't forged/tampered with.
function sign(secret, rawBody){
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function dispatchEvent(userId, eventType, data){
  const hooks = db.webhooksForEvent(userId, eventType);
  if(hooks.length === 0) return;
  const payload = JSON.stringify({ event: eventType, data, sentAt: new Date().toISOString() });
  for(const hook of hooks){
    const signature = sign(hook.secret, payload);
    try{
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Vynix-Signature': 'sha256='+signature },
        body: payload,
        timeout: 10000
      });
    }catch(e){
      console.warn(`Webhook delivery failed for user ${userId} -> ${hook.url}:`, e.message);
      // Real infra note: a production version needs retry/backoff and a
      // dead-letter log visible to the Dev user. Not implemented here --
      // reported plainly in the final report rather than pretended.
    }
  }
}

module.exports = { dispatchEvent, sign };
