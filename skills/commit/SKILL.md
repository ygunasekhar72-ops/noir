---
name: commit
description: Write a clean conventional-commit message and create a git commit. Use when the user asks to commit changes.
when: User asks to commit, or "write a commit message".
---

# Conventional Commit

1. Run `run_command` with `git status --porcelain` and `git diff --staged` (stage nothing yourself unless asked; if nothing is staged, show the unstaged diff summary and propose the message first).
2. Classify the change: feat | fix | refactor | docs | test | chore | perf.
3. Write the message:
   - Subject: `<type>(<scope>): <imperative summary>` — max 50 chars, no period.
   - Body (if needed): why the change was made, wrapped at 72 chars.
   - Breaking changes: add `BREAKING CHANGE:` footer.
4. Show the proposed message to the user, get confirmation, then:
   `git commit -m "<subject>" -m "<body>"`.
5. Verify with `git log -1 --stat` and report the hash.

Never include secrets or tokens in messages. Never use `--force`.
