---
title: Filters
description: Build queries to narrow what you see in collection views.
---

Filters let you narrow a collection to only the records that match specific conditions. They are used throughout CairnCMS: on collection pages, in permissions, in dashboards, and in automation. This guide focuses on the visual filter builder in the app.

For the lower-level rule syntax and operator reference, use the API reference pages on filters and queries.

## What a filter is

A basic filter has three parts:

- a field
- an operator
- a comparison value

For example:

- `status` is `published`
- `created_at` is after `2026-01-01`
- `assignee` is the current user

The available operators depend on the field type. Text fields, dates, numbers, booleans, and relations do not all support the same comparisons.

## Add a filter in the app

To create a filter on a collection page:

1. Open the collection in the Content module.
2. Click **Add Filter** in the Search bar.
3. Choose the field to filter on.
4. Choose the operator.
5. Enter the comparison value.

The result set updates to show only matching items.

## Nested groups with AND and OR

You are not limited to one condition. CairnCMS lets you combine conditions into groups.

- **AND** means every condition in the group must match.
- **OR** means any condition in the group may match.

This matters once filters become more expressive. For example:

- show items where `status = review` **and** `priority = high`
- show items where `assignee = current user` **or** `backup_assignee = current user`

Use groups when a flat list of conditions would change the meaning of the query.

## Dynamic variables

Some filters need values that change depending on who is signed in or when the query runs. CairnCMS supports dynamic variables for that.

Common examples include:

- `$CURRENT_USER`
- `$CURRENT_ROLE`
- `$NOW`
- `$NOW(<adjustment>)`

These are especially useful when building:

- "my work" views
- time-based views
- role-scoped presets
- permission rules

## Filtering through relationships

Filters can traverse relationships. That means you can filter one collection based on fields stored in a related collection.

Examples:

- customers whose related invoices are overdue
- products with related reviews above a rating threshold
- accounts whose related users logged in recently

In the filter builder, relational fields expand into the fields of the related collection. You then continue building the condition from there.

This is one of the most useful features in the content workspace, but it also assumes the data model is understood clearly. If a filter behaves unexpectedly, check the relationship direction and cardinality first.

## Fields that do not filter directly

Not every field type can be filtered directly.

- presentation fields do not represent stored data, so they are not filter targets
- some alias fields are only containers or relational entry points
- certain relational or computed surfaces are navigational rather than directly comparable

When a field is relational, the filter builder often uses it as a path into another collection rather than as the final comparison target.

## Good filter habits

Filters become hard to reason about when they are built casually. A few habits help:

- start with one condition and verify the result set
- add grouping only when it changes the meaning
- prefer explicit field names over broad search when the dataset is important
- save recurring filtered views as bookmarks instead of rebuilding them each time

If you are using the same filter repeatedly for operational work, turn it into a bookmark or preset instead of treating it as a temporary query every time.
