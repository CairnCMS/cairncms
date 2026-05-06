---
title: Email templates
description: Customize transactional emails by adding Liquid templates to the templates folder convention.
---

CairnCMS sends transactional emails like password resets, user invitations, and any email a flow's Send Email operation puts through the template path by rendering [Liquid](https://liquidjs.com/) templates. You can override the built-in templates and add new ones by dropping `.liquid` files into the configured extensions folder.

This is not an extension type. There is no SDK, `defineEmailTemplate`, or `cairncms:extension` manifest involvement. Email templates are picked up by file convention from the configured extensions folder.

## File location

Custom templates go in the `templates` subdirectory of the extensions folder:

```
<EXTENSIONS_PATH>/templates/<template-name>.liquid
```

The mail service's Liquid engine is configured with two roots: the extensions folder first, then the platform's built-in templates directory. When two templates share a name, the one in the extensions folder wins. That is the mechanism for overriding a built-in template.

The extension is `.liquid`. Filenames without that extension are not picked up.

## Built-in templates

CairnCMS ships three built-in templates:

- **`base`** — a shared HTML layout. Used by the other built-in templates and rendered directly for share-link emails and notification emails.
- **`password-reset`** — sent when a user requests a password reset. Receives `url` (the reset link) and `email`.
- **`user-invitation`** — sent when an admin invites a new user. Receives `url` (the invitation link) and `email`.

To override any of these, save a file with the matching name in the templates folder. The custom-templates root is checked before the built-in root for every template name, including `base`, so dropping in `base.liquid`, `password-reset.liquid`, or `user-invitation.liquid` replaces the corresponding built-in.

For action emails (`password-reset`, `user-invitation`), make sure the override still surfaces the `url` variable somewhere. Without it, the user has no way to complete the action the email is asking them to take.

## Default template variables

Every template render automatically receives the following variables, derived from the project settings:

- **`projectName`** — the project name, defaulting to `'CairnCMS'`
- **`projectColor`** — the project accent color, defaulting to `'#546e7a'`
- **`projectLogo`** — the URL of the project logo. Always set: when a logo asset is configured under Project Settings, this is the asset URL; otherwise it falls back to `<PUBLIC_URL>/admin/img/cairncms-white.png`.
- **`projectUrl`** — the project URL, when one is set; an empty string otherwise

These are merged with whatever data the caller passes, with the caller's data taking precedence on key conflicts.

## Calling a custom template

A flow's **Send Email** operation can call any template by name. Set the **Type** to `template`, the **Template** to the filename without the extension, and the **Data** to a JSON object of variables for the template.

For example, a template at `<EXTENSIONS_PATH>/templates/order-confirmation.liquid`:

```liquid
{% layout "base" %}
{% block content %}
<p>Hi {{ customerName }},</p>
<p>
  Your order <strong>{{ orderNumber }}</strong> for {{ total }} has been received.
  We will send a follow-up when it ships.
</p>
<p>Thanks,<br>The {{ projectName }} team</p>
{% endblock %}
```

A flow that calls this template would set Type to `template`, Template to `order-confirmation`, and Data to `{ "customerName": "{{ $trigger.payload.name }}", "orderNumber": "{{ $trigger.payload.id }}", "total": "{{ $trigger.payload.total }}" }`. The data chain variables resolve before the operation runs, so the template receives concrete values.

## Using the base layout

The built-in `base.liquid` template handles the email shell, including doctype, head, branding, and footer styling, and exposes a `content` block. To match the styling of the built-in emails, extend it:

```liquid
{% layout "base" %}
{% block content %}
<p>Your custom message here, with project styling already applied.</p>
{% endblock %}
```

You are not required to use `base`. A template that does not start with `{% layout "base" %}` renders on its own, which is appropriate for emails with their own complete HTML.

## Liquid features

Liquid offers conditionals, loops, filters, includes, and template inheritance. The mail service uses LiquidJS, which closely follows the Shopify Liquid spec. The most common features:

- **`{{ variable }}`** — output a value
- **`{% if condition %}...{% endif %}`** — conditional blocks
- **`{% for item in collection %}...{% endfor %}`** — iteration
- **`{{ value | filter }}`** — filter pipelines (`upcase`, `downcase`, `default`, `date`, `escape`, and others)
- **`{% layout "name" %}`** + **`{% block name %}...{% endblock %}`** — template inheritance
- **`{% include "partial" %}`** — include another template

See the LiquidJS documentation for the full reference.

## A complete minimal example

A custom welcome email that includes branding and a tailored message.

`<EXTENSIONS_PATH>/templates/welcome.liquid`:

```liquid
{% layout "base" %}
{% block content %}
<p>Welcome to {{ projectName }}, {{ name }}!</p>

<p>
  Your account has been created with the email <strong>{{ email }}</strong>.
  Sign in any time at
  <a href="{{ projectUrl }}">{{ projectUrl }}</a>.
</p>

{% if showOnboardingLink %}
<p>
  <a href="{{ onboardingUrl }}">Open your onboarding checklist</a> to get started.
</p>
{% endif %}

<p>Thanks for joining,<br>The {{ projectName }} team</p>
{% endblock %}
```

A flow that sends this template would set:

- **Type**: `template`
- **Template**: `welcome`
- **Data**: `{ "name": "{{ $trigger.payload.first_name }}", "email": "{{ $trigger.payload.email }}", "showOnboardingLink": true, "onboardingUrl": "{{ $trigger.payload.onboarding_url }}" }`

## Cautions

- **Liquid is rendered server-side, but the resulting HTML reaches an email client.** Email clients are notoriously inconsistent. Test any styling decisions across the clients your audience actually uses; do not assume modern CSS will work.
- **Treat untrusted data carefully.** When a template renders values that originated from user input or an external service, apply Liquid's `escape` filter (`{{ value | escape }}`) explicitly rather than relying on engine defaults. Reserve raw HTML output for content you fully control.
- **Templates run with whatever data the caller provides.** They are not sandboxed against malicious input, but they are not a code-execution surface either; treat them like any other shared template.

## Where to go next

- [Configuration](/docs/manage/configuration/) covers `EXTENSIONS_PATH`, `EMAIL_FROM`, and the broader email transport configuration.
- [Operations](/docs/develop/extensions/operations/) covers custom flow operations if you want a richer API for sending email than the built-in Send Email operation provides.
- [Custom migrations](/docs/develop/custom-migrations/) is the other convention-based developer customization path documented here.
