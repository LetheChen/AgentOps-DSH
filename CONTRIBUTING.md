# Contributing

English | [中文](CONTRIBUTING.zh.md)

AgentOps-DSH is an open-source derivative of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). This document covers the fork. Contributions that touch DSH core itself belong upstream, in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); everything under `packages/agentops/` and `agentops/` is owned by this repository.

## Before you start

Open an issue first for anything larger than a bug fix. It lets us agree on the design before you spend the effort, and it keeps the change history readable.

For a security problem, do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

```sh
git clone https://github.com/LetheChen/AgentOps-DSH.git
cd AgentOps-DSH
pnpm install
pnpm run build
```

The repository needs Node.js 24.9 or newer and a pnpm workspace. `pnpm run build` produces the artifacts that the type check and the test suite consume; run it before `pnpm run typecheck` or `pnpm run test` if you changed anything under `packages/`.

## Where things live

| Path | Contents |
| --- | --- |
| `packages/agentops/**` | The AgentOps plugins. Each directory is one `@deepseek-ai/dsh-*` workspace package. |
| `agentops/` | Deployment assets and the fork's change-tracking manifests. |
| `docs/`, `website/` | Upstream DSH documentation and its site projection. |
| `vendor/` | Pinned copies of upstream Cordis packages. |

## Change rules

1. Agent behaviour goes into a plugin package under `packages/agentops/`. Do not patch the agent loop; if you need a new extension point, add it and update `docs/architecture.md` in the same change.
2. A change under `packages/agentops/` or `agentops/` is AgentOps-owned. A change to a DSH core file is not, and has to be registered in `agentops/CORE-PATHS.txt` and recorded in `agentops/DSH-CORE-CHANGES.md` with the reason, the test, and the rollback.
3. Anything a profile, bundle, or preset can express must not change a DSH file.
4. Run `node agentops/scripts/check-owned-paths.mjs` before you push. `UNEXPECTED` must be 0.
5. Update the affected README and the JSDoc contracts in the same change as the behaviour they describe.

The full conventions live in [AGENTS.md](AGENTS.md). Please read it before your first change.

## Checks

Run the smallest set that covers your change, and report only what you ran:

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run doc-sync
```

`pnpm run test:coverage` is the CI coverage gate rather than `pnpm run test`; CI owns the exhaustive matrix. If your change is model-visible or product-user-visible, update the recorded-session snapshots under `snapshots/` in the same pull request.

## Pull requests

Fill in `.github/pull_request_template.md`. Describe the motivation, the change, and the test design — including what the test proves and how it was run. Keep one logical change per pull request, and fix the introducing pull request rather than layering a correction on top of it.

## Upgrading DSH

The fork tracks upstream through a baseline tag and a change ledger. The procedure is in [agentops/UPGRADE.md](agentops/UPGRADE.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

AgentOps-DSH is MIT licensed, matching upstream DSH. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
