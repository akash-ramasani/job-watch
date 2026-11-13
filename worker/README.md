# worker/

The runtime for the maintenance scripts in `scripts/` (run-sync-now,
seed-workday-feeds, rescore-jobs, retain-week, import-latex-resume,
ai-scoring-pause, check-board): `lib/firestore.mjs` opens Firestore as the
admin with `service-account.json` (not committed), and `package.json` holds
`firebase-admin`.

    cd worker && npm install
    node ../scripts/run-sync-now.mjs

Applications are filled and submitted by the browser extension (`extension/`)
with the server functions in `functions/lib/apply/`; the old Playwright
applier that lived here was removed on 2026-11-13.
