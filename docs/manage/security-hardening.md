---
title: Security hardening
description: Production-safety configuration for CairnCMS — TLS, secrets, authentication policy, rate limiting, and the Public role.
sidebar:
  order: 3
---

CairnCMS provides primitives like auth, permissions, rate limiting, IP allowlists, and hashed passwords, but the policy decisions belong to the operator. This page covers the production-safety choices that are not on by default and the configurations that are easy to overlook.

The goal here is not exhaustive security advice; it is a checklist of the platform-specific settings that need attention before a deployment goes live.

## TLS

The CairnCMS image does not terminate TLS. Run a reverse proxy (Caddy, Traefik, nginx) or a managed load balancer in front of it. Set `IP_TRUST_PROXY=true` (the default) so CairnCMS reads the real client IP from `X-Forwarded-For`.

For production over HTTPS, set the refresh-token cookie to be secure-only:

```bash
REFRESH_TOKEN_COOKIE_SECURE=true
```

The default (`false`) is tuned for local development and should be overridden in any internet-facing deployment. Without this, refresh-token cookies can travel over plain HTTP, undermining the session-security model.

`REFRESH_TOKEN_COOKIE_SAME_SITE` defaults to `lax` and is appropriate for most deployments. Tightening to `strict` adds extra protection against cross-site request forgery in some scenarios, but it can break legitimate flows where the app is reached from external links or cross-site auth handoffs. Treat `strict` as a stricter option to evaluate, not a default-on hardening step.

For cross-domain SSO setups, `SameSite=None` is required (and `Secure=true` is mandatory in that case). See [Auth](/docs/guides/auth/).

## Secrets

The platform requires two secret values:

- **`KEY`** — instance identifier. Surfaced as the service ID in server info and health-check responses. Not part of token signing.
- **`SECRET`** — random secret used to sign access and refresh tokens. Treat as a credential. Changing it invalidates every existing token, so rotate deliberately.

Plus the database password, any SSO provider client secrets, any storage backend credentials, any SMTP password, and any static tokens generated for service accounts.

For production:

