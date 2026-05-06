---
title: Users
description: The User directory, user profiles, statuses, and how users relate to roles and permissions.
---

The User directory is the built-in module for managing user accounts. It is reached from the people icon in the module bar.

A user is a row in `directus_users`. Each user has an email, a password (or an SSO identifier), a status, and a role. The role is what determines what the user can see and do — see [Permissions](/docs/guides/permissions/) for how access is configured.

## The User directory

The User directory page lists every user the current viewer can see. It uses the same controls as a collection page: search, filter, sort, layout, and bulk actions. The navigation pane on the left groups users by role, so you can quickly jump to "all admins" or "all editors" without filtering.

A role with admin access sees every user. A non-admin role can only see users it has been granted read permission on (`directus_users` read).

## Creating users

There are two paths for adding users.

### Invite

Use Invite when you want a person to set their own password. The invitee gets an email with a link to a CairnCMS-hosted page where they choose a password and complete their account.

1. Open the User directory.
2. Click the invite button (person-with-plus icon) in the page header.
3. Enter one or more email addresses, separated by commas or new lines.
4. Choose the role to assign to the invited users.
5. Click **Invite**.

The invitee receives an email with a link to set their password. Until they accept, their user record exists with the `Invited` status and cannot log in.

The invite URL must match an entry in `USER_INVITE_URL_ALLOW_LIST`. See [Auth](/docs/guides/auth/) for that allow-list configuration.

### Create directly

Use Create when you want to set the password yourself, or when you are scripting account provisioning through the app:

1. Open the User directory.
2. Click the create button in the page header.
3. Enter at least an email address. Other fields can be left for later.
4. Save.

The new user starts with the `Draft` status and no role until you set them. Draft users cannot log in.

You can also invite users from a role's detail page under **Settings > Roles & Permissions**. The role detail page has its own invite button that pre-selects the role.

## User profile fields

Every user has a profile page. Your own profile is reachable by clicking your avatar at the bottom of the module bar; other users' profiles are reachable from the User directory if your role has read access to `directus_users`. The page is the same component in both cases, but what is shown and what is editable depends on your role's permissions — an admin sees and can edit every field; a regular user viewing their own profile sees only the fields their role grants self-update on.

The default fields on a user record are:

- **First Name** / **Last Name**
- **Email** — must be unique
- **Password** — hashed with argon2 before storage; never returned by the API
- **Avatar** — an image file
- **Location** — free text
- **Title** — free text job title
- **Description** — free-form notes
- **Tags** — keywords for filtering and search

Custom fields can be added through **Settings > Data Model > Directus Users** the same way you add fields to any other collection. Built-in fields cannot be removed.

### Preferences

Preferences are profile fields a user typically edits for themselves:

- **Language** — overrides the project default language for this user
- **Theme** — Light, Dark, or System (matches the OS preference)
- **Two-Factor Authentication** — backed by the `tfa_secret` field; configured by scanning a TOTP QR code from the user's profile
- **Email Notifications** — whether the user receives notification emails

Whether a user can edit these themselves depends on the role's update permissions on `directus_users` scoped to `id = $CURRENT_USER`. The standard preset applied when App Access is enabled grants self-update on language, theme, and `tfa_secret`, along with most general profile fields. Email Notifications is not in the default preset. Add it to the role's permissions if you want users to manage their own notification setting.

### Admin-only fields

The following fields can only be edited by admins (or by users with explicit update permission on those fields):

- **Status** — see [User status](#user-status) below
- **Role** — which role this user is assigned to
- **Token** — a long-lived static API token for this user; see [Auth](/docs/guides/auth/) for how it's used
- **Provider** — the SSO provider that authenticated this user, if any. Editable by admins; forced read-only for non-admins on existing users.
- **External Identifier** — the user's identifier on the SSO provider. Same editability rules as Provider.

### Read-only sidebar info

The user detail sidebar exposes:

- **User Key** — the user's UUID
- **Last Page** — the last app page the user visited
- **Last Access** — when the user last hit the app or API

## User status

Status determines whether a user can authenticate.

- **Draft** — incomplete user; cannot log in
- **Invited** — pending invite acceptance; cannot log in until they set a password
- **Active** — the only status that allows login
- **Suspended** — temporarily disabled; cannot log in. This is what role-deleted users get set to automatically.
- **Archived** — soft-deleted; cannot log in

Only **Active** allows authentication. The others all block login but leave the user record (and any references to it) in place.

## Archiving and deleting

Users can be archived (soft-delete) or deleted (permanent).

To archive a user, open their detail page and click the archive button in the header. This sets their status to `Archived` and prevents login. Archived users still appear in references — for example, as the owner of files or items they created.

To delete a user, select them on the User directory page and click the delete button. Confirm the dialog. This is permanent and cannot be undone. References to deleted users may break depending on the foreign-key constraints on those references.

For most cases prefer archiving. Reserve deletion for users that should leave no trace, such as test or duplicate accounts created in error.

## Users without a role

When a role is deleted, every user assigned to that role is set to `role = null` and `status = suspended` automatically. Such users effectively have only Public-role permissions and cannot log in until you assign them a new role and reactivate them.

Users can also exist with `role = null` from the start, for example, an admin can clear the role on a user record manually. Same effect: Public-role permissions and login blocked unless their status is also active and the Public role allows app access (it does not by default).

## Where to go next

- [Permissions](/docs/guides/permissions/) covers how roles control what users can do.
- [Auth](/docs/guides/auth/) covers passwords, SSO, two-factor enforcement, and static tokens.
