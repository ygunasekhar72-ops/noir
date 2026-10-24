---
name: debug-loop
description: A rigorous hypothesis-driven debugging loop. Use when the user reports a bug, crash, or unexpected behavior.
when: User reports a bug, error, crash, or anything "doesn't work".
---

# Debug Loop

Work in strict short cycles. Never change more than one thing per cycle.

## 1. Reproduce
- Get the exact error text, stack trace, or wrong output. If a command exists to reproduce it, run it with `run_command` and capture the output.
- If you cannot reproduce, say so and ask for specifics. Do NOT guess-fix.

## 2. Isolate
- Form exactly one hypothesis about the cause. Write it down explicitly: "Hypothesis: X fails because Y."
- Gather evidence: read the relevant code (`read_file`), add a probe (`run_command` with a small script), or search (`search_files`).

## 3. Fix
- Make the **minimal** change that addresses the hypothesis (`edit_file`).
- Re-run the reproduction. Compare against expected.

## 4. Loop
- Fixed? Verify nothing else broke (run tests/build if present). Summarize: root cause → fix → verification.
- Not fixed? Refine or replace the hypothesis, go to step 2. Max 5 cycles, then report findings honestly and ask the user.

## Rules
- One hypothesis per cycle.
- Never "fix" symptoms you cannot explain.
- Always verify with evidence before declaring success.
- Save durable findings with `save_memory` (e.g. quirks of the codebase).
