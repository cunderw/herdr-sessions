# herdr-sessions

Find any past [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [pi](https://github.com/badlogic/pi-mono), omp or omo session by what was said in it, and bring it back, inside the [Herdr](https://herdr.dev) desktop app.

![Searching past sessions and sending an exchange to an agent](demo.gif)

![Agent sessions in Herdr](preview.png)

- **One popup for every project** (`ctrl-b h`): your sessions newest first, each with its title or first prompt, its project and branch, the agent, how long ago, and how many turns you typed.
- **Type to filter** by title, prompt, folder or branch. Start with `/` (or press Tab) to **search what was said** in every transcript, and see the line that matched.
- **A preview** of the selected session: where it ran, its id, and its last exchanges.
- **Enter resumes it in a new tab** in the session's own folder, named after it (`claude --resume <id>`, `codex resume <id>`, `omp --resume <file>`, `omo --session <file>` or `pi --session <file>`). Shift+Enter resumes it in a split instead, and Cmd/Ctrl+Enter copies the session id.
- **Fork it** (Ctrl+O or the Fork button): a new session that starts from this one's history, in a new tab, leaving the original as it was (`claude --resume <id> --fork-session`, `codex fork <id>` or `pi --fork <file>`). omp and omo can't fork from the command line, so Fork is greyed out for theirs.
- **Send it to your agent**: Ctrl+S, or the Send buttons, pastes the last exchange (or one message) into the prompt of the agent you opened the popup from, headed `From a past session (<title>, <date>):`. Nothing is sent: add your own words and press Enter yourself.
- **Readable titles**: the agent's own session titles when it has them (Claude Code's, Codex's thread names, pi and omo session names, omp titles), else the first sentence of your first prompt, without code blocks or pasted text.
- **Sessions running right now** in a Herdr terminal are marked live, with their status, and Enter goes to that agent instead of starting a second copy.

## Install

```sh
git clone https://github.com/cunderw/herdr-sessions
./herdr-sessions/install.sh
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`, or bind the keys you like.

`install.sh` copies the mod into `~/.config/herdr-app/mods/sessions`, because a symlinked mod folder doesn't draw its icons. Run it again after pulling.

Sessions are read from `~/.claude`, `~/.codex`, `~/.omp/agent`, `~/.omo/agent` and `~/.pi/agent`, or from `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` and `$PI_CODING_AGENT_DIR` when you set them. To point it somewhere else, write `~/.config/herdr-app/sessions.json` (every key optional):

```json
{ "claude": "~/.claude", "codex": "~/.codex", "omp": "~/.omp/agent", "omo": "~/.omo/agent", "pi": "~/.pi/agent" }
```

Agent icons follow Herdr's program table, so a personal icon or tile in `programs.json` shows here too.

## What it touches

It reads your Claude Code transcripts (`projects/*/*.jsonl`, not sub-agents) and the small `sessions/<pid>.json` files Claude Code writes for running sessions, and your Codex transcripts (`sessions/**/rollout-*.jsonl`) and `session_index.jsonl`. For omp, omo and pi, which share pi's transcript format, it reads `sessions/*/*.jsonl` (not sub-agents), plus omo's `session-holders/` and omp's `terminal-sessions/` files to tell which session a running agent has open. It never changes them.

It runs `find` and `stat` to list them, `rg` (falling back to `grep`) to index and search them, `tail` for the preview, `test -d` before resuming, `hc get` when Herdr doesn't report a terminal's process, `ps -o tty=` to find a running omp's terminal, and nothing else. Resuming and forking start the session's agent in a new terminal.

Copying an id writes it to your clipboard. Sending to an agent goes through the clipboard too: it puts the text there, pastes it with Herdr's `terminal.paste`, and 400ms later puts back the text you had copied, unless you've copied something else since. A copied image or file is not put back.

It writes one file: an index of titles, folders and first prompts in `~/.config/herdr-app/data/sessions/index.json`, so the popup opens without rereading every transcript. Delete it any time; it is rebuilt.

[RECIPE.md](RECIPE.md) has the full brief. Icons are from [Lucide](https://lucide.dev) (ISC); the agent marks are Herdr's own.
