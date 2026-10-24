# NoirPad 📝

A **real-world app built to run inside the NOIR harness**: a fast, offline-tolerant
markdown notes app for your phone, hosted by `noir serve` — no external services,
no accounts, no database.

## Why it proves the harness

- **Runs through the local app** — install it once and it appears in the NOIR
  mobile app under the **APPS** tab (and at `/apps/noirpad/`).
- **Notes are plain files.** Every note is a markdown file with frontmatter at
  `<project>/.noir/webapps/noirpad/data/notes/<slug>.md` — which means the
  NOIR **agent can read and write your notes with its normal file tools**
  (`read_file`, `write_file`, `search_files`). Ask it things like
  *"summarize my notes from this week"* and it can — no integration code.
- **Zero dependencies, stdlib only.** The app is vanilla HTML/CSS/JS; storage
  goes through NOIR's generic app-data API (`/api/app-data/noirpad`).

## Features

- Create / edit / delete notes (autosave + Ctrl/Cmd+S)
- Tags, full-text search across titles, tags and bodies
- Markdown preview (headings, lists, code, quotes, links)
- Export any note as `.md`; import `.md` files (batch)
- Mobile-first strict-monochrome UI with safe-area handling

## Install & run

```bash
# from the noir repo, inside any project directory:
node <path-to-noir>/examples/noir-pad/install.mjs .

noir serve          # then open http://127.0.0.1:5178 on the same device
# or from the NOIR mobile app: APPS tab -> noirpad -> OPEN
```

## Storage layout

```
<project>/.noir/webapps/noirpad/
├── index.html / styles.css / app.js     # the app (served at /apps/noirpad/)
└── data/
    ├── index.json                       # metadata cache
    └── notes/
        └── my-note-abc123.md            # frontmatter + markdown body
```

## Data API (used by the app, available to any web app you ship)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/app-data/noirpad?list=1` | list files with sizes/mtimes |
| GET | `/api/app-data/noirpad?file=notes/x.md` | read a file (512KB cap) |
| POST | `/api/app-data/noirpad` `{file, content}` | write a file |
| DELETE | `/api/app-data/noirpad?file=notes/x.md` | delete a file |

Paths are sandboxed to the app's `data/` directory — traversal is rejected.
