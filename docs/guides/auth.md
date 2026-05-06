---
title: Auth
description: How CairnCMS authenticates users, including passwords, SSO, two-factor, sessions, and tokens.
sidebar:
  order: 3
---

CairnCMS handles authentication directly. It supports password login, single sign-on through OpenID Connect, OAuth 2.0, LDAP, and SAML, two-factor authentication, and long-lived static tokens for service accounts. This page covers how those pieces fit together and how to configure them.

Authentication is configured per CairnCMS instance, partly through environment variables, partly through user and role settings under **Settings > Roles & Permissions**, and partly through each user's own profile (for two-factor enrollment).

## How users authenticate

A user can authenticate against a CairnCMS instance in three ways:

- **Password** — the user logs in with email and password through the app or the API.
- **Single sign-on (SSO)** — the user logs in through an external identity provider such as Google, Okta, Keycloak, or an internal SAML IdP.
- **Static token** — a service or script presents a long-lived token for API calls. Static tokens are not used for app login.

Password and SSO logins produce a session represented by a short-lived access token and a longer-lived refresh token. The refresh token is delivered as a cookie when logging in through the app and as part of the response payload when logging in through the API.

Static tokens work differently. The token itself is sent as a bearer token on each API request. There is no separate access token, JWT verification, or refresh flow.

## Password authentication

Password login is enabled by default. Each user has an email and password set on their record under **User Directory** in the app. Passwords are hashed with argon2 before storage.

The `LOGIN_STALL_TIME` environment variable controls how long failed login attempts wait before responding, mitigating timing attacks against the login endpoint.

The email-based password reset and user invite flows use URL allow lists. Any URL passed to the reset or invite endpoints must match an entry in the corresponding allow list:

```bash
PASSWORD_RESET_URL_ALLOW_LIST="https://app.example.com/reset"
USER_INVITE_URL_ALLOW_LIST="https://app.example.com/invite"
```

Without these allow lists, the corresponding flows reject any URL. This prevents email-based open-redirect attacks.

## Two-factor authentication

CairnCMS supports time-based one-time passwords (TOTP) for two-factor authentication. Users enroll from their profile by scanning a QR code with an authenticator app such as 1Password, Authy, or Google Authenticator.

To require two-factor enrollment for everyone in a role, open the role under **Settings > Roles & Permissions** and enable **Enforce 2FA**. Users in that role cannot complete login until they have enrolled.

When two-factor is enrolled, the login flow becomes:

1. The user submits email and password.
2. CairnCMS responds requesting an OTP.
3. The user submits the current OTP.
4. CairnCMS issues access and refresh tokens.

API consumers performing login on behalf of users with 2FA enabled must include the `otp` field on the login payload.

## Single sign-on

SSO lets CairnCMS delegate authentication to an external identity provider. CairnCMS supports four mechanisms:

- **OpenID Connect** — most modern providers (Google, Microsoft, Okta, Auth0, Keycloak, and similar)
- **OAuth 2.0** — providers that have not adopted OpenID Connect (GitHub, Facebook, Discord, and similar)
- **SAML** — enterprise identity providers (AWS IAM Identity Center, Azure AD, and similar)
- **LDAP** — directory services such as Active Directory

Several providers can be enabled at once. The login page shows a button for each.

### How SSO is configured

SSO is configured through environment variables. The general pattern:

```bash
AUTH_PROVIDERS="<provider1>,<provider2>"

AUTH_<PROVIDER>_DRIVER="<openid|oauth2|saml|ldap>"
AUTH_<PROVIDER>_CLIENT_ID="..."
AUTH_<PROVIDER>_CLIENT_SECRET="..."
AUTH_<PROVIDER>_DEFAULT_ROLE_ID="..."
AUTH_<PROVIDER>_ALLOW_PUBLIC_REGISTRATION="true"
AUTH_<PROVIDER>_IDENTIFIER_KEY="email"
```

`AUTH_PROVIDERS` is a comma-separated list of provider keys you want enabled. Each enabled provider needs its own block of environment variables prefixed with `AUTH_<KEY>_`.

The redirect URL the provider needs to be configured with is:

```
<your-cairncms-url>/auth/login/<provider>/callback
```

For example, with `AUTH_PROVIDERS="google"` and a CairnCMS instance at `https://cms.example.com`, the redirect URL configured with Google would be `https://cms.example.com/auth/login/google/callback`.

`ALLOW_PUBLIC_REGISTRATION` controls whether new users are auto-created on first login. With it set to `true`, anyone the IdP authenticates gets a CairnCMS user record assigned to `DEFAULT_ROLE_ID`. With it set to `false`, only users who already exist with a matching identifier can sign in.

