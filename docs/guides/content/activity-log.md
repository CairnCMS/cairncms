---
title: Activity log
description: Audit actions that pass through CairnCMS across the system.
---

The activity log is the system-wide feed of data-changing actions that passed through CairnCMS. Use it when you need to answer questions like:

- who changed this record
- when was it changed
- what collection was affected
- which client or user performed the action

It is an auditing and accountability surface, not a general-purpose reporting tool.

## How to open it

The activity log is reached through the **Activity Log** button at the bottom of any page's sidebar. It opens the Activity Feed, with built-in filters in the navigation pane for All Activity, My Activity, and common action types (Create, Update, Delete, Comment, Log in).

What you see depends on your role:

- administrators see activity from every user
- other users see only their own activity

The Activity Feed has its own route at `/admin/activity` but is not pinned to the module bar by default.

From there, the feed behaves like a regular collection page — you can search, sort, filter, and open individual entries.

## What an activity entry contains

An activity entry can include details such as:

- user
- action
- timestamp
- IP address
- user agent
- collection
- item identifier
- comment data when applicable

The exact shape depends on the event, but the purpose is consistent: enough context to understand what happened and who did it.

## What the activity log can and cannot see

The activity log only records actions that go through CairnCMS itself.

That means:

- API writes made through CairnCMS are tracked
- app changes made through CairnCMS are tracked
- direct database writes that bypass CairnCMS are **not** tracked

If your team changes the database outside the platform, the activity log will not reconstruct those events after the fact.

## Filtering the feed

The activity log becomes more useful once filtered.

Common patterns include:

- only one user
- only one collection
- only updates or deletes
- only recent changes

This is often the fastest way to debug an unexpected record change or confirm the sequence of events around an incident.

## Relationship to revisions

The activity log is system-wide. Revisions are item-specific.

Use the activity log when you need a broad audit trail across collections. Use revisions on an individual item when you need to inspect its history in detail.

These features are related, but they answer different questions.

## Editing after inspection

If an activity entry leads you to a non-system item that needs correction, an administrator can reopen the underlying record from the activity detail and make the fix there. The correction is then logged as a new activity entry.

This preserves the audit trail instead of mutating the existing entry in place.
