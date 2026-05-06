---
title: Shares
description: Generate links that grant scoped access to single records.
---

Shares let you grant access to one record without making the whole collection public and without creating a full user account for the recipient.

This is useful when someone needs to review or consume a single item, but does not otherwise belong inside the admin app.

## What a share is

A share is a link to one item. The shared view is scoped to that item and uses a role to determine what can be seen through the link.

In practice, a share can be constrained with options such as:

- role
- password
- start date
- end date
- maximum uses

The resulting link points to a dedicated shared view rather than a normal admin page.

## Shares are read-only

Shares are intended for controlled viewing of a record. They are not a replacement for authenticated editing access.

If someone needs to work inside the full system, create a user and give that user an appropriate role instead.

## Create a share

To create a share for an item:

1. Open the item in the Content module.
2. Open the **Shares** section in the sidebar.
3. Create a new share.
4. Set the share options you need.
5. Save it, then copy or send the generated link.

From that point, the share can be:

- copied as a link
- sent by email
- edited
- deleted

## The role attached to a share

The most important part of a share is the role it inherits permissions from.

That role controls:

- which fields are visible
- which related collections can be read
- whether the recipient can see only the primary item or also certain related data

Because of that, shares are safest when the role is deliberate and narrow. Do not treat the role selector as a cosmetic setting. It is the access model behind the shared link.

## Collection- and item-level control

Whether a user can create shares at all depends on that user's own role and permissions.

At the role level, you can control:

- which collections may be shared
- which items in those collections may be shared
- which fields will be visible through the shared link

This is where shares move from a convenience feature to an operational one. A carefully scoped share role can be useful. A loosely scoped one can expose more than intended.

## Testing shares safely

When testing a share, do it in a signed-out browser session or an incognito window.

If you open the link while logged into the admin app, the result can be misleading because your authenticated session may route you into the normal app instead of showing the actual external share experience.

## When to use shares

Shares are a good fit when:

- someone needs to review one record
- you need a time-limited external link
- the recipient should not be a full user
- the access model should be narrower than making a collection public

They are not the right tool for long-term collaborative access across many records. That is what roles, users, and normal authenticated access are for.
