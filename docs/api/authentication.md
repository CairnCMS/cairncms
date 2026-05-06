---
title: Authentication
description: Token types, login and refresh flows, SSO providers, two-factor authentication, and how to attach credentials to requests.
---

Most CairnCMS requests need an access token for anything that maps onto a non-Public role's permissions. Endpoints covered by the Public role's permissions are reachable without one. The platform issues two kinds of tokens: short-lived JSON Web Tokens for interactive sessions, and long-lived static tokens for service accounts. This page covers both, the login and refresh flow that produces JWTs, and the SSO and two-factor surfaces that sit on top.

## Token types

CairnCMS recognizes two token shapes at request time:

- **Access tokens (JWT).** Signed with `SECRET`, short-lived, issued by `/auth/login` and rotated by `/auth/refresh`. Carry the user's role and access flags inline so the request can be authorized without an extra database lookup. Default TTL is `15m`, configurable via `ACCESS_TOKEN_TTL`.
- **Static tokens.** Stored as plain text on the user record (`directus_users.token`), never expire, and require a database lookup on every request. Intended for service accounts where rotation is operator-managed rather than handled by a refresh flow.

The middleware identifies which shape was sent by inspecting the token: anything that parses as a CairnCMS-issued JWT is treated as a JWT; anything else is looked up against `directus_users.token`. There is no separate header or scheme.

## Attaching a token

Two ways to send a token:

- **Authorization header** — `Authorization: Bearer <token>`. Preferred for server-to-server calls and any context where you control the request headers. The platform follows the bearer scheme exactly: case-insensitive scheme name, single space, then the token.
- **`access_token` query parameter** — `?access_token=<token>`. Useful for asset URLs and other contexts where setting a header is inconvenient (an `<img>` tag, for example). Avoid in shared logs and avoid for any other request that does not need it — query parameters are commonly logged by web servers and CDNs.

If both are present, the header takes precedence. There is no documented behavior for sending different tokens through both so it's not recommended.

Endpoints that map to permissions configured for the Public role can be reached without a token. Anything outside the Public role's permitted set returns `403 FORBIDDEN`.

## Login

Exchange credentials for a JWT.

```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "<password>",
  "mode": "json",
  "otp": "<optional one-time-password>"
}
```

Body fields:

- **`email`** (required) — the user's email.
- **`password`** (required) — the user's password.
- **`mode`** (optional) — `json` (default) or `cookie`. Determines where the refresh token is delivered.
- **`otp`** (optional) — the one-time-password from the user's TFA app, if TFA is enabled on the account.

A successful response:

```json
{
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "M3p7y4...",
    "expires": 900000
  }
}
```

`expires` is the access token's lifetime in milliseconds. With `mode: "cookie"`, `refresh_token` is omitted from the body and set as an `httpOnly` cookie instead — see [Refresh-cookie mode](#refresh-cookie-mode) below.

The endpoint stalls failed responses for `LOGIN_STALL_TIME` milliseconds (default `500`) before returning, to mitigate timing attacks against the login surface. Successful responses are not stalled.

## Refresh

Trade a refresh token for a new access token.

```http
POST /auth/refresh
Content-Type: application/json

{
  "refresh_token": "<refresh-token>",
  "mode": "json"
}
```

If `mode` is omitted, the platform infers it from the request: a body that contains `refresh_token` defaults to `json`; a body that does not defaults to `cookie` and reads the token from the configured refresh-token cookie. You almost always want to set `mode` explicitly to avoid surprise.

The response shape matches login:

```json
{
  "data": {
    "access_token": "<new-jwt>",
    "refresh_token": "<rotated-refresh-token>",
    "expires": 900000
  }
}
```

Refresh tokens rotate on every refresh. The token returned by the call is a new one, and the previously-issued one is invalidated. Holding onto the old refresh token after a refresh is a logout. This is intentional: token theft becomes detectable when the legitimate client and the attacker both try to refresh and the second one fails.

## Logout

Invalidate a refresh token.

```http
POST /auth/logout
Content-Type: application/json

{
  "refresh_token": "<refresh-token>"
}
```

The endpoint accepts the refresh token in either the JSON body or the configured refresh-token cookie, whichever the client used to obtain it. If only the cookie is present, the body can be omitted; if both are present, the body wins. When the cookie was used, the platform also clears it on the response.

Logout removes the refresh token from the platform's session store; subsequent attempts to use it return `INVALID_CREDENTIALS`. The associated access token is still valid for the rest of its TTL. There is no server-side revocation list for active access tokens, so a short `ACCESS_TOKEN_TTL` is the protection there.

