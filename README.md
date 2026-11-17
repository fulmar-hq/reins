# Simple factory

A thin layer over **Claude Code** and **Codex** for one person (the owner) working with one long-running
coordinator chat. It works with either tool alone or both. It is plain code: it makes no model calls,
needs no model API keys, and only starts the tools' own commands (`codex exec`, `claude -p`) under the
sign-in you already have.

What it adds on top of the tools:

- **Work keeps moving when nobody is watching.** A watcher that uses no tokens notices a finished, silent,
  runaway or stuck job, or ready work with nothing running, and wakes the coordinator with exactly what changed.
- **One page across both tools**: what needs you, what is running, your tickets, what shipped, and whether usage is on track.
- **It reaches you only when a decision is yours** (see "When it texts you").
- **A repeatable routine with a record**: one ticket, one builder, one fresh reviewer, every job in a ledger.

What it is not: an agent loop, a sandbox, a reviewer, a memory, or a replacement for either tool. Those stay
in the tools. There are no standing AI "owners" and nothing ever wakes a model to ask "is there anything to do?".

## Quick start

Requirements: macOS (launchd is the only scheduler supported so far), [Bun](https://bun.sh), python3 (only for the
Claude usage meter), and at least one of Codex or Claude Code, installed and signed in by you. One tool is enough.

```sh
git clone <this repository> simple-factory && cd simple-factory
bun install
bun doctor.ts        # says what it found; "watcher has never run" is expected before setup
```

Then open your coordinator chat (Claude Code or Codex) in that folder and say: **"Read SETUP.md and set this up
with me."** It asks a few questions, writes the config, installs two LaunchAgents and runs `bun doctor.ts` again.
All commands in these docs are run from this folder. (Inside a larger repository this project may sit in a
subfolder; run them from that subfolder.)

## The parts

| Part | What it does |
|---|---|
| `run.ts` | Starts one disposable job with the tool's own command, in its own run folder, and returns at once. |
| `watch.ts` | Runs every 60 seconds: closes jobs, reads meters, records events, wakes the coordinator, writes `state.json`. |
| `page.ts` | One read-only page on `http://127.0.0.1:4319`, drawn from `state.json`. |
| `ticket.ts` | The coordinator's one-line commands for `tickets.json`. |
| `notify-owner.ts` | The coordinator's deliberate text to the owner. |
| `wait.ts` | The coordinator's wake: blocks without tokens until the watcher has news. |
| `doctor.ts` | Says in plain words what works and what is missing. |
| `privacy-check.ts` | Stops private details from being published (see CONTRIBUTING.md). |

Everything it knows lives in small files in your private folder (default `~/.simple-factory`): `factory.config.json`,
`tickets.json`, `state-of-play.md`, `ledger.jsonl`, `events.jsonl`, `state.json`, and `work/jobs/<date>-<name>/`
holding each job's `prompt.txt`, `log.txt` and `result.txt`.

## The page

Six parts, in order: **Needs you**, **Running now** (name, minutes and tokens against the caps), **Tickets** by stage,
**Shipped today** (with tokens, and today's usage split between build, review, investigation and overhead),
**Meters** (used, when it resets, and a pace verdict: plenty left, on track, or too fast) and **Health** (when the
watcher last ran, when the coordinator last acted, whether sending is live). It is bound to this computer only;
to see it on a phone, put your own signed-in tunnel in front of it.

## Tickets

`tickets.json` is `{"tickets": [...]}`. The owner and coordinator agree tickets in chat; only the coordinator
writes the file, with `bun ticket.ts add|move|order|list`. Each ticket has `id`, `title` (plain words),
`stage` (`ready`, `building`, `in review`, `needs owner`, `shipped`), `order` (within ready), an optional `link`,
`updated`, and a four-part `brief`: `job`, `doneMeans`, `whereToLook`, `check`. The `link` is how a team ties a
ticket to its own tracker (an issue or pull request URL); nothing here polls that tracker. Launching a job with
`--ticket <id>` moves the ticket to `building`; nothing else moves a ticket automatically. Every move is recorded
in `events.jsonl` with who made it and when.

## The alarms (all to the coordinator, all without tokens)

A job finished; a job was stopped (past its minutes or token cap, or silent for 10 minutes); nothing is running
while a ticket is ready; a ticket is `building` or `in review` with no job for 30 minutes; a meter passed 50, 80
or 100 percent or turned "too fast"; a recorded sign-in ends within 3 hours; overhead passed 15 percent of the
day's usage. Each is written once to `events.jsonl`, and everything since the last wake goes out as one message,
at most one every 5 minutes.

## When it texts you

Only when the coordinator needs you for something it cannot resolve itself. Progress, stalls, finished jobs and
meter warnings never reach you; they go to the coordinator and the page. There are exactly two ways a text is sent:
the coordinator runs `notify-owner.ts` on purpose, or the coordinator itself has not responded to waiting events
for 30 minutes while work is waiting (one text, not repeated until it responds). At most 4 texts in 24 hours;
beyond that a text is held on the page and the coordinator is told. Channels: Telegram (Bot API) or any command.

## The ledger

`ledger.jsonl` has one line when a job starts and one when it ends: id, name, kind, tool, ticket, started, ended,
minutes, tokens (input, cached, output, and fresh = input - cached + output), result (`finished`, `stopped-cap`,
`stopped-silent`, `failed`, or `ended-unconfirmed` when the job's process could not be confirmed as ours and so
nothing was signalled) and the run folder. Token counts are read from the tool's own records; a count that
cannot be read is `null`, never a guess.

## Configuration

One file, `factory.config.json` in the private folder; see `factory.config.example.json`. It sets which tools are
enabled, their everyday model and effort, named **tiers** for other kinds of task (`hard`, `review`, `bulk`,
`visual`; see "Choosing the model" in `COORDINATOR.md`) and extra arguments, the caps, the timezone, how the owner and coordinator are
reached, `notify.live` (false means dry-run: nothing leaves this machine; the coordinator's wake file is still written), and optional **extra meters**: a name, a limit, a
monthly or weekly reset, and a command that prints `{"used": n}` with optional `forecast` and `limit`. With no
file, every installed tool is enabled and nothing is sent.

## Uninstall

`launchctl bootout gui/$(id -u)/com.simple-factory.watch; launchctl bootout gui/$(id -u)/com.simple-factory.page`,
then delete the two files from `~/Library/LaunchAgents`. Your private folder is left alone; delete it yourself if you wish.

## Cost and limits

The factory itself makes no model calls. Every 15 minutes it asks each tool for its usage: Codex through its own
status call, and Claude Code by opening its own `/usage` panel in a new, separate process and typing only that
command. No prompt is sent, and the reader refuses any reading unless the panel itself reports zero input and
zero output tokens for that session; that is the tool's own counter, not an independent bill. Extra-meter commands
run on their own schedule and cost whatever they cost.

Limits: macOS only. Claude job token counts are read from `claude -p` stream output. Overhead is measured for
Codex sessions only. The Claude meter needs a folder Claude already trusts. The wake is proven up to the point
where `wait.ts` returns the news; being woken by that depends on your chat app (see SETUP.md).

## License

MIT; see `LICENSE`.
