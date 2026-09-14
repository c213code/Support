---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Read the guidelines from `guidelines.md` in this skill's directory
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

`guidelines.md` is a pinned copy of
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
(taken 2026-09-14). Do not fetch the URL during a review: the rules are
pinned so a change upstream can't silently change what the skill does. To
update, fetch it deliberately, read the diff, and replace the file.

In the Support project, weigh rules against project conventions: the Mini
App copy is Kazakh and follows Telegram's own UI (sentence case, no Title
Case), and board cards intentionally use native HTML5 drag-and-drop.

## Usage

When a user provides a file or pattern argument:
1. Read `guidelines.md`
2. Read the specified files
3. Apply all rules from the guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
