---
title: Layouts
description: Browse collection items as tables, cards, calendars, or maps.
---

Layouts control how a collection page presents its items. They do not change the underlying data. They change how people browse, sort, scan, and work with that data in the app.

Use layouts when the default table view is not the clearest way to work with a collection.

## Built-in layouts

CairnCMS currently ships with four built-in collection layouts:

- **Table** for general-purpose browsing and bulk work
- **Cards** for image-first or summary-oriented collections
- **Calendar** for time-based records
- **Map** for geospatial records

Each layout has its own controls and its own requirements. Calendar needs date fields. Map needs compatible geometry or location data. Cards are most useful when the collection has an image and short summary fields.

## Change the layout for a collection

To change the current layout:

1. Open the collection in the Content module.
2. Open the page sidebar.
3. Use **Layout Options** to select the layout.
4. Adjust the layout-specific options that appear.

Depending on the layout, additional controls may also appear in the page header or directly in the page content area.

## Layout-specific behavior

### Table

Table is the most general layout. It works well for almost any collection because it stays close to the underlying row-and-column structure.

Use it when you need to:

- compare many records at once
- sort by individual fields
- change visible columns
- perform selection and bulk actions
- work with dense operational data

### Cards

Cards are useful when each item has a visual identity or a small set of summary fields. Typical examples are media collections, people, products, or article listings.

Cards support options such as:

- image source
- title and subtitle templates
- card size
- image fit
- fallback icon

### Calendar

Calendar is useful when the collection represents things that happen at a time or across a time range, such as events, bookings, or publishing schedules.

To use it well, the collection should have:

- a start date or datetime field
- optionally an end date or datetime field

### Map

Map is useful for collections that include geospatial data. It lets users browse records by location instead of by row order.

Typical uses include:

- physical sites
- service regions
- routes
- survey or asset locations

The collection needs a compatible geospatial field before this layout is useful.

## Display templates

Display templates let you combine field values and literal text into a compact label for an item. They are used in places such as card titles, card subtitles, calendar entries, and other UI surfaces that need a human-readable representation of a record.

A display template is best when it stays short. Use it for:

- names
- dates
- short status labels
- concise record summaries

Avoid using it for:

- long text bodies
- raw JSON
- verbose relational expansions

## Presets and bookmarks

Collection pages remember state: layout, sorting, filters, visible fields, and similar view settings. CairnCMS stores that state as presets.

In practice there are two useful patterns:

- a **default preset**, which controls how a view opens by default
- a **bookmark**, which is a named saved view that appears in navigation

This is useful when the same collection needs several working views, for example:

- all orders
- orders waiting for review
- orders assigned to one team
- orders filtered to one region

Bookmarks are especially useful for recurring operational work because they save a specific dataset and view configuration together.

Administrators can manage presets and bookmarks centrally under **Settings > Presets & Bookmarks**. Individual users can also create bookmarks while working in the Content module, subject to permissions.

## How to choose a layout

Use the simplest layout that matches the job:

- choose **Table** when accuracy, scanning, and bulk work matter most
- choose **Cards** when people need visual summaries
- choose **Calendar** when time is the primary axis
- choose **Map** when place is the primary axis

If a collection is used by several teams, expect it to accumulate multiple presets or bookmarks rather than one "correct" layout.
