# zWork Skills Directory

This directory stores user-installed agent skills.

## What is a skill?

A skill is a folder containing a `SKILL.md` file with YAML frontmatter and Markdown instructions.
The agent reads skills automatically and follows their instructions when relevant to the current task.

## Structure

```
zWork-Skills/
├── my-skill/
│   ├── SKILL.md          # Required: name, description, and instructions
│   ├── scripts/          # Optional: helper scripts
│   ├── examples/         # Optional: reference implementations
│   └── resources/        # Optional: data files, templates, assets
```

## SKILL.md format

```markdown
---
name: My Skill Name
description: One-sentence description of when to use this skill.
---

# Instructions

Write your skill instructions here in Markdown.
The agent reads these instructions and follows them for relevant tasks.
```

## Installing a skill

Copy the skill folder into this directory. The agent will discover it automatically on the next run.

## Bundled skills

zWork ships with a set of built-in skills in the `zWork-Skills/` directory at the repository root.
Custom user skills added here take precedence over built-in skills with the same name.
