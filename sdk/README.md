# @cairncms/sdk

A typed, composable JavaScript client for [CairnCMS](https://github.com/CairnCMS/cairncms). Works in browsers and Node.js. Uses the built-in `fetch` API — zero runtime dependencies.

```bash
npm install @cairncms/sdk
```

## Quick start

```ts
import { createDirectus, rest, readItems } from '@cairncms/sdk';

const client = createDirectus('http://localhost:8055').with(rest());

const articles = await client.request(readItems('articles'));
```

Compose the features you need: `rest()` for REST, `graphql()` for GraphQL, `authentication()` for login/refresh flows, `staticToken()` for pre-issued tokens.

```ts
import { createDirectus, rest, authentication, readMe } from '@cairncms/sdk';

const client = createDirectus('http://localhost:8055')
  .with(authentication('json'))
  .with(rest());

await client.login('admin@example.com', 'password');

const me = await client.request(readMe());
```

## Documentation

Full reference: [`docs/reference/sdk.md`](https://github.com/CairnCMS/cairncms/blob/main/docs/reference/sdk.md) — install, auth, REST, GraphQL, filter DSL, TypeScript schema typing, and more.

## Compatibility

`@cairncms/sdk` is a fork of `@directus/sdk` v16.1.2 (MIT-licensed), adapted to the CairnCMS feature set. If you already use the composable Directus SDK API (`createDirectus(url).with(rest())`, `client.request(readItems(...))`), migration is an import rename:

```diff
- import { createDirectus, rest, readItems } from '@directus/sdk';
+ import { createDirectus, rest, readItems } from '@cairncms/sdk';
```

**Not supported in v1** (see [SDK reference](https://github.com/CairnCMS/cairncms/blob/main/docs/reference/sdk.md#compatibility) for details):

- Realtime / WebSocket subscriptions (`realtime()`)
- Translation strings CRUD (`readTranslations`, `createTranslation`, etc.)
- Content versioning (`readContentVersions`, `saveToContentVersion`, etc.)
- Extensions CRUD (`readExtensions`, `updateExtension`)

## Requirements

- Node.js 20.0.0 or newer
- Browsers with native `fetch` and `URL` (all modern evergreen browsers)

## License

MIT — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE). Derived from the Directus JavaScript SDK (also MIT); copyright notices for both the original authors and CairnCMS contributors are preserved.