### Worked example: Google OpenID Connect

1. In the Google Cloud Console, create or select a project.
2. Configure the OAuth consent screen with the scopes `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and `openid`.
3. Create an OAuth Client ID under **Credentials**, choosing **Web Application**.
4. Set the authorized redirect URI to `https://<your-cairncms-url>/auth/login/google/callback`. For local testing, also add `http://localhost:8055/auth/login/google/callback`.
5. Copy the Client ID and Client Secret.
6. Add the following to `.env`:

```bash
AUTH_PROVIDERS="google"

AUTH_GOOGLE_DRIVER="openid"
AUTH_GOOGLE_CLIENT_ID="<from-step-5>"
AUTH_GOOGLE_CLIENT_SECRET="<from-step-5>"
AUTH_GOOGLE_ISSUER_URL="https://accounts.google.com"
AUTH_GOOGLE_IDENTIFIER_KEY="email"
AUTH_GOOGLE_LABEL="Google"
AUTH_GOOGLE_ICON="google"
AUTH_GOOGLE_ALLOW_PUBLIC_REGISTRATION="true"
AUTH_GOOGLE_DEFAULT_ROLE_ID="<role-uuid>"
```

7. Restart the CairnCMS container.

A "Login with Google" button appears on the login page. New users matched by email get a CairnCMS user record automatically when `AUTH_GOOGLE_ALLOW_PUBLIC_REGISTRATION` is `true`.

### Provider configurations

Common providers and their driver configurations:

**Google (OpenID)**

```bash
AUTH_GOOGLE_DRIVER="openid"
AUTH_GOOGLE_CLIENT_ID="..."
AUTH_GOOGLE_CLIENT_SECRET="..."
AUTH_GOOGLE_ISSUER_URL="https://accounts.google.com/.well-known/openid-configuration"
AUTH_GOOGLE_IDENTIFIER_KEY="email"
```

**Microsoft Azure (OpenID)**

```bash
AUTH_MICROSOFT_DRIVER="openid"
AUTH_MICROSOFT_CLIENT_ID="..."
AUTH_MICROSOFT_CLIENT_SECRET="..."
AUTH_MICROSOFT_ISSUER_URL="https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration"
AUTH_MICROSOFT_IDENTIFIER_KEY="email"
```

**Okta (OpenID)**

```bash
AUTH_OKTA_DRIVER="openid"
AUTH_OKTA_CLIENT_ID="..."
AUTH_OKTA_CLIENT_SECRET="..."
AUTH_OKTA_ISSUER_URL="https://<okta-domain>/.well-known/openid-configuration"
AUTH_OKTA_IDENTIFIER_KEY="email"
```

**Auth0 (OpenID)**

```bash
AUTH_AUTH0_DRIVER="openid"
AUTH_AUTH0_CLIENT_ID="..."
AUTH_AUTH0_CLIENT_SECRET="..."
AUTH_AUTH0_ISSUER_URL="https://<auth0-domain>/.well-known/openid-configuration"
AUTH_AUTH0_IDENTIFIER_KEY="email"
```

**Keycloak (OpenID)**

```bash
AUTH_KEYCLOAK_DRIVER="openid"
AUTH_KEYCLOAK_CLIENT_ID="..."
AUTH_KEYCLOAK_CLIENT_SECRET="..."
AUTH_KEYCLOAK_ISSUER_URL="https://<keycloak-domain>/realms/<realm>/.well-known/openid-configuration"
AUTH_KEYCLOAK_IDENTIFIER_KEY="email"
```

**GitHub (OAuth 2.0)**

```bash
AUTH_GITHUB_DRIVER="oauth2"
AUTH_GITHUB_CLIENT_ID="..."
AUTH_GITHUB_CLIENT_SECRET="..."
AUTH_GITHUB_AUTHORIZE_URL="https://github.com/login/oauth/authorize"
AUTH_GITHUB_ACCESS_URL="https://github.com/login/oauth/access_token"
AUTH_GITHUB_PROFILE_URL="https://api.github.com/user"
```

If a GitHub user has not marked their email as public, CairnCMS cannot read it and the login will not match an existing user.

**AWS IAM Identity Center (SAML)**

