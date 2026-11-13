# Phase 3D Next.js Runtime Stability

## Root cause

The recurring `ENOENT` was caused by concurrent Next.js processes sharing
`apps/web/.next`. A pre-existing plain `next dev` process owned port 3000 and
was writing the development cache. A second development tree was also started
during recovery. In addition, the repository production build script used
`next build` with the default `.next` output, so a production build could
replace or invalidate files needed by the active development server.

The missing `server/app/workspace/page.js` alongside remaining manifest files
was consistent with an incomplete or conflicting cache, not with disk
exhaustion or filesystem ownership. The investigation found normal ownership
and permissions, approximately 899 GB free space, and approximately 2% inode
use.

## Durable changes

- `apps/web/next.config.ts` now sends production builds and production servers
  to `.next-production`; development continues to use `.next`.
- `apps/web/package.json` now starts development through
  `scripts/dev-web.mjs`.
- `scripts/dev-web.mjs` uses an exclusive `.next-dev.lock` under `apps/web`.
  It refuses a second live launcher, recovers a stale lock whose PID is gone,
  forwards termination signals, and removes the lock when the child exits.
- Next's production build added `.next-production/types/**/*.ts` to the web
  TypeScript include list. This is generated configuration required for the
  isolated production build's Next type declarations.

No smart-contract, blockchain, execution, receipt, or persistent application
records were modified.

## Runtime validation

After stopping only the identified stale ATTESTRA frontend tree and starting
one repository-managed dev tree:

- API: port 4000, healthy existing Fastify process.
- Frontend: exactly one Next server on port 3000.
- `GET /workspace`: HTTP 200, 19,873 bytes.
- `apps/web/.next/server/app/workspace/page.js`: present (844,593 bytes).
- Live API approval deposit: `330000000000000000000` yoctoNEAR.
- Live API settlement deposit: `510000000000000000000` yoctoNEAR.
- A second `pnpm --filter @attestra/web dev` was rejected by the launcher lock.
- Production build: passed using `.next-production`.
- After that production build, `/workspace` still returned HTTP 200 and both
  development and production workspace artifacts were present.

## Automated validation

- Web typecheck: passed.
- Web lint: passed.
- Web tests: passed, 25 tests across 3 files.
- Web production build: passed.

## Operating rule

Run one `pnpm dev` from the repository root. Do not start a second `next dev`
or `pnpm --filter @attestra/web dev` instance. Production builds are now
isolated in `.next-production`, but the lock still prevents duplicate
development servers. If a stale launcher remains after an abnormal crash,
stop only that ATTESTRA web process; the next launch will also recover a stale
lock automatically.

The development servers are left running on ports 3000 and 4000. It is safe to
resume the owner approval browser flow from the restored workspace; this work
did not submit or sign any blockchain transaction.
