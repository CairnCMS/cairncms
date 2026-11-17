---
title: Errors
description: Return useful API errors, choose an exception, and define custom errors in server extensions.
sidebar:
  label: Errors
  order: 11
---

Use the `exceptions` object in your extension's context to report invalid input, denied access, or a failed operation. Each exception supplies an HTTP status, an error code clients can check, and a message explaining the failure.

These examples use [full-authority server extensions](/docs/develop/extensions/server-extensions/). Confined extensions report failures through their results, as described in the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference.

## Return an error from an endpoint

Create an exception and pass it to `next()`. This route checks the requested export format:

```js
export default (router, { exceptions }) => {
  const { InvalidPayloadException } = exceptions;

  router.get('/format', (req, res, next) => {
    const format = req.query['format'];

    if (format !== 'csv' && format !== 'json') {
      return next(new InvalidPayloadException('Choose csv or json.', { field: 'format' }));
    }

    res.json({ format });
  });
};
```

A request with `?format=xml` returns HTTP `400` and this body:

```json
{
  "errors": [
    {
      "message": "Choose csv or json.",
      "extensions": {
        "code": "INVALID_PAYLOAD",
        "field": "format"
      }
    }
  ]
}
```

Details such as `field` appear under `extensions`. Don't use `code` as a details key, because it overwrites the exception's code.

In an async route, catch errors and pass them to `next(error)` as well. See [Endpoint extensions](/docs/develop/extensions/server-extensions/endpoints/#errors) for an example.

## Choose an exception

The context includes these common exceptions. Use an existing class when its meaning fits the failure you need to report.

| Class | Status | Code | Arguments |
| --- | --- | --- | --- |
| `InvalidPayloadException` | 400 | `INVALID_PAYLOAD` | `(message, details?)` |
| `InvalidQueryException` | 400 | `INVALID_QUERY` | `(message)` |
| `FailedValidationException` | 400 | `FAILED_VALIDATION` | Raised by validation. Use `instanceof` to recognize it when catching errors. |
| `InvalidCredentialsException` | 401 | `INVALID_CREDENTIALS` | `(message?)` |
| `ForbiddenException` | 403 | `FORBIDDEN` | `()`. Uses a fixed message. |
| `RouteNotFoundException` | 404 | `ROUTE_NOT_FOUND` | `(path)` |
| `MethodNotAllowedException` | 405 | `METHOD_NOT_ALLOWED` | `(message, { allow })`. Supply an array such as `['GET', 'POST']` for the response's `Allow` header. |
| `ContentTooLargeException` | 413 | `CONTENT_TOO_LARGE` | `(message)` |
| `UnsupportedMediaTypeException` | 415 | `UNSUPPORTED_MEDIA_TYPE` | `(message, details?)` |
| `UnprocessableEntityException` | 422 | `UNPROCESSABLE_ENTITY` | `(message)` |
| `HitRateLimitException` | 429 | `REQUESTS_EXCEEDED` | `(message, { limit, reset })`, where `reset` is a `Date` |
| `ServiceUnavailableException` | 503 | `SERVICE_UNAVAILABLE` | `(message, details?)`. `details` may name the `service`. |
| `BaseException` | Your status | Your code | `(message, status, code, details?)`. Extend this class to define a custom error. |

## Define a custom error

Extend `exceptions.BaseException` when your application needs its own error code or details. Define the class where your extension receives `exceptions`. Use the injected classes so CairnCMS recognizes the errors you create. Bundling a separate copy of the exceptions package gives you different classes that the API will not recognize.

Choose a code starting with an uppercase letter and containing only uppercase letters, digits, and underscores, such as `QUOTA_EXCEEDED`. The realtime item protocol replaces other codes with `INTERNAL_ERROR`.

This flow operation checks a tenant's quota. It assumes a `tenants` collection with numeric `usage` and `quota` fields:

```js
import { defineOperationApi } from '@cairncms/extensions-sdk';

export default defineOperationApi({
  id: 'check-quota',
  handler: async ({ tenantId }, { services, exceptions, accountability, getSchema, database }) => {
    const { ItemsService } = services;

    class QuotaExceededException extends exceptions.BaseException {
      constructor(quota) {
        super(`The tenant has used its quota of ${quota}.`, 429, 'QUOTA_EXCEEDED', { quota });
      }
    }

    const tenants = new ItemsService('tenants', {
      schema: await getSchema({ database }),
      knex: database,
      accountability,
    });
    const tenant = await tenants.readOne(tenantId, { fields: ['usage', 'quota'] });

    if (tenant.usage >= tenant.quota) {
      throw new QuotaExceededException(tenant.quota);
    }

    return { remaining: tenant.quota - tenant.usage };
  },
});
```

When the tenant reaches its quota, the operation throws `QuotaExceededException` with the `QUOTA_EXCEEDED` code and a `quota` detail.

When an endpoint or a filter hook raises the error, REST and GraphQL clients can receive its message and details. The [realtime item protocol](/docs/api/realtime/item-protocol/) returns the code with a fixed message and no details. [GraphQL over WebSocket](/docs/api/realtime/graphql/) follows GraphQL error formatting.

In TypeScript, add a type parameter to check the details. Replace the class inside the handler above with:

```ts
class QuotaExceededException extends exceptions.BaseException<{ quota: number }> {
  constructor(quota: number) {
    super(`The tenant has used its quota of ${quota}.`, 429, 'QUOTA_EXCEEDED', { quota });
  }
}
```

The compiler now requires a numeric `quota` in the details passed to `super()`, and `error.extensions.quota` is typed as `number`.

## Use errors in hooks and flows

Throw an exception from a [filter hook](/docs/develop/extensions/server-extensions/hooks/#filter-hooks) to reject the operation it is checking. Action hooks cannot veto the operation. Errors from action hooks are caught and logged.

In a [flow operation](/docs/develop/extensions/server-extensions/operations/#success-and-failure-paths), throwing takes the failure path. The exception's `message`, `code`, `status`, and `extensions` become the operation's result in the data chain, where later operations can read them.

A blocking filter flow rejects the original request only if its last operation rejects. A failure path that recovers lets the request continue. If the final rejection is a platform exception, its message, status, and code reach the client without the details.

## Diagnose a failure

Set `LOG_LEVEL=debug` to see platform exceptions that reach the API's error handler.

When logging from your extension, choose a diagnostic that identifies the failed operation. The injected `logger` does not redact arbitrary error messages or objects, which may contain credentials or request data. For example, inside an endpoint's `catch` block:

```js
logger.warn('The weather service request failed.');
next(new exceptions.ServiceUnavailableException('The weather service is unavailable.', { service: 'weather' }));
```

Both `logger` and `exceptions` come from the endpoint's context.
