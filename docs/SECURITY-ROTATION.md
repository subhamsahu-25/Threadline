# Secret rotation runbook

The first submission archive was built by zipping the working folder, so it
shipped `backend/.env` with live values. The values below must be rotated in
the provider consoles; a code change cannot revoke a credential. The copy of
`backend/.env` on disk still contains the old values until they are replaced.

## What must be rotated

| Credential | Where to rotate | Check after |
| --- | --- | --- |
| MongoDB Atlas database user and password | Atlas → Database Access → add a new user, grant the same role, delete the old user | Old URI returns `bad auth`; new URI works from Render |
| Atlas network access | Atlas → Network Access | Only the host egress ranges remain |
| Gemini API key | Google AI Studio → API keys → delete the old key, create a new one | Old key returns 401/403; extraction uses the new key |
| GitHub token | GitHub → Settings → Developer settings → Personal access tokens → revoke old, create new | Old token shows as revoked; repository sync still works |

After rotating, update the deployment environment variables (Render for the
server) and the local `backend/.env` (never commit it or paste it in chat).
Run `node scripts/check-secrets.mjs` and rebuild the archive with
`node scripts/build-archive.mjs`.

## Status

- Repository and archive: fixed. `backend/.env` is untracked and ignored,
  `scripts/build-archive.mjs` exports `git archive HEAD` only, and CI fails if
  an environment file is tracked or a credential pattern appears in a tracked
  file.
- Rotation: **pending, requires provider console access held by the project
  owner.** The re-audit's step 2 (restrict the Atlas allow-list) is also a
  console action.
