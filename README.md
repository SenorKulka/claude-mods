# claude-mods

Bushi's home-made Claude Code mods, as a directory marketplace named `bushi-local`.

## Mods

- `cache-hugger`: keeps the main conversation's one-hour prompt cache warm and prices it when it goes cold. Since 3.0.0 it does everything cache-tax 2.2.1 did, so uninstall cache-tax (it warns at session start while both are installed). Details below; it also adds a sub-agent wait rule to your `CLAUDE.md`, described after that.

## cache-hugger: what it does

**Pings.** A ping is a tool-less fork of the conversation that reads the cache and so renews it, sent 50 idle minutes after the last request, then every 50 minutes. Pings run while either reason holds:

- **Background work:** a turn ended with a shell, subagent, monitor or workflow still in flight. Pings run until a turn leaves no work, for at most 12 hours after the last turn.
- **A `/hug-cache` window:** `/hug-cache` (6 hours), `/hug-cache 90m`, `/hug-cache always` (a 6-hour window at every session start), `/hug-cache off`. A paid cold write opens a 3-hour window by itself.

Both reasons share one timer, so the cache is never pinged twice. A ping that finds the cache already gone, or fails, stops the pings until the next turn.

**Guard.** A message sent after the cache went cold (over an hour idle, context of 50k tokens or more) is refused once with its re-write price and how much of the 5-hour limit is used; sending it again pays it. `/hug-cache guard warn` only shows the price.

**Prices.** List prices from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 17 October 2026, per model (Opus 5.5 at $8 per million for a 1-hour write and $0.20 for a read, Haiku 5.5 by prompt length). A turn counts as a cold write only when it wrote more than its context grew by, so a long turn that adds a lot of context is not mistaken for one.

**Where it shows.** Nothing goes to the transcript except the cold-write line. A row above the prompt (the status line where there is no such row) shows warm or cold, the time left and why (`manual` for `/hug-cache`, `auto bg` for background work, `auto` for always or after a cold write), the next ping as a countdown redrawn every minute, and the last ping's read and price. Each ping shows in a toast, and pings stopping early in a longer toast. `/hug-cache status` shows the model, cache state, context, cold price, break-even, background work and this session's cold writes.

Windows are kept per session in the mod's own store. Windows armed under cache-tax are not carried over.

## cache-hugger: the sub-agent wait rule in CLAUDE.md

The mod's pings only reach the main conversation: a mod can fork the main thread (`$.model.fork`), never a sub-agent's. A sub-agent's prompt cache lasts 5 minutes, so a sub-agent that waits longer than that on a background job re-writes its whole cache when it wakes. The workable fix is for sub-agents to wake themselves: each short wake-up reads the cache and so refreshes it.

So at every session start the mod keeps this section in `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md` when that is set), between `<!-- KEEPWARM_BG_WAIT_RULE_START -->` (the markers keep their old name so existing blocks update in place) and `<!-- KEEPWARM_BG_WAIT_RULE_END -->`:

> **Waiting in sub-agents (4-minute slices).** A sub-agent that waits on a background job (a review trial, a check run, a test suite, a build, a server) waits in slices of at most 4 minutes: a Bash or Monitor wait with a timeout of at most 240 s, then a short status check, then the next slice; never one long blocking wait. A session that launches sub-agents puts the rule in every prompt for one that may wait on a background job. Waits in the main conversation are exempt: its cache lasts an hour.

- **When:** the first session that starts after the mod is installed or updated. Sessions already running don't re-read `CLAUDE.md`; start a new one.
- **Updates:** a newer mod version rewrites the marked block in place. A section with the same heading added by hand, without the markers, is taken over.
- **Opting out:** put `<!-- KEEPWARM_BG_WAIT_RULE: off -->` anywhere in `CLAUDE.md`; the mod then never adds or changes the rule.
- **Uninstalling:** Claude Code has no uninstall hook, so the block stays; delete it by hand, from the start marker to the end marker.

### Why 4-minute wake-ups: the numbers

Measured on one real session on 17 October 2026: an orchestrator session (Opus 5.5, high effort) delivering one slice of a backend feature over 7.5 hours, with 19 background sub-agents, mostly Opus 5.5, that implemented and reviewed tasks and often waited 5–10 minutes on review trials and check runs. Costs below are list API prices; on a subscription the same tokens count against usage limits instead.

**Cache prices** ($ per million tokens, [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), 17 October 2026). A 5-minute write is 1.25× the input price, a 1-hour write 2×, and a read 0.1× (0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on Fable 5.1). A read restarts the cache's timer at no extra cost; there are no other cache lengths.

