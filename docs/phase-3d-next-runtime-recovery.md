# Phase 3D Next.js Runtime Recovery

Date: 2026-11-13

## Root cause

The ENOENT was caused by concurrent/stale ATTESTRA Next.js development processes sharing `apps/web/.next`. The cache was inconsistent: it contained `page_client-reference-manifest.js` for `/workspace`, but not the server bundle `server/app/workspace/page.js` required by the running Next server.

There were multiple ATTESTRA process trees active. One stale Next server owned port 3000, while another `pnpm dev` tree was starting a second frontend and API watcher. Concurrent dev startup/cache work left the served Next runtime and `.next` contents out of sync. The API was also duplicated, although the existing port-4000 API was already returning the corrected configuration.

## Actions taken

- Identified the ATTESTRA frontend processes and the duplicate `pnpm dev` tree.
- Stopped only the stale/duplicate ATTESTRA frontend trees and duplicate API watcher.
- Preserved the healthy API listener on port 4000.
- Removed only the disposable generated directory `apps/web/.next` after stopping frontend processes.
- Started exactly one frontend with the repository command:

  `pnpm --filter @attestra/web dev`

- Did not run a production build while the development server was running.
- Did not modify source artifacts, execution history, receipts, contract files, or blockchain state.

## Live runtime status

Exactly one intended listener now serves each port:

- API: `0.0.0.0:4000`, Fastify `src/dev-server.ts`, PID 100479
- Frontend: `*:3000`, Next.js 15.5.29 development server, PID 103456

The clean cache now contains:

- `apps/web/.next/server/app/workspace/page.js`
- `apps/web/.next/server/app/workspace/page_client-reference-manifest.js`

## Live verification

- `GET http://127.0.0.1:3000/workspace`: HTTP 200, 19,873 bytes
- The ENOENT was not returned.
- `GET http://127.0.0.1:4000/api/v1/near/config`: HTTP 200
- Approval deposit: `330000000000000000000`
- Settlement deposit: `510000000000000000000`
- Contract: `escrow.attestra-owner.testnet`
- Network: `testnet`

The API response remains compatible with the browser payment panel. No transaction was signed or broadcast.

## Focused validation

- Frontend tests: 25 passed
- Frontend typecheck: passed
- Frontend lint: passed
- Live `/workspace` request: passed
- Live API configuration request: passed

No production build was run during this recovery, by design, because it would share and potentially mutate `.next` while the development server was active.

## Prevention note

During the remaining hackathon work, run only one `pnpm dev` tree for this repository. Do not run `next build` or another `next dev` concurrently with it. If Next reports missing files under `.next/server`, stop the frontend process first, remove only `apps/web/.next`, and restart `pnpm --filter @attestra/web dev`.

## Owner approval readiness

The workspace now renders successfully and the browser-facing API supplies the exact approval and settlement deposits. It is safe to resume the owner-controlled approval browser step, subject to the human wallet confirmation checks. Do not proceed if the wallet prompt shows a receiver, method, receipt, project/milestone ID, or deposit different from the expected values.
