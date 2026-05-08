---
title: Contributing
description: How to contribute code, documentation, and ideas to CairnCMS. The canonical files, the local-development setup, the PR conventions, and the AI policy.
sidebar:
  label: Overview
  order: 0
---

CairnCMS is an open-source project. Contributions of code, documentation, bug reports, and feedback are welcome. Maintainer time is finite, so the workflow leans on short, focused pull requests, clear test coverage, and a small set of conventions that keep review tractable.

This section has two reference pages and a short set of conventions on this hub. Read whichever is relevant to what you are about to do.

## Reference pages

- **[Repository layout](/docs/contributing/repository-layout/)** — a map of the monorepo: which package holds the API, which holds the admin app, where the shared utilities live, how pnpm workspaces fit together. Read this first if you don't yet know where the code you want to change lives.
- **[Running locally](/docs/contributing/running-locally/)** — set up a local development environment, configure a database, bootstrap, and run the API and admin app against the source tree.

## The canonical files

Three files in the repo root and `.github/` directory are the canonical sources for contribution policy. The docs site does not duplicate them; consult them directly when working on a contribution.

- **[`CONTRIBUTING.md`](https://github.com/CairnCMS/cairncms/blob/main/CONTRIBUTING.md)** — issue reporting, PR guidelines, tests, lint, and the Developer Certificate of Origin sign-off requirement. Every commit must include a `Signed-off-by` line; use `git commit -s` to add it automatically.
- **[`AI_POLICY.md`](https://github.com/CairnCMS/cairncms/blob/main/AI_POLICY.md)** — the rules for AI-assisted contributions. Read this before submitting any PR that used AI tools. Disclosure is required, and unsupervised-agent submissions get closed without review.
- **[`CODE_OF_CONDUCT.md`](https://github.com/CairnCMS/cairncms/blob/main/CODE_OF_CONDUCT.md)** — the ground rules for participation in issues, discussions, and reviews.

## Branch naming

The project uses topic-prefixed branch names. Use one of these prefixes for the branch you push your changes from:

- **`feat/`** — new features and additive changes.
- **`fix/`** — bug fixes.
- **`docs/`** — documentation-only changes (this includes both `docs/` site content and `docs-legacy/` cleanup).
- **`chore/`** — dependency bumps, tooling, CI, repository housekeeping that does not change product behavior.

Pick the prefix that best describes the dominant intent of the change. PRs that mix two prefixes are usually a sign the work should be split into two PRs.

## Before you submit a PR

A short checklist that runs faster locally than in CI:

1. **Run `pnpm test`** — the unit-test suite. Required to pass before review.
2. **Run `pnpm lint`** — the ESLint pass across the workspace. Auto-fix common issues with `pnpm lint --fix`.
3. **Run the SQLite blackbox path** if your changes touch query semantics, schema operations, or auth. The PR-CI pipeline runs the SQLite blackbox suite on every PR; running it locally first surfaces failures faster.

   ```bash
   docker compose -f tests/blackbox/docker-compose.yml up auth-saml redis minio minio-mc -d
   pnpm build
   TEST_DB=sqlite3 pnpm test:blackbox
   ```

   The `pnpm build` step is important. `pnpm test:blackbox` deploys whatever is already in each package's `dist/` directory; it does not rebuild from source. After any change in `api/`, `packages/`, or `sdk/`, run `pnpm build` (or rebuild the affected package with `pnpm --filter <name> run build`) before invoking the blackbox suite, otherwise the tests run against stale compiled output and produce confusing pass/fail results.

   For changes that affect SQL generation, also run the matching server vendor (`postgres`, `mysql`, `maria`). See [Running locally / Tests](/docs/contributing/running-locally/#tests) for the full set.
4. **Confirm a `Signed-off-by:` line** is on every commit (`git commit -s` adds it).
5. **Open the PR against `main`**. The PR template auto-populates with the issue link, scope summary, test checklist, and AI-disclosure section. Fill in every applicable box; the AI-disclosure section is required if AI tools were used at any point.

## Commit hygiene

Commit messages are the long-form record of why each change happened. The project uses a deliberately tight format so that record stays readable.

- **Subject line only.** A single-line message that fits in roughly 70 characters. Detail goes in the PR description, not in the commit body. Multi-line commit messages are not used.
- **Present-tense imperative.** Write `Bump knex to 3.1.0`, not `Bumped` or `Bumping` or `Updated knex`. The convention matches Git's own style and reads naturally as `If applied, this commit will <subject>`.
- **Be specific.** `Override path-to-regexp to 0.1.13 to address ReDoS advisory` beats `Update dependency`. The subject line is what shows up in `git log`; make it informative on its own.
- **No `Co-Authored-By` lines.** The project does not use co-author trailers.
- **Sign off every commit.** `git commit -s` adds the `Signed-off-by:` line that the DCO requires.

The `feat/` `fix/` `docs/` `chore/` branch prefixes from the previous section are the closest the project gets to conventional commits. Subjects do not need a `feat:` prefix; the branch name and PR description carry that signal.

## Code comment hygiene

The project leans toward writing no comments. The code, types, and tests are the durable record of what the code does; commits and PR descriptions are the durable record of why a change was made. Comments tend to rot when the surrounding code evolves and the comment doesn't, so the convention is to add one only when it carries information the code itself cannot.

Avoid:

- **Narrating what the code does.** Named identifiers and well-factored functions communicate intent. A comment that paraphrases the next line is noise.
- **Explaining why a change was made.** That belongs in the commit subject and the PR description. Comments don't get updated when the rationale shifts; commits stay anchored to the change they explained.
- **Internal planning language.** No "Phase 3 refactor," "Step 5 requirement," or "TODO per the plan" comments. They are incomprehensible outside the conversation that produced them and leak internal-process language into the published code.
- **External URLs.** No issue links, PR links, docs links, or wiki links in source comments. Comments stand alone; provenance lives in commits, ADRs, and changelogs.

Comments are warranted for:

- **Hidden invariants** the code itself cannot express (an ordering dependency, a lock-holding requirement, a subtle numerical constraint).
- **Workarounds for a specific bug in a named external dependency.**
- **TODOs tied to a concrete trigger.** "Remove this when knex 3.2 ships" is concrete. "Improve later" is not.

Attribution to borrowed code stays, written as a durable identifier rather than a URL: `// Adopted from Super Contributor (@fakehandle)` is fine; a link to a Stack Overflow post is not.

When in doubt, leave the comment out and rely on the code, the tests, and the commit history.

## AI-assisted contributions

The full policy is in [`AI_POLICY.md`](https://github.com/CairnCMS/cairncms/blob/main/AI_POLICY.md). The short version: AI tools are allowed, but every line of generated code must be reviewed and understood by the human submitter before it lands in a PR. Plans and architectural intent come from the contributor; the model is a tool, not a delegate. Disclosure is required in the PR template.

PRs that show no evidence of human judgment, that come from unsupervised agents, or whose author cannot explain the code when asked, get closed without review.

## Where to go next

- [Repository layout](/docs/contributing/repository-layout/) — the workspace map.
- [Running locally](/docs/contributing/running-locally/) — local development setup.
- [Community and support](/docs/getting-started/community-and-support/) — where to ask questions, file bugs, and follow the project.
