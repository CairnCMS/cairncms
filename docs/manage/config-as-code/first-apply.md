---
title: Your first apply
description: Capture a small project, preview a change, and restore it in a disposable instance.
sidebar:
  order: 1
---

Use a disposable instance to capture a small project, remove its example resources, and restore them from the saved files. For deploying to a different instance, see [Deploying across environments](/docs/manage/config-as-code/deployments/).

## Prepare the lab

Use CairnCMS 1.7.0 or later with an initialized disposable database and an administrator account. Run the CLI with that instance's database configuration loaded. Keep the same release and database vendor throughout. Never perform the reset below on a production or shared project.

In the admin app:

1. Create a file-library folder named **Article images**. Do not upload files.
2. Create a collection named `articles` with its default primary key and a string field named `title`.
3. Add a single-file field named `cover`, using the File interface. Select Article images as its upload folder.
4. Create a role named **Documentation Editor** with app access enabled and administrator access disabled. Do not assign users to it. Leave the administrator role unchanged.

Leave the collection empty.

## Select the resources to capture

Create an empty `config-demo` directory and a `config-demo/cairncms-config.yaml` file containing:

```yaml
version: 3
resources:
  - roles
  - folders
  - schema
```

This manages all roles, folders and schema covered by a snapshot, not just the resources you created. Permissions and other kinds are not managed in this example.

```bash
cairncms config snapshot ./config-demo --yes
```

The CLI writes one file per role, folder and collection. Keep all generated files, including the administrator role.

Verify that the capture matches the instance:

```bash
cairncms config apply ./config-demo --dry-run
```

Expect `No changes to apply.` Resolve any warning or difference before continuing.

## Create a difference to restore

This reset is only for the empty lab. Deleting a collection destroys its contents, and deleting a role can affect users and permissions.

In the admin app, delete the `articles` collection, the empty Article images folder, and the unassigned Documentation Editor role. Keep the captured files and the administrator role. Confirm those three resources are absent from the instance.

```bash
cairncms config apply ./config-demo --dry-run
```

The preview should list the missing folder, collection and fields, and role for creation. It has not changed the instance. The command exits `1` when it finds changes, which is expected here.

Do not proceed if the plan contains unexpected deletions. Inspect the selected database and manifest scope instead of adding `--destructive` to silence a surprise.

## Apply and verify

```bash
cairncms config apply ./config-demo
```

Review the plan and confirm. If the apply fails, follow [Failure recovery](/docs/manage/config-as-code/recovery/) before retrying.

Check the admin app: `articles` has `title` and `cover`, the cover field selects Article images, and Documentation Editor exists without administrator access.

```bash
cairncms config apply ./config-demo --dry-run
```

Expect `No changes to apply.` You can now discard the disposable instance. Review a fresh preview before using the captured files on another project.
