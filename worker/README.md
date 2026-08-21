# job-watch auto-apply worker

Headless, browser-free auto-apply for **Greenhouse** jobs. Runs on the always-on
Linux laptop. Greenhouse exposes the full application form as public JSON, so no
browser is needed — we fetch the form, map answers from your saved profile, run
a 4-pass safety check, and (later) submit.

Ashby and Eightfold are **not** here — their forms are only readable from a live
browser DOM, so they run through the Chrome extension on the Windows desktop.

## Where each piece runs

| Piece | Machine | Notes |
|---|---|---|
| Scrape + score jobs | Firebase (cloud) | already 24/7 |
| Tailored resume + cover letter, AI free-text answers | Firebase functions | keeps the OpenAI key server-side |
| **Greenhouse apply** | **this worker → Linux laptop** | no browser |
| Ashby apply | Chrome extension → Windows desktop | live DOM |
| Eightfold apply | Chrome extension → Windows desktop | built last |
| Review queue (parked jobs) | web app | you, occasionally |

## The "no mistakes" guarantees

1. High-stakes answers (work authorization, visa sponsorship, export control,
   employment agreements, country, EEO) come **only** from your profile — the AI
   is never allowed to answer them.
2. A dropdown answer must match one of the form's **exact** options, or the job
   is parked. No fuzzy picking.
3. **4 independent verification passes** run before any submit
   (`lib/verify.mjs`): completeness · option-validity · formats · compliance
   integrity. All four must pass, or the job is parked for review.
4. Anything unrecognized → parked, never guessed.

## Usage (dry-run — never submits)

```bash
cd worker
cp profile.example.json profile.json   # then fill profile.json with YOUR data
node apply-greenhouse.mjs --url "https://job-boards.greenhouse.io/<board>/jobs/<id>" --profile ./profile.json
```

Exit codes: `0` = READY (would submit), `2` = NEEDS_REVIEW (parked), `1` = error.

`profile.json` is git-ignored (only `profile.example.json` is committed) so your
real details never land in the repo.

## Status / roadmap

- [x] Greenhouse form fetch (`lib/greenhouse.mjs`)
- [x] Answer mapping with per-field source + confidence (`lib/answer-engine.mjs`)
- [x] 4-pass verifier (`lib/verify.mjs`)
- [x] Dry-run CLI + real-job test
- [ ] Pull profile + résumé from Firestore instead of a local file
- [ ] Per-job tailored résumé + cover letter (Firebase function) and attach them
- [ ] OpenAI free-text answers (server-side), fed through the same confidence gate
- [ ] Gated submission (`--submit`) after one careful real-board test
- [ ] Loop over all scored Greenhouse jobs; write parked ones to a review queue
