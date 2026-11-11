# ESLint + Prettier over Biome

Linting and formatting are enforced in CI with ESLint 9 (flat config, type-checked
rules) and Prettier. Biome is faster and is one tool instead of two, but ESLint's
type-aware rule family (`no-explicit-any`, `no-unsafe-*` as errors) is what actually
enforces the project's zero-`any` guarantee, and that maturity was worth more than
single-tool speed for a CI-gated repo.

## Consequences

Two configs to maintain (ESLint + Prettier) instead of one; formatting is Prettier's
job and `eslint` never stylistically fights it.