- Source secrets from a secret manager (your platform's offering, HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, etc.) rather than from a `.env` file checked into source control.
- Rotate `SECRET` carefully. Rotation invalidates every existing session. Sometimes that is the goal (compromise response), other times it is a surprise outage.
- Rotate static tokens by clearing the user's token field and reissuing.
- Never commit `.env` files containing real values.

## The Public role

The Public role applies to every unauthenticated request. By default it has no permissions; anything you add to it is granted to the entire internet.

Default discipline:

- Leave Public with no write permissions. There is essentially no legitimate reason for an unauthenticated request to create, update, or delete records on a public-facing CairnCMS instance. Spam and abuse are the certain outcome.
- For collections that need public read access, use **custom permissions** to scope which items and which fields are returned. A typical pattern: filter to `status: published` and restrict the field list to fields safe for public consumption.
- Audit the Public role periodically. It is the single most consequential surface in the permissions model.

For collections where any anonymous interaction is needed (a public form, a contact endpoint), prefer a flow with a Webhook trigger over a public-write Public-role permission. The flow can validate inputs before touching collection data.

## Admin access

Admin access bypasses every permission check. Reserve it for the small number of people who actually administrate the platform.

- Treat admin access as a flag, not a role. A "marketing admin" who only edits content does not need admin access. Give them a custom role with the permissions they actually use.
- Audit who has admin access regularly. A user who needed admin during initial setup should not still have it six months later.
- Never give admin access to a service-account static token unless that token genuinely needs full unrestricted access. Most service accounts are better off with a scoped role and a static token tied to it.

CairnCMS enforces that at least one admin role must always exist, but it does not stop you from having too many admins.

## Two-factor authentication

CairnCMS supports TOTP-based two-factor authentication. It is opt-in per user by default. For production:

- Enable **Enforce 2FA** on every role with elevated privileges (admin roles especially, but also any role with broad write or delete permissions). Users in that role cannot log in until they enroll.
- Enroll all admin users yourself before pushing 2FA enforcement to other roles, to make sure the rollout does not lock anyone out.

See [Auth](/docs/guides/auth/) for the user enrollment flow.

## Password policy

Set the password complexity policy in **Settings > Project Settings > Security**:

- **None** — no complexity requirement (the default).
- **Weak** — 8-character minimum.
- **Strong** — uppercase, lowercase, numbers, and special characters.
- **Other** — custom regex.

Strong is the recommended production baseline. The custom-regex option exists for organizations with specific compliance requirements (NIST 800-63B, ISO 27001-aligned policies, and so on).

## Account lockout and login throttling

These settings are independent of the password policy and form a separate account-protection layer:

- **Auth Login Attempts** — number of failed logins before the account is automatically locked. Default `25`. Configured under **Settings > Project Settings > Security**. Locked accounts must be reactivated by an admin (set the user's status back to Active in the User Directory).
- **`LOGIN_STALL_TIME`** — milliseconds the platform waits before responding to a failed login. Default `500`. Mitigates timing attacks against the login endpoint; do not lower it.

## IP allowlists

Each role can restrict access to specific source IPs. Set **IP Access** on the role to a comma-separated list of allowed addresses. The check runs on every authenticated request, not just login.

Two important constraints:

- The match is exact string comparison. CIDR ranges are not supported. List each address explicitly.
- The check applies *after* authentication, not before. A caller still proves their identity first; IP restrictions then determine whether their session is allowed to act.

IP allowlists are most useful for tightly scoped admin or service accounts whose legitimate caller comes from a known network, such as a CI worker, a backup script, a corporate VPN range.

## Rate limiting

Rate limiting is off by default. Turn it on for any internet-facing deployment:

```bash
RATE_LIMITER_ENABLED=true
RATE_LIMITER_POINTS=50
RATE_LIMITER_DURATION=1
RATE_LIMITER_STORE=redis  # for multi-instance deployments
```

Two layers are available:

- **Per-IP rate limiter** (`RATE_LIMITER_*`) — caps requests per IP per window. Stops casual abuse.
- **Global rate limiter** (`RATE_LIMITER_GLOBAL_*`) — caps total requests across all callers. Stops aggregate load from outpacing your infrastructure.

For a multi-instance deployment behind a load balancer, the `redis` store is required so limits are shared. Without it, each instance limits independently and the actual cap is `<configured-cap> × <instance count>`.

## CORS

CORS is off by default. Enable it only when a frontend on a different origin needs to call the API:

```bash
CORS_ENABLED=true
CORS_ORIGIN=https://app.example.com
CORS_CREDENTIALS=true
```

Avoid `CORS_ORIGIN=true` (reflects the request origin) in production. List exact origins instead. The reflective default is convenient for development and dangerous for production — it lets any origin send authenticated cross-origin requests.

When `CORS_CREDENTIALS=true`, the browser sends auth cookies on cross-origin requests; the response's `Access-Control-Allow-Origin` cannot be `*` in that case (the browser refuses), so the explicit origin list is doing real work.

## Email-link allow lists

Password reset and user invitation flows accept an optional caller-supplied return URL for the link the recipient clicks to complete the action. When a custom URL is supplied, CairnCMS validates it against an allow list:

```bash
PASSWORD_RESET_URL_ALLOW_LIST=https://app.example.com/reset
USER_INVITE_URL_ALLOW_LIST=https://app.example.com/invite
```

If no custom URL is supplied, the flow falls back to a default URL constructed from `PUBLIC_URL` (`<PUBLIC_URL>/admin/reset-password` for resets, the equivalent invitation path for invites). The default flow works without any allow-list configuration.

The allow list only gates caller-supplied URLs. Configure it whenever your frontend triggers password resets or invitations and passes its own return URL. Without an allow list, an attacker who can call the reset endpoint could redirect the recipient to a malicious site after the action completes.

## Static tokens

Static tokens are long-lived and never expire. Treat them like passwords:

- Store them in your secret manager, not in source control.
- Scope them to a service account with a narrow role, not to an admin user.
- Rotate periodically. Rotation requires regenerating the user's token field; the old token is invalid the moment the new one is set.
- Audit which static tokens exist regularly. A token tied to a deprecated integration is an unnecessary credential left active.

For interactive users (a person logging in through the app), prefer the access/refresh-token flow over static tokens. Refresh tokens have built-in expiry and rotation; static tokens have neither.

## File-relation deletion behavior

By default, deleting a file with a relation field set to `SET NULL` (the default) clears the references. The related items continue to exist with a null file pointer. This is permissive: it does not block file deletion when something still references the file.

For projects where files are critical (legal documents, audit trails, anything that should not silently disappear from related records), change the relation's `On Delete` to `RESTRICT` or `NO ACTION` so file deletion is blocked while references exist. See [Files](/docs/guides/files/) for the configuration UI.

## Database

- **Use TLS to the database** if it travels outside your trusted network. Configure `DB_SSL__*` variables to require encryption and validate certificates.
- **Use a dedicated database user** with only the privileges CairnCMS needs (CREATE, ALTER, INDEX on its own tables; SELECT/INSERT/UPDATE/DELETE on data). Avoid running CairnCMS as the database superuser.
- **For MySQL/MariaDB, set the connection charset to `utf8mb4`** to prevent silent truncation of UTF-8 characters that take more than 3 bytes (most CJK, all emoji). See [Configuration](/docs/manage/configuration/).

## Logging and accountability

Two surfaces help when investigating an incident:

- The **activity log** records create, update, delete, comment, and login events with the actor, timestamp, IP, and user-agent. Reached through the **Activity Log** button at the bottom of the sidebar. Activity is its own module, not a Settings page.
- The **server log** captures process-level information through Pino. Forward it to a centralized log destination so it survives container restarts.

For audit-heavy projects, leave activity logging on (the default) and configure the role's accountability tracking to include revisions, not just activity. Revisions let you reconstruct an item's full history; activity records what happened.

## Where to go next

- [Configuration](/docs/manage/configuration/) is the reference for every environment variable mentioned here.
- [Auth](/docs/guides/auth/) covers SSO, two-factor enrollment, and session details.
- [Permissions](/docs/guides/permissions/) covers the role and permission system the Public role and admin access flag belong to.
- [Backups](/docs/manage/backups/) covers the backup-and-recovery side of operational safety.
