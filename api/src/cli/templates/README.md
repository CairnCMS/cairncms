# __PROJECT_NAME__

A CairnCMS project.

## Requirements

- Docker with Compose v2 (Docker Desktop on macOS / Windows; Docker Engine + the compose plugin on Linux). On Apple Silicon, enable Rosetta in Docker Desktop settings. The default PostGIS image is amd64-only.
- Node 22+ on the host if you use the bundled `npm start` / `npm stop` / `npm logs` shortcuts. They are thin wrappers around `docker compose`; if you'd rather skip Node, run the equivalent `docker compose --project-directory cairncms -f cairncms/docker-compose.yml ...` commands directly.

## This scaffold is for local development

This scaffold gives you a working CairnCMS instance for local development and content modeling. **It is not a production deployment template.** Production deployments require additional decisions the scaffold does not make for you:

- **Database image arch.** The default `postgis/postgis:16-3.4-alpine` image is amd64-only. For ARM cloud (Graviton, ARM Kubernetes), replace with a multi-arch alternative or use plain `postgres` if you don't need geometry features.
- **Secret management.** `cairncms/.env` ships with random secrets and is gitignored. For production, source secrets from a vault or your platform's secret store rather than a local file.
- **`PUBLIC_URL`.** Defaults to `http://localhost:${CAIRNCMS_PORT}`. When you serve CairnCMS from a real hostname, set `PUBLIC_URL` in `cairncms/.env`.
- **TLS, backups, monitoring, log shipping.**

## Working with the API

CairnCMS is API-first. Once the stack is running, you interact with content, schema, and config via HTTP endpoints.

**Admin credentials.** Use admin email and password to obtain a token via `POST /auth/login`.

Example: snapshot the schema as YAML.

```bash
ADMIN_TOKEN=$(curl -sS -X POST http://localhost:__CAIRNCMS_PORT__/auth/login \
  -H 'Content-Type: application/json' \
  -d "$(cat <<EOF
{"email":"admin@example.com","password":"$(grep ^ADMIN_PASSWORD cairncms/.env | cut -d= -f2 | tr -d '"')"}
EOF
)" | jq -r '.data.access_token')

curl -sS "http://localhost:__CAIRNCMS_PORT__/schema/snapshot?export=yaml" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o cairncms/snapshots/schema.yaml
```

Example: snapshot config-as-code, then dry-run an apply against the snapshot.

```bash
curl -sS "http://localhost:__CAIRNCMS_PORT__/config/snapshot?export=yaml" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o cairncms/snapshots/config.yaml

curl -sS -X POST "http://localhost:__CAIRNCMS_PORT__/config/apply?dry_run=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: text/yaml' \
  --data-binary @cairncms/snapshots/config.yaml
```

## Working with the CLI

If you prefer the CLI workflow, the cairncms CLI is available inside the running container:

```bash
docker compose --project-directory cairncms -f cairncms/docker-compose.yml exec cairncms cairncms config snapshot /cairncms/config/my-config
```

The CLI reads and writes a directory tree (`cairncms-config.yaml` + `roles/*.yaml` + `permissions/*.yaml`); the API operates on a flat `CairnConfig` payload. Both flow through the same engine and operate on the same data shape. Converting between them is mechanical, and you can mix the two within a project as your tooling needs change.

***

The full API and CLI reference is at `https://cairncms.dev/docs`.
