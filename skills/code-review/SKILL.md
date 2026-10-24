---
name: code-review
description: Perform a systematic, multi-pass code review of changed or specified files. Use when the user asks to review, audit, or critique code.
when: User asks for a code review, audit, or critique of specific code.
---

# Code Review

Perform a **systematic review** in this exact order. Do not skip passes.

## Pass 1 — Orientation
1. Read every file in scope fully (`read_file`). For diffs, ask which files changed or use `run_command` with git diff.
2. State what the code is supposed to do in 3 sentences max.

## Pass 2 — Correctness
3. Trace the main paths and edge cases. Check error handling, off-by-one, nil/null, async/await, resource leaks, and boundary conditions.
4. For every suspected bug: quote the exact line, explain the failure mode, propose a concrete fix.

## Pass 3 — Security
5. Check: injection (SQL/command/path), unsafe deserialization, secrets in code, unvalidated input, SSRF, missing authz.
6. Severity-tag each finding: HIGH / MEDIUM / LOW.

## Pass 4 — Design & Maintainability
7. Naming, dead code, duplication, missing tests, coupling, API ergonomics.

## Output format
- Verdict table: severity | file:line | issue | fix
- Then: top 3 highest-impact improvements
- Then: anything you could NOT verify (be honest about unknowns)

Rules: never invent line numbers — quote code. If a file exceeds 2000 lines, review in chunks and say so.
