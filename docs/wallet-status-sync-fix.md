# Wallet status synchronization fix

Date: 2026-11-12

## Root cause

The header and workspace did not actually render the same status:

- The header consumed `useNearWallet()` and displayed the provider's authenticated `accountId`.
- The workspace project column contained a literal `<strong>Not connected</strong>` and never read wallet or authentication state.

This was therefore primarily a stale/legacy presentation defect, but it could hide a real authentication problem because the UI did not distinguish a connected wallet from a valid backend session.

The existing API client already sends `credentials: "include"` on every request. The API already verifies NEP-413 signatures, checks the wallet's finalized FullAccess key, creates the HttpOnly `attestra_session` cookie, validates it on every authenticated route, and applies credentialed CORS for the configured frontend origin. No authentication bypass or cookie weakening was needed.

## State model implemented

The shared NEAR wallet provider now exposes:

- `disconnected`: no wallet is connected.
- `connected`: wallet is connected, but no valid API session exists.
- `authenticated`: NEP-413 authentication succeeded and the provider has a valid backend session.
- `expired`: a previously authenticated session failed revalidation or expired.
- `failed`: wallet authentication failed.

The connected wallet account and authenticated API account are tracked separately. The UI only treats the account as authenticated when the backend session succeeds. Existing sessions are revalidated on startup and periodically while active. Account changes clear the previous session and require authentication for the new account. Disconnect clears both wallet and API state.

## Files changed

- `apps/web/src/components/near-wallet-provider.tsx`
  - Added explicit authentication state.
  - Added separate connected-wallet account state.
  - Added startup/session revalidation and expiry handling.
  - Cleared authentication on account switching and disconnect.
  - Preserved NEP-413 signing and backend authentication flow.
- `apps/web/src/components/project-workspace.tsx`
  - Removed the hardcoded workspace wallet label.
  - Rendered the same provider state/account used by the header.
  - Added clear connected, authenticated, expired, and failed messaging.
- `apps/web/test/components.test.tsx`
  - Added wallet state-label and workspace source-of-truth regression checks.
- `apps/web/test/api.test.ts`
  - Confirmed authenticated API requests include `credentials: "include"`.

No API authentication, session validation, CORS, CSRF, payment, execution, receipt, or blockchain code was weakened or changed.

## Security implications

The header and workspace now reflect the same provider state, but display alone is not authorization. The API remains authoritative for execution and payment actions. A connected-but-unauthenticated wallet cannot satisfy `requireAuthenticated`, and an expired session is not presented as authenticated after revalidation fails. NEP-413 signatures and private keys remain wallet-controlled and are never exposed.

## Validation

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm --filter @attestra/web test` — 22/22 passed.
- `pnpm --filter @attestra/api test` — 28/28 passed.
- `pnpm build` — passed, including the Next production build and API/package builds.

## Browser retesting steps

1. Restart the local API and web processes so the updated provider and workspace bundle are loaded.
2. Open `http://localhost:3000/workspace` in a fresh tab. If an old bundle is cached, hard-refresh once.
3. Before connecting, confirm both the header and the workspace wallet panel show `Not connected`.
4. Click **Connect and authenticate** and complete the NEAR Testnet wallet flow. The wallet must approve the NEP-413 sign-in message; this is authentication, not a blockchain transaction.
5. Confirm both locations show `lateram9099.testnet` and the authenticated wording. Do not proceed if one says authenticated while the other says not connected.
6. Disconnect. Confirm both locations return to `Not connected`.
7. Reconnect the same wallet and confirm both locations return to the authenticated state.
8. For account switching, disconnect fully, connect the alternate wallet, and confirm the UI first reports connected/authentication required and then authenticated only after the new NEP-413 challenge succeeds.
9. To test expiry, let the backend session expire or clear the server session in a controlled local test environment. Within the provider revalidation interval, both locations must show `Session expired — reconnect`; wallet actions must remain rejected by the API.
10. Resume the payment demonstration only after the owner or authorized verifier account is visibly authenticated. No project creation, funding, approval, settlement, or other blockchain transaction is required to test this UI fix.

## Remaining note

The provider revalidates an active API session periodically rather than trusting the wallet connection alone. A sensitive API operation can still return an authentication error if the session expires between polls; the browser should then reconnect rather than retrying with a stale wallet state.
