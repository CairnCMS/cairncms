---
title: Fields
description: How fields are configured in CairnCMS, including types, interfaces, and validation.
sidebar:
  order: 1
---

A field is what you add to a collection. Each field stores a value (or, in some cases, acts as presentation or as an alias for related data) and shows up as an element on the item form in the app.

This page explains how fields are configured, how the Create Field workflow works, and the types and interfaces available.

## The two layers of a field

Every field that stores data has two layers:

- the **type** — how the value is stored at the database level (string, integer, JSON, geometry, and so on)
- the **interface** — the editing component used in the app (input, dropdown, tags, wysiwyg, and so on)

Fields can also carry additional configuration options, such as validation, display, conditions, layout, that do not change the type or interface but shapes how the field behaves in the app.

Some fields, such as dividers, group containers, and certain alias relationships, do not store a value of their own. These use the alias type internally.

## The Create Field workflow

The button to add a new field is **Create Field**, which opens a drawer of available interfaces. Each interface in the drawer is effectively a preset: it pairs an editing component with a sensible default type and a starting set of options.

For example, picking **Tags** creates a field whose interface is Tags and whose type defaults to JSON. Picking **Input** creates a field whose interface is Input and whose type defaults to string.

After you pick an interface, the inline configuration drops down and you fill in the field key. From there, **Continue in Advanced Field Creation Mode** opens the full configuration drawer if you need fine-grained control.

In advanced mode you can also change the type. Changing the type can make the original interface incompatible. If you start with Tags (JSON) and change the type to text, you are no longer creating a Tags field. The Interface section of the drawer narrows to the text-compatible interfaces (Input, Textarea, Code, Markdown, WYSIWYG, and similar).

## Interface categories

The Create Field drawer groups interfaces into categories.

### Standard

For straightforward scalar input.

- **Input** — a standard text or number input
- **Autocomplete input (API)** — a search input that fetches dropdown choices from a URL
- **Code** — a code editor with syntax highlighting
- **Textarea** — a longer plain-text input
- **WYSIWYG** — a rich-text editor with a formatting toolbar
- **Markdown** — a markdown editor with edit and preview modes
- **Tags** — a free-form input for any number of tags

### Selection

For constrained or guided input.

- **Toggle** — an on/off switch
- **Datetime** — a date and time picker
- **Repeater** — repeating groups of fields stored as JSON
- **Map** — geospatial picker with an interactive map
- **Color** — a color picker that supports multiple modes
- **Dropdown** — a single-choice dropdown
- **Icon** — an icon picker
- **Checkboxes** — a flat list of multi-select checkboxes
- **Checkboxes (tree)** — nested multi-select checkboxes
- **Dropdown (multiple)** — a multi-choice dropdown
- **Radio buttons** — a single-choice list of radio buttons

### Relational

For connecting one record to other records or to files.

- **File** — link to a single file
- **Image** — link to a single image
- **Files** — link to multiple files (creates an M2M behind the scenes)
- **Builder (M2A)** — link to records from multiple different collections
- **Many to many** — link many records on one side to many on the other
- **One to many** — link one record on this side to many on the other
- **Tree view** — self-referencing one-to-many for hierarchies
- **Many to one** — link this record to one on the other side
- **Translations** — link this record to a translations collection for multilingual content

See the [Relationships](/docs/guides/data-model/relationships/) page for more info on modeling relationships.

### Presentation

For elements that do not store a value but help organize the form.

- **Divider** — a horizontal divider with an optional title
- **Button links** — one or more buttons that link to a preset or dynamic URL
- **Notice** — an alert or notice in a chosen severity color

### Groups

For grouping related fields visually inside the item form.

- **Accordion** — a collapsible group with multiple sections; can be configured to expand one section at a time or several
- **Detail Group** — a single collapsible group with a header toggle
- **Raw Group** — a group of fields rendered as-is, always displayed

### Other

A catch-all category for specialized interfaces.

- **Collection item dropdown** — pick an item from another collection
- **Hash** — text input that is hashed on save
- **Slider** — range input for numeric values

## Field types

Field types are the storage shapes CairnCMS exposes. They map onto vendor-specific database types behind the scenes:

- text: string, text
- numeric: integer, big integer, float, decimal
- temporal: timestamp, datetime, date, time
- other scalar: boolean, JSON, CSV, UUID, hash
- geometric: geometry, point, linestring, polygon, multipoint, multilinestring, multipolygon

Alias is used internally for fields that do not have a database column, like relational alias fields, presentation elements, and group containers. Not every field you see in the app is a literal database column.

Most interfaces support more than one type, and most types are usable through more than one interface. The Interface section of the field configuration drawer reflects this: changing the type narrows or expands the available interface choices.

## Configuring a field

Once a field exists, opening it in the app reveals the field configuration drawer. The drawer is divided into sections, each handling one concern:

- **Schema** — the database column behind the field (type, default, nullable, unique, length)
- **Relationship** — appears for relational fields; controls how the relation is wired
- **Translations** — appears for translation fields; controls how translations are stored
- **Field** — sets details for the field input shown on the item page (label, note, width)
- **Interface** — controls the editing experience for the field's value, including which interface is in use
- **Display** — controls how the field's value is shown in non-edit contexts, such as collection rows or item summaries
- **Validation** — applies a filter rule that the value must satisfy
- **Conditions** — alters this field's behavior based on values in other fields

Not all sections appear for every field. Relational and translation fields show extra sections; presentation and group fields show fewer.

## Field width

Each field on the item page can be sized to control the form layout:

- **Half width** — the field takes half of the form width
- **Full width** — the default; the field spans the full form width
- **Fill width** — the field fills the entire page area

Width changes do not affect what is stored. They only affect how the form is presented.

## Duplicating, reordering, and deleting fields

CairnCMS supports common field-maintenance operations. Treat them as schema changes, not cosmetic actions:

- **Duplicating** copies a field's configuration to another collection but does not copy stored values. Duplication is available only for standard fields that are not primary keys; relational, presentation, group, file, and primary-key fields cannot be duplicated.
- **Reordering** changes how fields appear on the item page. It does not change the database column order or anything visible to API consumers.
- **Deleting** is permanent and removes both the configuration and any stored data in that column.

When the schema is used by real systems, plan these changes the same way you would plan any other production schema change.

## A practical way to think about fields

When adding a field, ask four questions:

1. What fact am I trying to store?
2. Does it belong on this collection at all, or somewhere related?
3. Which storage type should represent it?
4. Which interface will make it easiest to use correctly?

If those answers are clear, the specific field choice is usually straightforward.