| Model | 5-min write | 1-hour write | Read | A 5-min write costs |
|---|---|---|---|---|
| Opus 5.5 | $5 | $8 | $0.20 | 25 reads |
| Sonnet 5.5 | $2.50 | $4 | $0.10 | 25 reads |
| Fable 5.1 | $12.50 | $20 | $0.25 | 50 reads |
| Haiku 5.5, prompt ≤ 100k | $0.125 | $0.20 | $0.01 | 12.5 reads |
| Haiku 5.5, prompt > 100k | $0.625 | $1 | $0.05 | 12.5 reads |

On Opus 5.5 one avoided re-write pays for about 24 refreshes, so wake-ups win for any wait between 5 minutes and roughly an hour and a half.

**What happened.** The main conversation never went cold: its longest idle stretch was 59 minutes, inside its 1-hour cache. The sub-agents re-wrote their whole 5-minute cache 16 times, about 7.4 M tokens, half of everything they wrote. One sub-agent waited about 6 minutes three times and re-wrote 608k, 626k and 649k tokens.

**Simulation 1: the three worst sub-agents with a refresh every 4 minutes** (Opus 5.5, cache tokens only; a refresh reads the whole cached context).

| Sub-agent | As run | With 4-min refreshes | Refreshes cost | Saved |
|---|---|---|---|---|
| A (3 re-writes) | $23.08 | $14.60 | $0.53 | $8.48 |
| B (2 re-writes) | $20.27 | $14.29 | $0.43 | $5.98 |
| C (1 re-write) | $19.65 | $16.52 | $0.28 | $3.13 |
| **Total** | **$63.00** | **$45.41** | **$1.24** | **$17.58 (28 %)** |

It took 11 refreshes. Across all 19 sub-agents: $174.87 → $141.12, saving $33.75 (19 %). The same token flow priced on other models: Sonnet 5.5 saves $8.79 of $31.50, Fable 5.1 $46.49 of $115.45.

**Simulation 2: the same three sub-agents on other models** (cache and output tokens; compaction leaves an assumed 12k-token summary).

| Scenario | Cost | With 4-min refreshes |
|---|---|---|
| Opus 5.5, as run | $66.40 | $46.21 |
| Sonnet 5.5, no compaction change | $33.20 | $23.11 |
| Haiku 5.5, compacting at ~187k (`autoCompactWindow` 200000) | $3.77 (4–5 compactions each) | $3.40 |
| Haiku 5.5, compacting at ~90k | $1.00 (16–18 compactions each) | $0.96 |

Refreshes save about 30 % on Opus and Sonnet and only pennies on Haiku, whose compaction keeps contexts small. Haiku's price rises 5× above 100k-token prompts, so compacting below 100k is 3–4× cheaper than at 200k, at the price of many more lossy summaries.

**Why not the 1-hour cache instead?** The 1-hour cache costs 60 % more on every write, and the choice turns on how much a conversation writes compared with how long it sits idle:

- **Sub-agents write a lot and wait briefly.** Across all 19, counting cache writes plus the reads that replace avoided re-writes: about $74 as run, about $61 on the 1-hour cache (no re-writes, but every write at $8), and about $42 with 4-minute wake-ups (refreshes included).
- **The main conversation writes little and waits long.** It wrote 0.30 M new tokens in 7.5 hours (the 1-hour premium cost about $0.90) but sat idle 447 minutes. On the 1-hour cache, as run: $8.83. On the 5-minute cache: $32.75 with no refreshes (19 cold re-writes of 250–330k tokens), $13.81 with a refresh every 4 minutes (105 refreshes).

Claude Code's split, the 1-hour cache for the main conversation and the 5-minute cache for sub-agents, fits this kind of work; the rule covers the one gap, sub-agent waits over 5 minutes.

**Method and limits.** The simulations replay each request's cache read and write counts from the session transcripts. A gap of more than 5 minutes between two of a sub-agent's requests counts as a re-write of the whole context; with refreshes, a refresh every 4 minutes of a gap reads the whole context. The model-swap rows assume every model would have used the same tokens and turns as Opus did, which won't hold exactly. A 4-minute wake-up costs a little more than a bare refresh, since it also sends a status check and its reply. One session's numbers, not a general benchmark.

## Install on a machine

Clone into `~/.claude/local-marketplace`, then in Claude Code:

```
/plugin marketplace add ~/.claude/local-marketplace
/plugin install cache-hugger@bushi-local
```

The marketplace is read in place, so after a `git pull` run `/reload-plugins` or start a new session.

## Test

From a plugin's folder: `claude plugin test .`
