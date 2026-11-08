# 📏 session-rules

**English** · [Русский](README.ru.md)

Rules you worked out with Claude in one project (how to write commits, code style, documentation language) can be saved and switched on in any other session with one button.

<p align="center"><img src="assets/panel.png" alt="Rules panel: the commits set is on and expanded, two more are off" width="380"></p>

> The interface is English by default; the 🌐 EN · RU button in the panel (or `/rules lang`) switches it to Russian. The Russian screenshot is in the [Russian README](README.ru.md).

## Installation

```
/plugin install session-rules --marketplace igorxmel/xmel-mods
```

Other ways are described in the [main README](../README.md#installation).

## How to use

1. **Save the rules.** In a session where the rules have already been worked out, open the panel (`/rules`) and type a name into the "New set from this session" field, for example `commits`. Claude collects the rules from the conversation and writes them to a file. You can also do it by hand: the "New set manually" field creates an empty file and opens it for editing right away.
2. **Enable in another session.** Click a set (○ → ●). The rules are added to Claude's system prompt and apply until the session ends. The status line shows which sets are on.
3. **Auto-enable.** "auto" next to a set turns it on by itself every time a session is opened in that project folder.

Each set can be expanded (`show`), read and edited right in the panel: **Enter** saves, **Shift+Enter** inserts a line break.

## Where the rules live

Plain Markdown files in `~/.claude/session-rules/`, one per set:

```markdown
# Commit rules

- Format: `type(scope): what changed`
- Title up to 72 characters, no trailing period
- Body is required: why, not what
```

The first `# …` line becomes the set's name. The mod picks up new and changed files on its own within a few seconds. The "📂 Rules folder" button opens the folder in the file explorer.

## Commands

| Command | What it does |
|---|---|
| `/rules` | open the panel |
| `/rules list` | list the sets, ● marks enabled ones |
| `/rules on <name>` / `off <name>` | enable or disable a set in this session |
| `/rules auto <name>` | enable a set automatically in this folder |
| `/rules save <name>` | ask Claude to write the rules from this session |
| `/rules reload` | re-read the folder |
| `/rules lang [en\|ru]` | switch the interface language (without an argument it toggles) |
