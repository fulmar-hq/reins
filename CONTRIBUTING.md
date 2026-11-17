# Contributing (people and AI agents)

This repository is public. Treat every commit, test, document, commit message and pull request as published.

- **Write about the generic tool.** Describe what the software does and why. Leave out what happened on your
  machine: your incidents, measurements, spend, usage numbers and project names.
- **Keep your own details in your private config only**: names, emails, phone numbers, chat ids, account ids,
  budgets, home-folder paths, machine names, internal addresses, tokens and keys. In code and docs use `~` or
  placeholders, and example values that are obviously made up.
- **Nothing in the code may be specific to one user.** If it differs between users, it belongs in
  `factory.config.json`.
- **Keep it thin.** No model calls, no model API keys, nothing the tools already do. Plain code, small files.
- **Tests** protect a rule whose break would cost money or hide a stall. Add one only for such a rule.

## The privacy check

`bun privacy-check.ts` scans what you are about to publish for home-folder paths, email addresses,
12-digit account-like numbers, sign-in portal and internal addresses, and common token shapes, plus your own
private words: put them one per line in a file outside the repository and name it as `privacyTermsFile` in your
private config. It reads every commit in the range, patch by patch, and the commit messages, because history is
published too. It prints the commit, file and line and a masked hint, never the suspect text itself, and it fails if
git itself fails.

Run it over your whole branch before every push, and install it as a hook so it cannot be forgotten:

```sh
printf '#!/bin/sh\nexec bun privacy-check.ts origin/main..HEAD\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

CI runs the same check on every pull request. If this project sits in a subfolder of a larger repository, put the
folder name before `privacy-check.ts` in the hook.

If it finds something already pushed, do not force-push: tell the maintainer exactly what and where.
