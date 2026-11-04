# Contributing to Elozi

Thanks for helping! Issues and pull requests are welcome in English or Portuguese (PT-BR).

## Developer Certificate of Origin (DCO)

Elozi uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA. By signing
off a commit you certify that you wrote the change, or otherwise have the right to submit it under the MIT License.

Sign off every commit with `-s`:

```bash
git commit -s -m "fix: describe the change"
```

This adds a line like `Signed-off-by: Your Name <you@example.com>` that must match the commit author. To fix the last
commit use `git commit --amend -s --no-edit`; for a branch, `git rebase --signoff main`. Pull requests with unsigned
commits cannot be merged.

## Development setup

Requirements: Node.js 24 or later (the app uses the built-in `node:sqlite`).

```bash
npm ci
npm run check   # syntax check of src/, scripts/ and public/
npm test        # full unit/integration suite (node:test)
npm start       # http://127.0.0.1:4318
```

Run a single file with `node --test tests/<name>.test.js`. Tests that need a real PostgreSQL are opt-in and are
skipped unless their `MEPCHAT_TEST_PG_*` variables are set (see `.github/workflows/ci.yml` for the exact setup).

## Pull requests

- Keep changes focused; add or update tests for behavior changes.
- `npm run check` and `npm test` must pass; CI runs them on GitHub-hosted runners.
- Never commit secrets, tokens, real customer data, phone numbers or personal data. Use obviously synthetic fixtures
  (`example.test` domains, `5511900000xxx` numbers).
- User-facing text exists in English and Portuguese (`public/locales-*.js`); update both.
- Security issues: follow SECURITY.md instead of opening a PR.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
