# cairncms

`cairncms` is the distributable CLI for CairnCMS, a self-hosted headless CMS that serves a REST and GraphQL API with a no-code admin app on top of an SQL database. Installing this package gives you a single binary that runs the API, serves the admin app, and handles database bootstrap and migrations.

## Install

```sh
npm install -g cairncms
```

Node 20 or newer is required. `pnpm` and `yarn` work too.

## Quick start

For a quick local run against SQLite:

```sh
export KEY=$(openssl rand -hex 16)
export SECRET=$(openssl rand -hex 32)
export DB_CLIENT=sqlite3
export DB_FILENAME=./cairncms.db

cairncms bootstrap
cairncms start
```

- `KEY` and `SECRET` sign and encrypt auth tokens. Any random strings work; keep them stable across restarts.
- `DB_CLIENT` selects the database driver. Each driver expects its own vendor-specific variables (`DB_FILENAME` for SQLite, `DB_HOST` / `DB_USER` / `DB_PASSWORD` for networked databases, etc.).
- `bootstrap` runs first-time setup: applies migrations and creates the admin tables and default admin user. Safe to run on an empty database; skip it on subsequent starts.
- `start` serves the API and admin app.

After `start`, the admin app is available at `http://localhost:8055`.

## Supported databases

- SQLite 3
- PostgreSQL (current release and 10.x LTS)
- MySQL 8 and MySQL 5.7
- MariaDB

## Documentation

See the [CairnCMS documentation](https://cairncms.dev/docs) for configuration, authentication, extension development, and API reference details.

## Issues, contributing, security

- Bug reports: [GitHub Issues](https://github.com/CairnCMS/cairncms/issues)
- Contributing guide: [CONTRIBUTING.md](https://github.com/CairnCMS/cairncms/blob/main/CONTRIBUTING.md)
- Security vulnerabilities: [security policy](https://github.com/CairnCMS/cairncms/security) or email [security@cairncms.dev](mailto:security@cairncms.dev)

## License

[GPLv3](./LICENSE).
