# Setting up the simple factory (instructions for the coordinator chat)

You are a coordinator chat (Claude Code or Codex) setting this up with your user, the owner. Do the steps yourself;
ask only the questions below, in plain words, one at a time. Never sign in to anything for the owner, never ask
for a password, and never print a token. macOS with launchd is the only supported system so far; say so and stop
if this is not a Mac.

0. **From zero:** the owner has cloned this project and you are in its folder. Run `bun install`. All commands
   below run from this folder.
1. **Look first.** Run `which bun codex claude python3`, then `codex login status` and `claude auth status` for the
   tools that exist. A tool that is installed but not signed in: ask the owner to sign in themselves, or leave it off.
2. **Ask.** (a) Which tools to use, if both exist, and which is the default for new jobs. (b) Their timezone, if the
   computer's is not right. (c) "Do you want texts on Telegram when I need a decision from you?" If yes, walk them
   through it: in Telegram, message @BotFather, send `/newbot`, follow the prompts, and keep the token it gives;
   then send any message to the new bot, and open `https://api.telegram.org/bot<token>/getUpdates` in a browser to
   find `"chat":{"id": ...}`. They paste both into a private file themselves:
   `{"botToken": "...", "chatId": "..."}` at `~/.simple-factory/telegram.json` (mode 600). Do not read it back to them.
   (d) Any extra meter they want (for example a cloud bill): a name, a limit, monthly or weekly, and a command
   that prints `{"used": n}` with an optional forecast. Optional; skip unless they ask.
3. **Write the config** at `~/.simple-factory/factory.config.json`, starting from `factory.config.example.json`
   and keeping only what applies. Set each tool's everyday model and its tiers from what that tool offers today
   (its `/model` list and the vendor's "which model" page), not from the example's names, which will age; see
   "Choosing the model" in `COORDINATOR.md`. Leave `"live": false` for now. Copy `state-of-play.template.md` to
   `~/.simple-factory/state-of-play.md`.
4. **Claude usage meter only:** ask the owner to run `claude` once in this folder and accept the
   "do you trust this folder" question themselves.
5. **Install the two LaunchAgents.** For each file in `launchd/`, replace `__BUN__` (`which bun`), `__REPO__`
   (this folder's full path), `__PRIVATE__` (the private folder's full path) and `__PATH__` (the folders holding
   `bun`, `codex`, `claude`, `python3`, plus `/usr/bin:/bin`), write the result to `~/Library/LaunchAgents/`, and run
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<file>`. Ask before running these two commands.
6. **Check.** Run `bun doctor.ts` and fix every MISSING line you can. Open `http://127.0.0.1:4319`.
7. **Your wake.** With the default `"coordinator": {"channel": "file"}`:
   - Claude Code: run `bun wait.ts` as a background command. It ends when there is news; read its output, act,
     and start it again.
   - Codex: run `bun wait.ts` as the last command of a turn; it blocks without using tokens and returns the
     news. If your Codex can be woken by a command, set the coordinator channel to `"command"` with that command instead.
   - File wake: make sure doctor's file wake test passes, then launch one small real job and see its finish
     arrive in this coordinator chat. If a background wait ends without waking the chat, try the blocking form
     or configure a command wake and test it in step 8.
8. **Go live** only when the owner says so: set `"live": true`. The file wake works in dry-run. Owner texts and
   other wake channels need live sending. To verify a command wake, launch one small real job after enabling
   live sending and see its finish arrive in this coordinator chat. Only accepted structured asks can text the
   owner. Check the [ask commands](COORDINATOR.md#when-to-text-the-owner) before opening one.
9. **Report** to the owner: what is on, the page address, how they will be reached, and anything doctor still lists.
   Then read `COORDINATOR.md` and follow it from now on.

Publishing changes to this code? Install the pre-push check described in `CONTRIBUTING.md` first.
