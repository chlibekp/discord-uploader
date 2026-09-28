# discord-uploader

## Workflow

- **Run Prettier before every PR.** `pnpm dlx prettier --write .`, then `pnpm dlx prettier --check .` must pass. CI (`.github/workflows/format-check.yml`) rejects unformatted PRs.
- Run `pnpm test` and `pnpm typecheck` before opening a PR.
- Run `pnpm test:e2e` when touching anything under `web/` or `public/`; the legacy-page screenshots must not change.
