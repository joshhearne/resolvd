# Change files

Each user-visible change adds one small Markdown file here. The running
app turns the files that are new in a build into the **What's new**
pop-up and a "Resolvd was updated" bell entry, and the host updater
sends the files from the build it would install next to
Admin → System health → Updates as a preview.

```markdown
---
type: feature        # feature | improvement | fix
audience: everyone   # everyone | staff (default: staff)
---
Holidays can span several days, or close early.
```

- **type** sets the bullet colour: feature (blue), improvement (green),
  fix (orange).
- **audience**: `staff` entries are shown to Admins, Managers and Techs
  only. Use `everyone` only when Submitters and Viewers will notice the
  change.
- **Body**: one short sentence, written for the people using Resolvd, not
  for developers. Markdown works. A `- ` list gives several bullets.
- **File name**: anything unique, such as the topic (`holiday-ranges.md`).
  It's the entry's id: don't rename a file after it has shipped. Fixing
  the wording is fine; running installs pick it up.
- Dependency bumps, refactors and CI changes don't need a file.

Keep the list per update short. Shipping often keeps each pop-up readable.
