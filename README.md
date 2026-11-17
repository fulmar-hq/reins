# Reins

**Claude Code** and **Codex** do the pulling. Reins gives you a light touch to steer the work and feel when
something is wrong. It adds a watchdog, a ticket board and a usage page for you and your coordinator chat,
whether you use one harness or both.

Reins makes no model calls and needs no model API keys. It starts the harnesses' own commands
(`codex exec`, `claude -p`) under the sign-in you already have.

What it adds on top of the tools:

- **Work keeps moving when nobody is watching.** The watchdog wakes the coordinator when a job finishes,
  goes silent, runs past a cap or gets stuck, or when work is ready and nothing is running. It uses no tokens.
- **One page across both tools**: what needs you, what is running, your tickets, what shipped, and whether usage is on track.
- **It reaches you only when a decision is yours** (see "When it texts you").
- **A repeatable routine with a record**: one ticket, one builder, one fresh reviewer, every job in a ledger.

What it is not: an agent loop, a sandbox, a reviewer, a memory, or a replacement for either tool. Those stay
in the tools. There are no standing AI "owners" and nothing ever wakes a model to ask "is there anything to do?".

## Quick start

Requirements: macOS (launchd is the only scheduler supported so far), [Bun](https://bun.sh), python3 (only for the
Claude usage meter), and at least one of Codex or Claude Code, installed and signed in by you. One tool is enough.

```sh
git clone https://github.com/fulmar-hq/reins.git && cd reins
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
| `page.ts` | The read-only usage page on `http://127.0.0.1:4319`, drawn from `state.json`. |
| `ticket.ts` | The coordinator's commands for the ticket board in `tickets.json`. |
| `notify-owner.ts` | Opens, reconfirms or resolves an owner ask. |
| `wait.ts` | The coordinator's wake: blocks without tokens until the watcher has news. |
| `doctor.ts` | Says in plain words what works and what is missing. |
| `privacy-check.ts` | Stops private details from being published (see CONTRIBUTING.md). |

Everything it knows lives in small files in your private folder (default `~/.reins`): `reins.config.json`,
`tickets.json`, `state-of-play.md`, `ledger.jsonl`, `events.jsonl`, `state.json`, and `work/jobs/<date>-<name>/`
holding each job's `prompt.txt`, `log.txt` and `result.txt`.

## The page

The page shows **Needs you** (open asks), **Running now** (model and effort when recorded, minutes and tokens
against the caps), **Tickets** by stage, **Shipped today** (model and effort when recorded, tokens, and today's usage
split), **Meters** (usage, forecast when available, reset and pace), **Notes** (state-of-play notes and defaults
due or taken) and **Health** (when the
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

Ticket pace starts at the first job and pauses in `needs owner`. The estimate comes from
`ticket.ts add --estimate <minutes>` or the median of at least three shipped tickets with job starts.
Pace is on track through 100%, a little over through 150%, and very over after that.
Use `--due YYYY-MM-DD` to show a due date. Ship with `ticket.ts move <id> shipped --proof "What was checked and where"`.

## The alarms (all to the coordinator, all without tokens)

A job finished; a job was stopped (past its minutes or token cap, or silent for 10 minutes); nothing is running
while a ticket is ready; a ticket is `building` or `in review` with no job for 30 minutes; a meter passed 50, 80
or 100 percent or turned "too fast"; a recorded sign-in ends within 3 hours; overhead passed 15 percent of the
day's usage. A ticket also raises one alarm when it first becomes very over. Each is written to `events.jsonl`,
and everything since the last wake goes out as one message, at most one every 5 minutes.

## When it texts you

Only an accepted ask from `bun notify-owner.ts ask` can send a text. Each ask has one question, a recommendation,
a reason from the fixed list, and a default with a deadline or an allowed no-default reason. Up to three can
be open. The watcher closes expired asks and tells the coordinator the default is due. The coordinator confirms it was
taken with `notify-owner.ts --resolved <id> "<action taken>"`. The watcher also asks the coordinator to check each
ask after two days and drops it if it is not reconfirmed within a day. The coordinator records the owner's answer by ask ID. See [the coordinator's commands](COORDINATOR.md#when-to-text-the-owner).

At most 4 texts in any 24 hours by default. After that the ask still appears on the page and the coordinator
is told the text was held. Channels are Telegram (Bot API) or any command. Coordinator silence appears in Health.

On upgrade, existing `needs owner` tickets stay in their ticket stage. Pending free-text asks and old
`## Needs you` bullets in `state-of-play.md` remain visible. Resolve a free-text ask by its ID and remove
old bullets once addressed. Move useful background into `## Notes`.

## The ledger

`ledger.jsonl` has one line when a job starts and one when it ends: id, name, kind, tool, ticket, started, ended,
minutes, tokens (input, cached, output, and fresh = input - cached + output), result (`finished`, `stopped-cap`,
`stopped-silent`, `failed`, or `ended-unconfirmed` when the job's process could not be confirmed as ours and so
nothing was signalled) and the run folder. Token counts are read from the tool's own records; a count that
cannot be read is `null`, never a guess.

## Configuration

Reins reads `reins.config.json` in the private folder. Set `REINS_PRIVATE_DIR` to use a different private folder
or `REINS_CONFIG` to point directly to another config file. See `reins.config.example.json`.
The config sets which tools are enabled, their everyday model and effort, named **tiers** for other kinds of task (`hard`, `review`, `bulk`,
`visual`; see "Choosing the model" in `COORDINATOR.md`) and extra arguments, the caps, the timezone, how the owner and coordinator are
reached, `notify.live` (false means dry-run: nothing leaves this machine; the coordinator's wake file is still written), and optional **extra meters**: a name, a limit, a
monthly or weekly reset, and a command that prints `{"used": n}` with optional `forecast` and `limit`. With no
file, every installed tool is enabled and nothing is sent.

## Uninstall

`launchctl bootout gui/$(id -u)/com.reins.watch; launchctl bootout gui/$(id -u)/com.reins.page`,
then delete the two files from `~/Library/LaunchAgents`. Your private folder is left alone; delete it yourself if you wish.

## Cost and limits

Reins itself makes no model calls. Every 15 minutes it asks each tool for its usage: Codex through its own
status call, and Claude Code by opening its own `/usage` panel in a new, separate process and typing only that
command. No prompt is sent, and the reader refuses any reading unless the panel itself reports zero input and
zero output tokens for that session; that is the tool's own counter, not an independent bill. Extra-meter commands
run on their own schedule and cost whatever they cost.

Limits: macOS only. Claude job token counts are read from `claude -p` stream output. Overhead is measured for
Codex sessions only. The Claude meter needs a folder Claude already trusts. The wake is proven up to the point
where `wait.ts` returns the news; being woken by that depends on your chat app (see SETUP.md).

## License

MIT; see `LICENSE`.