## Password reset

Two endpoints, two steps.

### Request a reset email

```http
POST /auth/password/request
Content-Type: application/json

{
  "email": "user@example.com",
  "reset_url": "https://app.example.com/reset"
}
```

Sends a password-reset email to the user with a link to complete the reset. `reset_url` is optional; without it, the email link points at `<PUBLIC_URL>/admin/reset-password`. When supplied, the URL must be on the configured `PASSWORD_RESET_URL_ALLOW_LIST`, which is a security measure that prevents email-based open-redirect attacks.

The endpoint returns `200` whether or not the email matched a known user. This is intentional: a different response for known and unknown emails would leak whether an account exists.

### Complete the reset

```http
POST /auth/password/reset
Content-Type: application/json

{
  "token": "<token-from-email>",
  "password": "<new-password>"
}
```

The `token` is the signed token included in the reset link (the `?token=` query parameter on the URL the user receives in email). On success, the response is empty with status `200`. The user can now log in with the new password.

## SSO providers

CairnCMS supports four SSO driver shapes alongside the local-password provider: **OAuth2**, **OpenID Connect**, **LDAP**, and **SAML**. Each configured provider gets its own login subtree under `/auth/login/<provider-name>`, where `<provider-name>` is the name from the `AUTH_<NAME>_DRIVER` environment variable that configures it (`AUTH_GOOGLE_DRIVER=openid` produces `/auth/login/google`). The route shape inside that subtree depends on the driver:

- **OAuth2 and OpenID Connect.** `GET /auth/login/<provider>` starts the flow by redirecting the browser to the identity provider's authorization URL. The IdP redirects back to `/auth/login/<provider>/callback`, accepted as both `GET` and `POST` to handle implementations that prefer either, at which point CairnCMS exchanges the code for tokens and finishes the login. Browser flow; not suitable for direct programmatic use.
- **SAML.** `GET /auth/login/<provider>` redirects to the IdP's SSO URL with a SAML request. The IdP posts the signed assertion back to `POST /auth/login/<provider>/acs`. `GET /auth/login/<provider>/metadata` returns the service-provider metadata XML for IdP configuration. `POST /auth/login/<provider>/logout` initiates SAML single-logout when supported.
- **LDAP.** `POST /auth/login/<provider>` accepts a JSON body with the user's credentials, the same shape as the local-password login. Suitable for direct programmatic use because there is no IdP redirect step.

The login flow that ends a successful SSO authentication produces the same `access_token` / `refresh_token` / `expires` response as `/auth/login`. The `mode: "cookie"` option applies the same way for browser-flow drivers; the refresh-token cookie is set on the final redirect response when configured.

The configured providers are listed on the API surface itself:

```http
GET /auth
```

```json
{
  "data": [
    { "name": "google", "driver": "openid", "icon": "google" },
    { "name": "ad", "driver": "ldap", "icon": "active-directory" }
  ],
  "disableDefault": false
}
```

`disableDefault` reflects `AUTH_DISABLE_DEFAULT`; when `true`, the local-password `/auth/login` route is not registered and only the per-provider routes are available. The admin app uses this list to render the provider buttons on the login screen.

## Two-factor authentication

TFA is per-user and time-based (TOTP). Three endpoints under `/users/me`, all requiring a valid access token:

```http
POST /users/me/tfa/generate
Content-Type: application/json

{ "password": "<current-password>" }
```

Returns `{ "data": { "secret": "...", "otpauth_url": "otpauth://totp/..." } }`. The user scans the URL into an authenticator app to register the secret.

```http
POST /users/me/tfa/enable
Content-Type: application/json

{ "secret": "<secret-from-generate>", "otp": "<code-from-app>" }
```

Activates TFA after verifying the code. From this point, the user's logins must include `otp` in the request body.

```http
POST /users/me/tfa/disable
Content-Type: application/json

{ "otp": "<code-from-app>" }
```

Disables TFA after verifying a current code.

A role can require TFA across all of its users by setting `enforce_tfa: true`. The flag is policy carried on the role record; the API does not return a special "TFA-required" state on login, and a user whose role has `enforce_tfa: true` but who has not yet enabled TFA still receives a normal access token. The admin app's router uses the flag to redirect those users into a setup screen, and the TFA setup endpoints themselves are the only routes that get special server-side handling for this case. If you build your own client, treat the role flag as guidance for your own UX. The server is not gating arbitrary requests behind TFA enrollment.

## Static tokens

Static tokens live on the user record. To issue one, set `directus_users.token` to a sufficiently random string:

