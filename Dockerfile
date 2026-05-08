# syntax=docker/dockerfile:1.4

####################################################################################################
## Build Packages

FROM node:22-alpine AS builder
WORKDIR /cairncms

ENV NODE_OPTIONS=--max-old-space-size=8192

COPY package.json .
RUN corepack enable && corepack prepare

COPY pnpm-lock.yaml .
RUN pnpm fetch
COPY . .
RUN pnpm install --recursive --offline --frozen-lockfile

RUN : \
	&& npm_config_workspace_concurrency=1 pnpm run build \
	&& pnpm --filter cairncms deploy --legacy --prod dist \
	&& cd dist \
	&& pnpm pack \
	&& tar -zxvf *.tgz package/package.json \
	&& mv package/package.json package.json \
	&& rm -r *.tgz package \
	&& mkdir -p database extensions uploads \
	;

####################################################################################################
## Create Production Image

FROM node:22-alpine AS runtime

USER node

WORKDIR /cairncms

EXPOSE 8055

ENV \
	DB_CLIENT="sqlite3" \
	DB_FILENAME="/cairncms/database/database.sqlite" \
	EXTENSIONS_PATH="/cairncms/extensions" \
	STORAGE_LOCAL_ROOT="/cairncms/uploads" \
	NODE_ENV="production" \
	NPM_CONFIG_UPDATE_NOTIFIER="false"

COPY --from=builder --chown=node:node /cairncms/dist .

CMD : \
	&& node --no-node-snapshot /cairncms/cli.js bootstrap \
	&& node --no-node-snapshot /cairncms/cli.js start \
	;
