---
title: Permissions
description: Roles, role configuration, CRUDS permissions, custom rules, and the built-in administrator and public roles.
sidebar:
  order: 5
---

CairnCMS controls access through roles and permissions. A **role** is a named bundle of access rules. Each user is assigned one role. **Permissions** define what that role can do on each collection for each of create, read, update, delete, and share.

Permissions are configured under **Settings > Roles & Permissions**. Permissions are stored on the role, not on individual users; assigning a different role to a user instantly changes what they can do.

## The Public role

The **Public** role defines what unauthenticated requests can do. It is the role that applies when there is no token on a request.

Public is the only system-reserved role. It exists as a real role record with the reserved nil UUID `00000000-0000-0000-0000-000000000000` and the key `public`. Several special properties apply:

- it cannot be deleted
- users cannot be assigned to it
- its access flags (`admin_access`, `app_access`, `enforce_tfa`, `ip_access`) cannot be changed
- only its display fields (name, icon, description) are editable, for translations and presentation

All Public-role permissions are deny-by-default. Anything you grant to Public is granted to every unauthenticated request hitting the API. Treat changes to this role with care.

## Admin access

Admin access is a role flag, not a separate built-in role. Any role with `admin_access` enabled bypasses all permission checks; the role's name and other settings do not matter.

CairnCMS requires that at least one role with admin access exists. The last remaining admin role cannot be deleted, and you cannot turn off its `admin_access` flag, until another admin role exists.

When CairnCMS is first set up, an admin role is created so an initial administrator user can be assigned. That role is otherwise a regular role. It can be renamed, modified, deleted once another admin role exists, or have its admin flag toggled off.

## Creating a role

To create a role:

1. Go to **Settings > Roles & Permissions**.
2. Click the create button in the page header.
3. Enter a unique role name.
4. Set **App Access** and **Admin Access**. App Access defaults to enabled; Admin Access defaults to disabled.
5. Save.

If the role is created with App Access enabled and Admin Access disabled, the create flow also seeds a recommended set of permissions on system collections so the role can sign in to the app immediately. You can adjust those permissions afterward, or reset them through the role detail page.

After creation, the role's detail page lets you configure its permissions and other settings.

## Configuring a role

A role record stores more than just its permissions. The role detail page exposes:

- **Role Name** — the display name
- **Role Icon** — the icon used wherever the role is referenced in the app
- **Description** — a short note explaining the role's purpose
- **App Access** — required for users in this role to log in to the admin app. Toggling this flag does not change permissions on its own; the system collection permissions section has reset actions for App Access Minimum and Recommended Defaults if you need to apply or reapply them.
- **Admin Access** — bypasses all permission checks. When enabled, the permissions section becomes read-only because the role's permissions no longer matter.
- **IP Access** — a comma-separated list of allowed source IPs. Empty means any IP is allowed. The check is exact-string matching; CIDR ranges are not supported.
- **Enforce 2FA** — requires every user in the role to enroll in TOTP two-factor authentication before they can complete login.
- **Users in Role** — a list of users currently assigned to this role.

App Access and Admin Access also have implications outside this page. See the [Auth](/docs/guides/auth/) guide for how each one affects the login flow.

## Configuring permissions

Each role has a permissions matrix: collections as rows, the five CRUDS actions as columns. Click a cell to set permissions for that collection-action pair.

Each cell takes one of three values:

- **All Access** — the role can perform that action on every item in the collection
- **No Access** — the role cannot perform that action at all
- **Use Custom** — opens a drawer for fine-grained rules

To grant or restrict every action on a collection in one click, hover over the collection name to reveal **All** and **None** buttons.

If the role has Admin Access enabled, the permissions matrix is disabled because admin access supersedes per-collection rules.

## Custom permissions

The Use Custom option opens a drawer with up to four configuration tabs, depending on the action:

- **Item Permissions** — a filter rule that restricts which items the action applies to. For example, "only items where `status = published`" or "only items where `owner = $CURRENT_USER`."
- **Field Permissions** — limits which fields are visible (read) or editable (create, update). The role can read or write only the fields you toggle on.
- **Field Validation** — a filter rule that the input must satisfy on create or update. For example, "the `priority` field must be one of `low`, `medium`, `high`."
- **Field Presets** — JSON values that prefill fields on create or update. The user sees the prefilled value and can override it unless the field is also restricted by other rules.

Item Permissions and Field Validation use the same filter-rule syntax as the rest of the platform — see [Filters](/docs/guides/content/filters/) for the operator reference and [Auth](/docs/guides/auth/) for dynamic variables like `$CURRENT_USER`.

A common pattern is to combine Item Permissions with Field Permissions: scope which rows the role can touch, then within those rows scope which fields it can read or write.

## System collection permissions

System collections power the platform itself: `directus_users`, `directus_roles`, `directus_files`, `directus_dashboards`, and so on. They are hidden from the permissions matrix by default. Click **System Collections** at the bottom of the matrix to expand them.

When App Access is enabled on a role, two reset buttons appear at the bottom of the system collection list:

- **App Access Minimum** — sets the bare minimum permissions a user needs to log in to the admin app and view their own profile. These permissions are then locked and cannot be removed.
- **Recommended Defaults** — sets a sensible starting set of system permissions that you can then tune.

Use App Access Minimum when you want a tightly scoped role that should only have the access you explicitly grant on top. Use Recommended Defaults when you want a usable starting point and plan to reduce from there.

## Deleting a role

To delete a role, open it under **Settings > Roles & Permissions** and click the delete button in the page header. Confirm the deletion in the dialog.

A role with admin access cannot be deleted if it is the last one. At least one admin role must always exist. The Public role cannot be deleted at all; it is system-reserved.

When a role is deleted while users are still assigned to it, those users have their role cleared (`role` set to `null`) and their status set to `suspended`. They cannot log in until you assign them a new role and set their status back to active.

## Workflows

Roles and permissions are also the foundation for workflow patterns: structured stages for content authoring, review, and publication. A simple workflow can be built entirely with custom permissions, for example, an author role that can create drafts and submit them but cannot publish, plus an editor role that can update the status from `submitted` to `published`. More involved workflows combine custom permissions with flows for notifications, automatic status changes, or external integrations.

There is no separate "workflows" feature to configure. Roles, custom permissions, filter rules, and flows compose into whatever workflow shape your project needs.

## Where to go next

- [Users](/docs/guides/users/) covers user records, role assignment, and the user directory.
- [Auth](/docs/guides/auth/) covers password login, SSO, two-factor authentication, and static tokens.
- [Automate](/docs/guides/automate/) covers flows, which are often used together with custom permissions for workflow patterns.
