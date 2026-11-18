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

**Needs you** shows open asks. **In progress and due soon** shows ticket pace, consecutive failed attempts, and
system problems. Open tickets due within three days appear there, even if still ready. **Not started** lists
the first three remaining ready tickets, then "and N more". **This week** counts shipments since Monday in the configured timezone,
current work, queued tickets, and the optional backlog. **Usage** shows current readings, projections, and
where you are in each period. **Today** lists recent job, shipment, and expiry events. The page binds to
loopback. To see it on a phone, put your own signed-in tunnel in front of it.

## Tickets

`tickets.json` is `{"tickets": [...]}`. The owner and coordinator agree tickets in chat; only the coordinator
writes the file, with `bun ticket.ts add|set|move|order|list`. Each ticket has `id`, `title` (plain words),
`stage` (`ready`, `building`, `in review`, `needs owner`, `shipped`), `order` (within ready), an optional `link`,
`updated`, and a four-part `brief`: `job`, `doneMeans`, `whereToLook`, `check`. The `link` is how a team ties a
ticket to its own tracker (an issue or pull request URL). Launching a build or fix with
`--ticket <id>` moves it to `building`. Launching a review moves it to `in review`. Every move is recorded
in `events.jsonl` with who made it and when.

Ticket pace starts at the first job and pauses in `needs owner`. Adding a ticket requires
`ticket.ts add --estimate <minutes>`. Older tickets without estimates still show their due dates.
Pace is on track through 100%, a little over through 150%, and very over after that.
Use `--due YYYY-MM-DD` to show a due date. Ship with `ticket.ts move <id> shipped --proof "What was checked and where"`.
Use `ticket.ts set <id>` with `--estimate <minutes>`, `--due <YYYY-MM-DD|none>` or `--title "<plain words>"`
to update an existing ticket.
Add `--waiting-on <id>` with `ticket.ts add`, or use `ticket.ts set <id> --waiting-on <id>|none` to update
or clear the optional `waitingOn` reference. The page shows the referenced ticket beneath the ticket title in the main table.

## The alarms (all to the coordinator, all without tokens)

A job finished; a job was stopped (past its minutes or token cap, or silent for 10 minutes); nothing is running
while a ticket is ready; a ticket is `building` or `in review` with no job for 30 minutes; a meter passed 50, 80
or 100 percent or turned "too fast"; a recorded sign-in ends within 3 hours; overhead passed 15 percent of the
day's usage. A ticket also raises one alarm when it first becomes very over. Each is written to `events.jsonl`,
and everything since the last wake goes out as one message, at most one every 5 minutes.
Usage alarms can fire again after the reading falls below the threshold and crosses it again. A changing
forecast alone does not rearm a pace warning.

## When it texts you

Only an accepted ask from `bun notify-owner.ts ask` can send a text. Each ask has one question, a recommendation,
a reason from the fixed list, and a default with a deadline or an allowed no-default reason. Up to three can
be open. The watcher closes expired asks and tells the coordinator the default is due. The coordinator confirms it was
taken with `notify-owner.ts --resolved <id> "<action taken>"`. The watcher also asks the coordinator to check each
ask after two days and drops it if it is not reconfirmed within a day. The coordinator records the owner's answer by ask ID. See [the coordinator's commands](COORDINATOR.md#when-to-text-the-owner).

At most 4 texts in any 24 hours by default. After that the ask still appears on the page and the coordinator
is told the text was held. Channels are Telegram (Bot API) or any command. Unanswered wakes appear in **In progress**.

Pending free-text asks remain visible. Resolve a free-text ask by its ID. Old `## Needs you` bullets
remain in `state-of-play.md` for the coordinator to review.

## The ledger

`ledger.jsonl` stores every job start and end. `bun ticket.ts list` shows attempt counts and
`bun ticket.ts history <id>` outputs one attempt per line, in launch order, from the same ledger.
Each attempt has an `id` and `name` (the job's identifier and label), a `purpose` (build, review, fix
or retry), and `retryOf` (the earlier job ID when launched with `--retry-of <job id or run folder name>`).
Investigation and specialist jobs linked to a ticket count as build attempts unless launched as retries.
`started` and `ended` are timestamps. `minutes` is the elapsed time and `tokens` records input, cached,
output and fresh (input minus cached plus output). Unknown counts are null.
`outcome` is finished, stopped, capped or failed once the job ends, and `why` is the recorded reason.
A coordinator stop recorded with `bun run.ts stop <job-id> --reason redirected` sets `reasonKind` to
`redirected` and is skipped in the Fails column.
The reader derives purpose and outcome from the original kind and result for older jobs.
The launcher asks for a final line of exactly `VERDICT: DONE` or `VERDICT: NOT DONE`.
The attempt records `achieved` as true or false for these verdicts, or null when the verdict is missing or the job did not finish.

## Configuration

Reins looks for `reins.config.json` in `REINS_PRIVATE_DIR` by default. Set `REINS_CONFIG` to point directly
to a config file. The config's folder holds the private records unless the file sets `privateDir`.
Launched jobs do not inherit `REINS_PRIVATE_DIR` or `REINS_CONFIG`. See `reins.config.example.json`.
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
