// ============================================================
// OWNER AUTHORIZATION -- the single most security-sensitive function here.
// ============================================================
//
//   if authenticated_user.id == OWNER_USER_ID:
//       OWNER
//   else:
//       user's actual plan
//
// Rules enforced by this file, matching the spec exactly:
// - OWNER_USER_ID comes ONLY from a server-side environment variable, set
//   by whoever deploys this backend (you). It is never read from a
//   request, a header, a cookie value the client can set, or the database
//   row a client could theoretically influence.
// - The comparison is against the authenticated GitHub numeric ID (from a
//   verified OAuth session), never a username/login/email/display name,
//   all of which can change or collide.
// - If OWNER_USER_ID is missing or malformed, this fails CLOSED: nobody
//   becomes Owner, ever, rather than falling back to "first user" or any
//   other guess. That failure is logged loudly so a misconfigured deploy
//   is obvious rather than silently insecure.
// - This function is the ONLY place in the codebase allowed to decide
//   Owner status. Nothing else -- not the DB's `plan` column, not a
//   request body, not localStorage (which this backend doesn't even have
//   access to) -- can grant it.

function getOwnerUserId(){
  const raw = process.env.OWNER_USER_ID;
  if(!raw || typeof raw !== 'string' || raw.trim() === ''){
    console.warn('[SECURITY] OWNER_USER_ID is not set. No account can be Owner until this is configured. This is the SAFE failure mode -- do not "fix" this by picking a fallback user.');
    return null;
  }
  return raw.trim();
}

// githubId must be the verified numeric GitHub user ID from the OAuth
// session -- never trust a client-submitted value for this parameter.
function resolveEffectivePlan(githubId, storedPlanFromDb){
  const ownerId = getOwnerUserId();
  if(ownerId !== null && String(githubId) === ownerId){
    return 'owner';
  }
  // Anyone else gets exactly their real, stored plan -- never Owner,
  // regardless of what they claim, submit, or how they phrase a request.
  return storedPlanFromDb || 'free';
}

module.exports = { getOwnerUserId, resolveEffectivePlan };