```http
PATCH /users/<user-id>
Content-Type: application/json
Authorization: Bearer <admin-token>

{ "token": "<long-random-string>" }
```

The token is then valid until cleared (`{ "token": null }`) or the user's `status` is set to anything other than `active`.

When to use static tokens:

- **Service accounts** — automation or integrations that hit the API on a schedule and do not interactively log in.
- **CI/CD steps** — scripts that promote schema or config between environments and need a stable credential.

Two security considerations:

- **Static tokens are stored plain text** on the user row. Anyone with read access to that row sees the token. The default permission setup hides the column from non-admin reads, but treat the database row itself as sensitive.
- **Static tokens never expire.** Rotate them periodically and revoke any that may have leaked. Prefer creating a dedicated user per integration so revoking one credential does not require shutting off a shared account.

Where possible, prefer the JWT/refresh-token flow even for non-interactive callers — `ACCESS_TOKEN_TTL` and refresh-token rotation are the better protections against token theft. Reach for static tokens when something specific to the integration (a service that cannot manage refresh state, a third-party tool that takes a single token) makes the JWT flow impractical.

## Refresh-cookie mode

For interactive web clients, `mode: "cookie"` is often the right choice. The refresh token is set as an `httpOnly` cookie that the browser sends back automatically, which:

- Removes the refresh token from JavaScript-readable storage. An XSS exploit that can read `localStorage` cannot read an `httpOnly` cookie.
- Makes refresh trivially automatic — the browser includes the cookie on `/auth/refresh` calls without any client-side glue.

Cookie behavior is governed by four environment variables (see [Configuration](/docs/manage/configuration/) for full details):

- `REFRESH_TOKEN_COOKIE_NAME` — the cookie's name. Default `cairncms_refresh_token`.
- `REFRESH_TOKEN_COOKIE_SECURE` — set to `true` in production over HTTPS. Default `false`.
- `REFRESH_TOKEN_COOKIE_SAME_SITE` — `lax` (default), `strict`, or `none`. `none` requires `secure: true` and is the right choice for cross-domain SSO setups.
- `REFRESH_TOKEN_COOKIE_DOMAIN` — domain to scope the cookie to.

The cookie carries the `httpOnly` flag in all configurations. For setups where the frontend and the API live on the same origin, the defaults work without further configuration. For cross-origin setups, `SameSite=None` plus `Secure=true` plus a CORS-allowed origin is the standard combination.

## Auth-specific errors

In addition to the global error codes in [Introduction](/docs/api/introduction/#errors), authentication endpoints can return:

| Code | HTTP status | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Login failed, refresh token is unknown or invalidated, or no token was provided. |
| `INVALID_OTP` | 401 | TFA code rejected. |
| `INVALID_IP` | 401 | The role's IP allow list rejected the source IP. |
| `INVALID_PROVIDER` | 401 | Provider name does not match the user's configured provider. |
| `TOKEN_EXPIRED` | 401 | Access or refresh token aged out. Refresh, or log in again. |
| `INVALID_TOKEN` | 403 | Token is structurally invalid or signed with a different secret. |
| `USER_SUSPENDED` | 401 | The user's `status` is not `active`. |

`INVALID_CREDENTIALS` is intentionally vague — it covers wrong password, unknown email, and unknown refresh token, so the response does not distinguish between "no such user" and "wrong password" for an attacker probing for valid emails.

## GraphQL

Every REST authentication endpoint has a GraphQL mutation equivalent on `/graphql/system`:

```graphql
mutation {
  auth_login(email: "user@example.com", password: "<password>", mode: cookie) {
    access_token
    refresh_token
    expires
  }

  auth_refresh(refresh_token: "<token>", mode: json) {
    access_token
    refresh_token
    expires
  }

  auth_logout(refresh_token: "<token>")

  auth_password_request(email: "user@example.com", reset_url: "https://app.example.com/reset")

  auth_password_reset(token: "<token-from-email>", password: "<new-password>")
}
```

The semantics, error codes, and side effects match the REST routes. The `mode` argument on `auth_login` and `auth_refresh` works the same way as on REST: `cookie` sets the refresh token as an `httpOnly` cookie on the response, `json` returns it in the response body. SSO providers and TFA endpoints are not in the GraphQL surface — those flows go through REST.

## Where to go next

- [Auth](/docs/guides/auth/) — the operator-side configuration for SSO providers, TFA enforcement, and password policy.
- [Users](/docs/api/system-collections/) — managing user records, roles, and the static-token field.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL that authenticated requests use to read and write data.
- [Configuration](/docs/manage/configuration/) — every auth-related environment variable in one place.
