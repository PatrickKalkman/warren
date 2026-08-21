# Pull request templates

When configured forge behavior opens a pull request after a successful run, warren builds the body from named fragments. A project can replace individual fragments without copying the whole default template.

Create `.warren/pr-template.md` in the repository. Each `## <fragment_name>` heading replaces one default fragment:

```markdown
## trailer

Reviewed-by: @platform-team

Follow the project PR checklist before merge.
```

Unspecified fragments keep their defaults. A fragment with a whitespace-only body removes that section.

## Fragment names

- `title`
- `summary`
- `run`
- `seeds`
- `preview_url_or_placeholder`
- `commits`
- `files_changed`
- `prompt`
- `trailer`

Unknown fragment names and unbalanced preview markers surface through `warren doctor`.

## Default information

The generated body can include the run link, commits, changed files, prompt, tracker context, preview URL, and a warren trailer. The exact content depends on the finalization result and configured integrations.

PR opening is not the core run guarantee. Warren always treats the pushed branch as its delivery boundary. Forge configuration and permissions determine whether it can open or find a pull request after that push.

For the complete fragment and preview-placeholder contract, read [Preview environments](previews.md) and the [preview design record](design/preview-environments.md).
