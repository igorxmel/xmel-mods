# 🛡️ secret-guard

**English** · [Русский](README.ru.md)

Keeps tokens, keys and passwords away from the model and out of git. You still see everything as is, while Claude gets a placeholder instead of the secret.

<p align="center"><img src="assets/example.png" alt="A token in a message and in .env replaced by a placeholder, git add -A stopped" width="760"></p>

> The interface is English by default; the 🌐 EN · RU button in the panel (or `/secrets lang`) switches it to Russian. The screenshots are in English; the Russian ones are in the [Russian README](README.ru.md).

## Installation

```
/plugin install secret-guard --marketplace igorxmel/xmel-mods
```

Other ways are described in the [main README](../README.md#installation).

## What it does

**Hides secrets from the model.** Command output, files that were read and subagent replies are checked before Claude sees them. Whatever is found is replaced with a placeholder like `[hidden: Telegram bot token, …sawq]`, with the last 4 characters left visible so you can tell which key it was. The placeholder is in the interface language (in Russian: `[скрыто: токен Telegram-бота, …sawq]`); both forms count as already hidden. The mod recognizes:
- Telegram bot, Discord, GitHub, GitLab and Slack tokens;
- Anthropic, OpenAI, AWS, Google and Stripe keys;
- JWTs and private keys (`-----BEGIN … PRIVATE KEY-----`);
- passwords in URLs like `postgres://user:password@host`;
- `BOT_TOKEN=…`, `DB_PASSWORD=…` and `"password": "…"` lines in `.env`, JSON and YAML.

Ordinary output is left alone: `PORT=8080`, `PWD=/home/…`, commit hashes and placeholders like `your_api_key_here` pass through unchanged.

**Hides secrets in your messages.** If you paste a token straight into the chat, Claude gets a placeholder, and a gray line under the message says a secret was hidden.

**Remembers values from `.env`.** At session start the mod reads `.env` in the project folder and afterwards hides those values everywhere, even without the variable name next to them, for example in the output of `echo $BOT_TOKEN`. The values are kept in memory only.

**Keeps secrets out of git.** Stops `git add` and `git commit` when they include `.env`, `*.pem`, `*.key`, `id_rsa`, `credentials.json` or `secrets.*`. Templates such as `.env.example` and public keys `*.pub` are let through. Claude gets a hint to add the file to `.gitignore`.

## Buttons

Above the input the guard has its own row: "Guard is on · hidden 3" and two buttons.

<p align="center"><img src="../usage-crab/assets/band.png" alt="Row above the input: the guard row at the bottom with Pause 10 min and Details buttons" width="640"></p>

- **Pause 10 min** switches the guard off for 10 minutes, for example so Claude can fix `.env`. While paused, the button turns into **Resume**, and after 10 minutes the guard comes back on its own.
- **Details** opens the panel: pause for 10 minutes, 30 minutes or an hour, the hidden counter, recent events and a "Forget remembered values" button.

<p align="center"><img src="assets/panel.png" alt="Guard panel: pause, counters and recent events" width="360"></p>

The panel shows only the kind of secret, where it came from and the time. The values themselves are never shown or written to disk.

If [usage-crab](../usage-crab/) is installed alongside, both rows stand together in the same area above the input. The mods do not depend on each other.

## Commands

| Command | What it does |
|---|---|
| `/secrets` | what was hidden or stopped (without the values) |
| `/secrets open` | open the panel |
| `/secrets pause [min]` | switch the guard off, 10 minutes by default |
| `/secrets resume` | switch it back on |
| `/secrets lang [en\|ru]` | switch the interface language (without an argument it toggles) |

## Limitations

- While the guard is on, Claude cannot edit `.env` with Edit: it sees placeholders, not values. That is what the pause is for.
- Bash commands are checked. This is a safety net against accidents, not protection against malice: a command can be phrased so the parser does not understand it.
- Known key formats are recognized. A custom password with no telling name like `PASSWORD=` goes unrecognized until it appears in `.env`.
