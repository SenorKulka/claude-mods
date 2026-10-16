# claude-mods

Bushi's home-made Claude Code mods, as a directory marketplace named `bushi-local`.

## Mods

- `keepwarm-bg`: keeps the prompt cache warm while a session waits on background work (shells, subagents, monitors, workflows). It sends a cache-reading fork 50 idle minutes after a turn that leaves work in flight, then every 50 minutes, for at most 12 hours after the last turn. It runs no slash commands and leaves nothing in the transcript.

## Install on a machine

Clone into `~/.claude/local-marketplace`, then in Claude Code:

```
/plugin marketplace add ~/.claude/local-marketplace
/plugin install keepwarm-bg@bushi-local
```

The marketplace is read in place, so after a `git pull` run `/reload-plugins` or start a new session.

## Test

From a plugin's folder: `claude plugin test .`
