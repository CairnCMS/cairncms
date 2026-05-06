---
title: Insights
description: Build no-code dashboards from your live data using panels and global variables.
---

Insights is the built-in module for building analytics dashboards from data already in CairnCMS. It is reached from the chart icon in the module bar.

A dashboard is a drag-and-drop canvas of **panels**. Each panel is a small unit of analytics or interaction: a list of records, an aggregate metric, a time-series chart, or a global variable that other panels can read. Dashboards run against the live database, so the values reflect whatever the data looks like at the moment the panel is rendered.

## Dashboards

Dashboards are created from the Insights overview page. Each dashboard has a name, an icon, an accent color, and an optional note. From there, the dashboard area is a grid you can drag panels onto.

To create a dashboard:

1. Open Insights from the module bar.
2. Click the create button in the page header.
3. Set the name, icon, and any other metadata.
4. Save.

To add a panel:

1. Open the dashboard.
2. Click the edit button in the page header.
3. Click the create-panel button.
4. Choose a panel type from the drawer.
5. Configure the panel options.
6. Confirm to add the panel to the grid.
7. Save the dashboard.

Panels can be repositioned and resized on the grid. Each panel stores its position (`position_x`, `position_y`) and size (`width`, `height`) on the dashboard.

Insights uses two system collections: `directus_dashboards` (the dashboard records) and `directus_panels` (the panel records inside them). Permissions are set on each separately under **Settings > Roles & Permissions**:

- The Insights module appears in the module bar for any user with read access on `directus_dashboards`.
- Dashboards and their panels only load when the user has read access on both `directus_dashboards` and `directus_panels`.
- Creating, editing, or deleting panels requires the matching action permissions on `directus_panels`. Creating dashboards requires create permission on `directus_dashboards`.

For a role to use Insights at all, it needs read on both collections. For full editing, grant create, update, and delete on both.

## Panel types

CairnCMS ships six built-in panel types.

### Label

Header text that helps visually group other panels. Labels do not query data themselves.

- **Label** — the text to display
- **Color** — the text color

### List

A sortable, filterable list of items from a collection.

- **Collection** — the source collection
- **Limit** — maximum number of items to show
- **Sort Field** — which field to order by
- **Sort Direction** — ascending or descending
- **Display Template** — how each list item is rendered (supports field references and free text)
- **Filter** — restricts which items are considered

Use this for ranked or filtered subsets: top sellers, recent orders, items needing review, and so on.

### Metric

A single aggregate value calculated across a field.

- **Collection** — the source collection
- **Field** — the field to aggregate
- **Aggregate Function** — see [Aggregate functions](#aggregate-functions)
- **Sort Field** — used by First and Last
- **Filter** — restricts which items are aggregated

The display side has additional options for formatting the result: abbreviation (2,000 → 2K), decimal places, prefix and suffix text, and conditional styles that change the color when the value crosses a threshold.

### Time Series

A line graph of an aggregate value over time.

- **Collection** — the source collection
- **Date Field** — the time field on the x-axis (a date, datetime, or timestamp field)
- **Date Range** — the time window to display
- **Group Precision** — the bucket size (days, weeks, months, and so on)
- **Group Aggregation** — see [Aggregate functions](#aggregate-functions)
- **Value Field** — the field to aggregate
- **Color**, **Curve Type**, **Fill Type** — styling
- **Show X-axis** / **Show Y-axis** — toggle axis visibility
- **Min Value** / **Max Value** / **Value Decimals** — y-axis bounds and formatting
- **Filter** — restricts which items are considered

The collection must have at least one date, datetime, or timestamp field for this panel to work. Custom ranges accept values like `3 years`, `1 month`, `2 weeks`, `5 days`.

### Global Variable

Stores a variable that other panels on the same dashboard can reference.

- **Variable Key** — the name to reference in other panels
- **Type** — the data type (string, integer, datetime, and so on)
- **Default Value**
- **Interface** — the editing widget shown on the dashboard
- **Options** — interface-specific options

The panel itself renders as an editable interface inside the dashboard. Editing the value re-runs every panel that references the variable.

### Global Relational Variable

Like Global Variable, but the value is one or more item IDs from a collection.

- **Variable Key** — the name to reference in other panels
- **Collection** — the collection to pick items from
- **Multiple** — allow selecting more than one item
- **Limit** — cap on the number of items selectable
- **Display Template** — how items are shown in the picker
- **Filter** — restricts which items are selectable

Useful for dashboards that need to filter every other panel by a chosen entity, for example, picking a customer at the top of the dashboard and having every other panel show data only for that customer.

## Aggregate functions

Metric and Time Series panels both use aggregate functions to reduce a field of values to one number per result or per time bucket.

- **Count** — number of items
- **Count (Distinct)** — number of unique values
- **Average** — mean of values
- **Average (Distinct)** — mean of unique values
- **Sum** — total of values
- **Sum (Distinct)** — total of unique values
- **Minimum** — lowest value
- **Maximum** — highest value
- **First** — the first item, by sort
- **Last** — the last item, by sort

First, Last, Minimum, and Maximum are not aggregates in the strict mathematical sense, but they appear in this list because they reduce a set of items to one.

Not every function works on every field type. Average, for example, requires a numeric field. Functions that cannot be applied to the selected field are disabled in the field selector.

## Variables in panel options

Global Variable and Global Relational Variable panels expose values that other panels can reference using double-mustache syntax:

```
{{ your_variable_key }}
```

Variable references work inside any panel option that accepts data values, including filter rules, display templates, prefixes and suffixes, and other configuration fields.

The variable's data type must match where it is used. Passing a string into a place that expects a datetime will not work.

## Auto-refresh

Each dashboard has an auto-refresh setting in the sidebar. When set, the dashboard re-runs all of its panels at the configured interval which is useful for monitoring views that should stay current without a manual reload.

The refresh interval is local to your current session. It is not saved on the dashboard and is not shared with other users.

## Where to go next

- [Permissions](/docs/guides/permissions/) covers how to scope which roles can see, create, or edit dashboards.
- [Data model](/docs/guides/data-model/) covers how to design collections so they are easy to aggregate and chart.