```bash
AUTH_PROVIDERS="awssso"
AUTH_AWSSSO_DRIVER="saml"
AUTH_AWSSSO_idp_metadata="<your IAM Identity Center SAML metadata XML>"
AUTH_AWSSSO_sp_metadata=""
AUTH_AWSSSO_ALLOW_PUBLIC_REGISTRATION="true"
AUTH_AWSSSO_DEFAULT_ROLE_ID="<role-uuid>"
AUTH_AWSSSO_IDENTIFIER_KEY="email"
AUTH_AWSSSO_EMAIL_KEY="email"
```

The SAML metadata needs the leading `<?xml version="1.0" encoding="UTF-8"?>` declaration removed before being passed to CairnCMS. Map the user's email attribute as both the `Subject` (`emailAddress` type) and as the `email` attribute (`unspecified` type). The application ACS URL is `https://<your-cairncms-url>/auth/login/awssso/acs`.

For other SAML providers, replace `awssso` with your chosen key and supply the IdP metadata XML.

For LDAP, Facebook, Twitter, Discord, Twitch, Apple, and any other options not covered here, see the configuration reference under Manage > Configuration.

### Cross-domain SSO

When CairnCMS is the auth backend for a frontend on a different domain, for example, a static site that needs to read content as a logged-in user, configure refresh-token cookies for cross-domain delivery:

```bash
REFRESH_TOKEN_COOKIE_DOMAIN="cms.example.com"
REFRESH_TOKEN_COOKIE_SECURE="true"
REFRESH_TOKEN_COOKIE_SAME_SITE="None"
```

The frontend then sends users to a CairnCMS-hosted login URL with a `redirect` query parameter:

```html
<a href="https://cms.example.com/auth/login/google?redirect=https://app.example.com/login">
  Login
</a>
```

After the provider authenticates, CairnCMS sets the refresh-token cookie scoped to `cms.example.com` and redirects to `https://app.example.com/login`. The frontend then calls `POST /auth/refresh` with `credentials: 'include'` to exchange the cookie for an access token.

Cross-domain cookies require HTTPS in production. For local testing only, you can use `REFRESH_TOKEN_COOKIE_SECURE="false"` and `REFRESH_TOKEN_COOKIE_SAME_SITE="lax"`. Never run production with these settings. They expose the instance to CSRF attacks.

## Static tokens

Static tokens are long-lived access tokens attached to a specific user. They are used for service accounts, scripts, and integrations that authenticate non-interactively.

To create one:

1. Open the user under **User Directory**.
2. Expand the **Token** section in the sidebar.
3. Generate a token, save it somewhere safe, and use it in the `Authorization: Bearer <token>` header on API requests.

Static tokens carry the role and permissions of the user they belong to. They do not expire on their own. They remain valid until the token field on the user is regenerated or cleared.

For interactive users, prefer the access/refresh-token flow over static tokens.

## Sessions and refresh tokens

A successful login produces two tokens:

- an **access token**, short-lived (default 15 minutes)
- a **refresh token**, longer-lived (default 7 days)

The access token is sent as a `Bearer` token in the `Authorization` header. When it expires, the client calls `POST /auth/refresh` with the refresh token to obtain a new access token.

Defaults can be tuned through environment variables. The shipped defaults are:

```bash
ACCESS_TOKEN_TTL="15m"
REFRESH_TOKEN_TTL="7d"
REFRESH_TOKEN_COOKIE_NAME="cairncms_refresh_token"
REFRESH_TOKEN_COOKIE_SECURE="false"
REFRESH_TOKEN_COOKIE_SAME_SITE="lax"
```

These defaults favor local development. For production over HTTPS, set `REFRESH_TOKEN_COOKIE_SECURE` to `true` and consider tightening `REFRESH_TOKEN_COOKIE_SAME_SITE` to `strict`.

For app logins, the refresh token is delivered as an `httpOnly` cookie. For API logins, both tokens are returned in the JSON response body.

## App access and admin access

Two role-level flags control what authenticated users can do:

- **App access** — required to use the admin app in a browser. Users without app access can still authenticate against the API but cannot open the admin UI.
- **Admin access** — bypasses all permission checks. Reserve this for administrators; do not give it to roles that should respect access control.

Both flags are set on the role under **Settings > Roles & Permissions**, not on individual users. To create an API-only service account, make a role with neither flag set, assign the user to that role, and create a static token for them.

## IP allowlists

A role can restrict access to specific source IPs. Configure this on the role under **Settings > Roles & Permissions** by setting **IP Access** to a comma-separated list of allowed addresses. Requests from users in that role whose source IP is not in the list are rejected.

The check runs on every authenticated request, not only at login. The match is exact string comparison; CIDR ranges are not supported, so list each allowed address explicitly.

This is useful for tightly scoped admin or service accounts where the legitimate caller comes from a known network.
