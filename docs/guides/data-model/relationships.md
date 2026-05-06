---
title: Relationships
description: Connect records across collections.
---

Relationships are how a relational database avoids duplication while keeping related records connected. CairnCMS supports the standard relational types and adds a few compound types for common patterns. This page covers each type and how it shapes the underlying schema.

## Why relationships matter

Without relationships, related data ends up copied into multiple places, creating drift as the duplicates fall out of sync.

A relationship lets one collection point at another instead of repeating the same values. The database stays normalized while the app still gives people a usable surface for editing and browsing the connected data.

For example:

- many articles point to one author
- one country relates to many cities
- many recipes use many ingredients

## Stored side and visible side

In CairnCMS, one pattern appears across most relationship types:

- one side stores the foreign key or junction data in the database
- the other side is exposed through an alias field that does not create a new database column

This is why some relational fields appear in the app even though no new column was added to the table. The visible side is often a view onto a relation that is stored elsewhere.

## Many-to-one (M2O)

The simplest and most common relationship.

Use M2O when many records on one side should point to one record on another:

- many articles belong to one author
- many cities belong to one country
- many orders belong to one customer

At the database level, this is a single foreign key column on the "many" side:

```
cities
- id
- name
- country_id (foreign key, stores countries.id)

countries
- id
- name
```

Most other relationship types build on M2O.

## One-to-many (O2M)

The same relationship viewed from the opposite direction.

If `cities.country_id` is an M2O from `cities` to `countries`, then `countries.cities` is the O2M view of that same relationship.

In CairnCMS, O2M is an alias field. It lets you access the related children from the "one" side without adding a new column on the parent collection:

```
countries
- id
- name
- cities (alias, exposes related cities)
```

Use O2M when you want the app to expose the reverse side of an existing M2O.

## One-to-one (O2O)

CairnCMS does not have a dedicated O2O type. In practice, O2O is an M2O with a uniqueness constraint on the foreign key.

Use it when each record on one side should point to at most one record on the other, and vice versa:

- one capital city per country
- one profile per user
- one settings row tied to one parent entity

The modeling question is usually not "is this O2O?" but "which side should store the foreign key?" Prefer the side where the value will exist for most rows. If most cities are not capital cities, the foreign key belongs on `countries`, not on `cities`.

## Many-to-many (M2M)

Many-to-many means records on both sides can connect to many records on the other side:

- recipes and ingredients
- articles and tags
- users and teams

M2M requires a junction collection, which is an intermediate table that stores one row per link:

```
recipes
- id
- name

recipes_ingredients (junction collection)
- id
- recipe (foreign key, recipes.id)
- ingredient (foreign key, ingredients.id)
- quantity (a contextual field)

ingredients
- id
- name
```

The junction can also store contextual fields about the link itself: quantity for a recipe ingredient, role inside a team membership, sort order for related items, and so on. This is one of the most useful patterns to understand well, because many real business models depend on relationship-specific metadata.

A self-referencing M2M is also possible, for example, "related articles" where each article connects to many other articles in the same collection.

## Many-to-any (M2A)

M2A, sometimes called a matrix or replicator, lets one collection link to records from many different target collections. A common example is a page builder, where a `pages` collection has a sequence of sections that may come from `headings`, `text_bodies`, `images`, or other collections.

The junction collection on an M2A stores three things:

- the parent record's foreign key
- the related collection's name
- the related item's foreign key

```
pages
- id
- name
- sections (alias, exposes page_sections)

page_sections (junction collection)
- id
- pages_id (foreign key, pages.id)
- collection (the related collection's name)
- item (the related item's id)

headings
- id
- title

text_bodies
- id
- text

images
- id
- file
```

M2A is powerful but raises modeling complexity. Use it when the flexibility is genuinely needed.

## Translations (O2M)

Translations are a specialized relational pattern for multilingual content. Although the app exposes them as a Translations field, the data is stored as an M2M behind the scenes.

```
articles
- id
- author (not translated)
- date_published (not translated)
- translations (alias, exposes article_translations)

article_translations
- id
- article_id (foreign key, articles.id)
- language_id (foreign key, languages.language_code)
- title (translated content)
- text (translated content)

languages
- language_code (primary key, e.g. "en-US")
- name
```

Translated values become contextual fields on the junction collection. This is more extensible than adding `title_en`, `title_de`, `title_fr`, and so on directly to the parent collection, and it gives the app a cleaner editing experience for multilingual records.

## Self-referencing relationships

A relationship can point back into the same collection:

- related articles
- parent and child categories
- manager and employee links within users

These are ordinary relationships, but the modeling consequences deserve thought because self-reference can make query and UI behavior more complex.

## How to choose the right relationship

A simple rule of thumb:

- **M2O** when one record belongs to one parent
- **O2M** when you want the reverse view of an M2O exposed in the app
- **O2O** when the foreign key should be unique
- **M2M** when both sides can have many connections
- **M2A** when one parent must connect to records from several different collections
- **Translations** when the problem is multilingual variants, not generic relations

If a relationship type feels unclear, sketch the actual rows that would need to exist in the database. The correct shape usually becomes obvious once you can write out the records.

## Common mistakes to avoid

- copying related values instead of linking to them
- choosing M2A when a simpler M2M or M2O would be clearer
- forgetting that junction collections can carry important contextual fields
- putting an O2O foreign key on the side where most rows will be `null`

These are modeling problems first and UI problems second.

## Where to go next

Once the relationship shape is clear, the next step is usually field design:

- [Fields](/docs/guides/data-model/fields/) covers field categories, types, and configuration.
