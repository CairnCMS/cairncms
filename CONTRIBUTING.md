# Contributing to CairnCMS

All submissions to this project must be made under the [Developer Certificate of Origin](https://developercertificate.org/). All commits must include a `Signed-off-by` line. Use `git commit -s` to add it automatically.

We welcome contributions including:

- Bug reports
- Bug fixes
- New features
- Documentation improvements
- Ideas and feedback

To help maintain quality with limited maintainer bandwidth, please follow the guidelines below.

## Reporting Issues

Search the [issue tracker](https://github.com/CairnCMS/cairncms/issues) for an existing or closely related issue before creating a new one. Include closed issues in your search.

If an open issue already exists, read through the discussion. If you can add something helpful, do so. Add a 👍 if you'd like to see it prioritized.

If no issue exists, create one. Include steps to reproduce, error output, relevant configuration, and your environment details.

For security vulnerabilities, do not open a public issue. See our [security policy](https://github.com/CairnCMS/cairncms/security/policy) or email security@cairncms.dev.

## Pull Requests

Before starting work, check for an existing issue or open one. This creates the opportunity to discuss the approach before you spend time on implementation.

If you want to use AI tools in your contribution, review our [AI Policy](https://github.com/CairnCMS/cairncms/blob/main/AI_POLICY.md) before submitting.

To improve the chance of your pull request being merged:

- Be focused in scope. One PR per concern.
- Include a clear description of what changed and why.
- Reference the related issue.
- Add or update tests where appropriate.
- Make sure `pnpm test` and `pnpm lint` pass before submitting.

Pull requests will be reviewed by a maintainer. Be prepared to answer questions about your changes and to make adjustments based on feedback.

## Source Use and Clean Implementations

Contributors are responsible for ensuring they have the right to submit their work under GPLv3.

You may learn from public documentation, standards, issue discussions, CVE/GHSA disclosures, release notes, and observed product behavior. You must not copy code, tests, comments, helper structure, naming, or distinctive implementation shape from source that is not available to CairnCMS under GPL-compatible terms.

If you inspect non-GPL-compatible source to understand behavior, write the CairnCMS implementation independently. Use later comparison only to verify behavior, not as a guide for structure or code shape.

If a contribution adapts code from a compatible open-source project, preserve any required notices and mention the source in the PR. Maintainers may ask what sources informed a change, especially for security fixes or upstream-parity work.

## Development Setup

See the [development guide](https://cairncms.dev/docs/contributing/running-locally) for instructions on running CairnCMS locally.

## Database Support

CairnCMS supports PostgreSQL, MySQL, SQLite, and MariaDB.

## Conduct

Please review our [code of conduct](https://github.com/CairnCMS/cairncms/blob/main/CODE_OF_CONDUCT.md).

## Discussions

For questions, ideas, or general conversation, visit [GitHub Discussions](https://github.com/CairnCMS/cairncms/discussions).
