# @cairncms/sdk

A typed, composable JavaScript client for [CairnCMS](https://github.com/CairnCMS/cairncms). Works in browsers and Node.js. Uses the built-in `fetch` API — zero runtime dependencies.

```bash
npm install @cairncms/sdk
```

## Quick start

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

const client = createCairnCMS('http://localhost:8055').with(rest());

const articles = await client.request(readItems('articles'));
```

Compose the features you need: `rest()` for REST, `graphql()` for GraphQL, `authentication()` for login/refresh flows, `staticToken()` for pre-issued tokens.

```ts
import { createCairnCMS, rest, authentication, readMe } from '@cairncms/sdk';

const client = createCairnCMS('http://localhost:8055')
  .with(authentication('json'))
  .with(rest());

await client.login('admin@example.com', 'password');

const me = await client.request(readMe());
```

## Documentation

Full reference: [`docs/reference/sdk.md`](https://github.com/CairnCMS/cairncms/blob/main/docs/reference/sdk.md) — install, auth, REST, GraphQL, filter DSL, TypeScript schema typing, and more.

## Compatibility

`@cairncms/sdk` is a fork of `@directus/sdk` v16.1.2 (MIT-licensed), adapted to the CairnCMS feature set. If you already use the composable Directus SDK API, migration is an import rename plus a function name update. The CairnCMS SDK exposes the factory as `createCairnCMS` (and its return type as `CairnCMSClient`). Schema and command names (`readItems`, `readMe`, etc.) are unchanged.

```diff
- import { createDirectus, rest, readItems } from '@directus/sdk';
- const client = createDirectus(url).with(rest());
+ import { createCairnCMS, rest, readItems } from '@cairncms/sdk';
+ const client = createCairnCMS(url).with(rest());
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
