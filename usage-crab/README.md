# 🦀 usage-crab

**English** · [Русский](README.ru.md)

Your Claude limits for 5 hours and for the week, always in view. Shows time until reset and what the usage went on. A pixel crab lives in the panel, and its mood depends on your limits.

<p align="center"><img src="assets/band.png" alt="Row above the input: 5h 41%, week 63%, Details and Rules buttons" width="640"></p>

> The screenshots show the Russian interface.

## Installation

```
/plugin install usage-crab --marketplace igorxmel/xmel-mods
```

Other ways are described in the [main README](../README.md#installation). Limits exist only on a subscription (Pro, Max, Team, Enterprise). When signed in with an API key the mod shows "no data".

## Features

**Row above the input.** Percentages for 5 hours and for the week, plus time until reset. The "🦀 Details" button opens the panel; "📏 Rules" opens the panel of the [session-rules](../session-rules/) mod, if installed. Below it, in the same area, sits the row of the [secret-guard](../secret-guard/) mod: it adds that row itself when installed.

<p align="center"><img src="assets/panel.png" alt="usage-crab panel: crab, limit bars, usage breakdown" width="360"></p>

**Panel** (the Details button or the `/crab` command):
- limit bars that smoothly shift from green to red, and the exact reset time;
- **"Where it went"**: a breakdown over 5 hours or the week by project, model and tool, plus a list of the heaviest requests with their text;
- a "↻ Refresh" button and a 📌 that decides whether the panel opens at startup.

### The crab

The crab's mood depends on both limits: the 5-hour one decides how hectic it is right now, the weekly one decides whether it is conserving at all.

<p align="center"><img src="assets/moods.png" alt="Eight crab states" width="900"></p>

| Condition | Crab |
|---|---|
| Claude is answering | codes on a laptop, `{ } ; </>` fly above it |
| all calm | strolls, drinks coffee, dances, waves, reads: the activity changes every minute |
| 5 hours ≥ 80% | sweats and bustles |
| week ≥ 80%, 5 hours fine | conserves the week: walks slowly, advises postponing heavy work |
| limit exhausted | sleeps until the reset |

The background behind it follows your computer's clock, and the phrases match the time of day:

<p align="center"><img src="assets/day-cycle.png" alt="Morning, day, evening and night" width="900"></p>

In the terminal the crab is drawn with characters and does not animate.

## How it works

- **Limits** arrive two ways: with every model response and by polling every 5 minutes. Polling uses the same endpoint as `/usage`, and Claude Code supplies the token. If the server answers "too many requests" (429), all sessions wait as long as it asks.
- **Several windows.** Sessions share the numbers through `~/.claude/usage-crab/limits.json`, so every window shows the same percentages. Only one session polls the server.
- **"Where it went"** is computed from token cost: an expensive model and a long context use up the limit faster. No money is charged; it is just a weight. Only sessions where the mod was enabled are counted. The log is kept in `~/.claude/usage-crab/log-*.json` for 8 days.

If polling gets in the way, the `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` variable turns it off. The numbers then update only after model responses.

## Commands

| Command | What it does |
|---|---|
| `/crab` | open the panel |
