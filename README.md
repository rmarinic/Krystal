<div align="center">

# K R Y S T A L
**`// claude code`**

### A native desktop home for Claude Code

Talk to **Claude Code** about your own folders (code, documents, research, data) in a calm,
fast desktop app. No terminal, no browser tab, no server. Just a window.

<br>

![Platform](https://img.shields.io/badge/platform-Windows-2b3a30?style=flat-square&logo=windows)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-6cc78e?style=flat-square&logo=tauri&logoColor=white)
![Backend](https://img.shields.io/badge/backend-Rust-2b3a30?style=flat-square&logo=rust)
![Version](https://img.shields.io/github/v/release/rmarinic/Krystal?style=flat-square&color=6cc78e&label=release)
![Self-updating](https://img.shields.io/badge/updates-automatic-8fe0aa?style=flat-square)
![Languages](https://img.shields.io/badge/i18n-EN%20%2F%20HR-2b3a30?style=flat-square)

</div>

---

## What is Krystal?

Krystal is a desktop chat app for [Claude Code](https://claude.com/claude-code). Point it at a
**project folder** and talk to Claude about what's inside. Claude can read, write and edit files
and run commands right there, and you can watch every step as it happens. It's built to feel
friendly for everyday work, not only for developers: writers, researchers and analysts get the
same app as programmers. Pick a folder, start a chat, go.

Under the hood it's a single native `.exe`: a Rust backend driving an embedded WebView2 window.
There's no `localhost`, no Node server and no browser. Krystal talks to Claude only through the
`claude` CLI on your machine, so your chats stay on your machine.

## Highlights

### Conversations
- **Projects and chats.** Every project is a folder with its own chats, tasks, pinned files and
  artifacts. The project screen shows which projects are busy right now.
- **Fast, warm sessions.** Each chat keeps its own Claude process running between messages, so
  replies start quickly and Claude doesn't have to re-read the conversation every time.
- **Replies that format themselves as they stream.** Markdown, code and tables take shape as
  they're written, and each action Claude takes appears as a chip you can open: the command
  and its output, the diff, the page it fetched, the file it touched. Under a reply that's still
  coming, a quiet line says what Claude is doing and for how long, even through long silent
  stretches like writing an artifact, where it shows how much has been written so far.
- **Queue the next message** while Claude is still working. Queued messages go out one at a
  time, in order, and hold if you press Stop.
- **Starting points.** Write / Research / Data / Code cards fill in a first message with blanks
  you Tab through.
- **Reference other chats with `#`**, run a **skill with `/`**, and **paste or drop** files and
  screenshots straight into the message box.
- **Run a command yourself with `$`.** Start a message with `$` and it runs in the project
  folder.
- **Branch from any message.** From one of Claude's replies, the new chat keeps the
  conversation up to there; from one of yours, it stops just before it and puts your message
  back in the box to reword. **Compact** a long chat into a summary, or **Clear** it. Very long
  chats tidy their own context automatically.
- **Copy any message.** A reply copies just what Claude wrote, without the steps in between.
- **Nothing is lost.** Your message is saved the moment you send it and the answer as it's
  written, so closing the app mid-reply keeps both.

### Control
- **Model, effort and mode, per chat.** Choose the model (the list stays current with
  Anthropic's latest), how hard Claude thinks (Low to Max), and how much it may do on its own:
  - **Full access** acts freely.
  - **Auto** works on its own while Claude Code's classifier holds risky actions back.
  - **Accept edits** changes files freely and asks before running commands.
  - **Ask** stops for your yes before changing or running anything (Allow / Always / Deny).
  - **Plan** only researches and proposes.
- **See and undo what changed.** A reply that edited files leaves a "Changed files" strip. Open
  it for line diffs, comment on any line (your comments go to Claude as one review), or **Undo**
  to put the files back as they were before that message.
- **Stop in two steps.** The first press asks Claude to put the work down and keeps the
  session. A second press ends it, background sub-agents included.

### Built by Claude, beside the chat
- **Artifacts.** Pages, charts, diagrams and reports open in a panel next to the conversation
  instead of as code inside it. HTML runs for real in a sandbox, Mermaid diagrams are drawn
  properly, and every version is kept. **Save a copy** gives you one self-contained file that
  works anywhere.
- **Sub-agents you can follow.** Each helper agent gets its own window with a live,
  step-by-step timeline, its numbers and its final report. An **orchestrator mode** lets Claude
  hand work to dedicated workers.

### Around the work
- **Tasks.** A to-do list per project, which Claude can draft from a description and keeps
  current itself, ticking items off as the work lands.
- **Pinned files.** A rail on the right edge of the chat for files you want to glance at.
- **Git and GitHub Actions.** Branch picker, fetch / pull / push, and a build dot that shows the
  latest workflow run. Open a failed run to read its log and hand it to Claude to fix.
- **Run button.** Start the project's own run command and watch its output live.
- **Notifications.** A bell collects what happened in chats you weren't looking at, and Windows
  notifies you when a reply finishes or needs your permission while the app is in the background.
- **Krystal Cloud account.** Link this computer to your account at app.krystal.rip from
  Settings → Remote: Krystal shows a short code, opens the site, and you confirm it there. The
  computer then shows up on your dashboard, online whenever Krystal is running ("Reachable from
  krystal.rip", on unless you turn it off), and soon you'll be able to reach it from anywhere.
- **Keyboard first.** Ctrl+K opens a command palette (chats, projects, actions, settings, and a
  search through every message). Ctrl+F finds words in the open chat, accents or not, and steps
  through every match. Ctrl+Q / Ctrl+E move back and forward through chats, and Ctrl+S lists every
  shortcut.
- **Usage at a glance.** A context ring shows how full the chat is, and beside it your plan's
  limits: the 5-hour session, the week, and each model's weekly share. When the session or the
  week passes 80%, the ring wears a small amber mark (red from 95%) and a notification slides in;
  open the ring to see which limit is the close one.

### The app itself
- **Guided first run.** Krystal checks for Claude Code, installs it if it's missing, and walks
  you through signing in. No terminal knowledge required.
- **Setup wizard.** Claude explores your folder, asks a few tailored questions and writes a
  `CLAUDE.md` guide so it always knows the project.
- **A face that follows along.** The logo is a little crystal that reacts to the work: it
  watches you type, looks up while Claude thinks, nods as each step finishes, smiles when the
  reply lands, turns amber and holds still while Claude waits for your OK, and dozes off when
  you leave it alone.
- **Calm, fluid design.** A document-like layout with its own window frame, a sidebar panel
  floating beside the chat, one set of line icons, and motion that answers what's happening
  (then rests). A soft light behind the chat follows the line Claude is writing. Bundled
  fonts, so it looks the same offline. All motion respects Windows' "reduce animations"
  setting.
- **Bilingual.** Full English and Croatian interface, switchable any time.
- **Updates itself** (see below).

## Install

1. Go to the [**latest release**](https://github.com/rmarinic/Krystal/releases/latest).
2. Download `Krystal_x.y.z_x64-setup.exe` and run it.
3. Launch Krystal from the Start menu.

That's the only download you'll ever do by hand. From then on Krystal **updates itself**.

> **Requirements:** Windows 10/11 (WebView2 ships with it). Krystal installs **Claude Code** for
> you on first run and guides you through signing in. Already have the
> [`claude` CLI](https://claude.com/claude-code)? Krystal finds it automatically, or you can
> point it at one with the `CLAUDE_BIN` environment variable. Optional: the GitHub CLI (`gh`)
> for the build status, `git` for the branch tools.

## Automatic updates

- On every launch Krystal quietly checks GitHub for a newer signed release.
- If there is one, a screen shows what's new (straight from the [changelog](CHANGELOG.md)) with
  **Install now** and **Later**.
- Install now shows the download's progress, then installs and relaunches into the new version.

Every update is **cryptographically signed**. Krystal refuses to install anything that isn't
signed with the project's private key, so the update channel can't be tampered with.

<details>
<summary><b>Cutting a release (maintainer)</b></summary>

<br>

Releases are automated by [GitHub Actions](.github/workflows/release.yml). Add the version's
notes to the top of `CHANGELOG.md` (they appear in the in-app update prompt), then:

```bat
release.bat 0.34.0
```

That bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`, commits, tags
`v0.34.0` and pushes. The tag triggers the workflow, which builds and signs the installer on a
Windows runner and publishes a GitHub Release with the installer and a signed `latest.json`
manifest. Installed copies pick it up on their next launch.

**One-time setup:** add two repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of your `~/.tauri/krystal_updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (empty if you set none) |

Keep the private key safe. Lose it and you can no longer sign updates.

</details>

## Build from source

You need the [Rust toolchain](https://rustup.rs) with the MSVC build tools (the standard
Rust-on-Windows setup) and Node.js for the Tauri CLI.

```sh
# dev: compile and open the window
cd src-tauri
cargo run              # or double-click run.bat

# release: the installer in src-tauri/target/release/bundle/
npm install            # once: pulls the Tauri CLI
npm run build

# frontend tests (plain Node, no dependencies)
npm test
```

Rust unit tests run with `cargo test` inside `src-tauri/`.

## How it works

```
WebView2 (src/)                       Rust (src-tauri/src/)
  index.html, css/                      main.rs       bootstrap, plugins, commands
  app/*.js  ── invoke() ─────────────►  commands/     every IPC command, one file per concern
            ◄── Channel (stream) ─────  session/      one warm `claude` process per chat
                                          │             (stream-json in / out)
                                          ▼
                                        claude/       flags, prompts, event parsing ──► claude CLI
                                        artifacts.rs  MCP artifact tool (same exe, --krystal-mcp-artifacts)
                                        db/           krystal.db (SQLite)
                                        cloud/        linking + live connection ──► Krystal Cloud (wss)
                                        remote/       commands reachable from outside (for the relay)
                                        catalog.rs    live model list
  updater.js ── checks ─────────────►  GitHub Releases (signed latest.json)
```

The frontend is plain HTML/CSS/JS with **no framework and no bundler**: classic scripts in
`src/app/` that share one global scope and load in a fixed order (see
[`src/app/core.js`](src/app/core.js) for the map). `marked`, `DOMPurify`, `highlight.js` and
`mermaid` are vendored, so everything renders offline.

Each chat is served by a persistent `claude --input-format stream-json` process. Messages go in
as JSON lines on its stdin, and its stream-json output is turned into UI events and streamed to
the window over a Tauri `Channel`. Permission prompts in Ask / Auto / Accept edits are handed to
Krystal by the CLI and answered by you. Artifacts come from a small MCP server that is Krystal's
own executable started in a different mode. Undo uses Claude Code's own file checkpointing.

For the full architecture, see [`CLAUDE.md`](CLAUDE.md).

## Where your data lives

```
%APPDATA%\com.krystal.claudecode\
  krystal.db      projects, chats, messages, tasks, pins, artifacts (SQLite)
  attachments\    pasted images
  artifacts\      the current file of each artifact
  task-lists\     the task snapshot Claude reads during a chat
```

To carry your chats to another machine, close the app and copy that folder (`krystal.db` holds
everything that matters). Claude Code's own sessions live where they always do, in `~/.claude`.

## Safety

Claude works with real Claude Code powers in the folder you choose. How much it may do without
asking is up to the **mode** you pick per chat, from **Full access** (nothing checked) through
**Auto** and **Accept edits** to **Ask** (every change and command needs your yes) and **Plan**
(no changes at all). Your own permission rules in `.claude/settings*.json` apply as they would
in a terminal. **Only open projects on folders you trust Claude to work in.**

Krystal opens no port on your computer. Linking it to app.krystal.rip is your choice, made with
a code you confirm while signed in there. The key that link creates lives in Windows Credential
Manager, never in a file or in the app's window, and unlinking (here or on the dashboard) ends it.
Being online there is one connection Krystal makes *out* to app.krystal.rip, and the "Reachable
from krystal.rip" switch closes it.

## Project layout

| path | role |
|------|------|
| `src/index.html` | app shell, loads the scripts in order |
| `src/app/*.js` | the frontend, one file per concern (chat, stream, messages, artifacts, …) |
| `src/i18n.js` | English / Croatian strings |
| `src/onboarding.js`, `src/updater.js` | first-run setup, self-update flow |
| `src/css/` | the stylesheets, one per part of the window, linked in cascade order (`base.css` first, `motion.css` last) |
| `src/fonts/`, `src/vendor/` | bundled fonts and libraries (offline) |
| `src-tauri/src/main.rs` | bootstrap: environment, DB, commands, plugins |
| `src-tauri/src/commands/` | every IPC command, one file per concern (`mod.rs` holds `AppState`) |
| `src-tauri/src/claude/` | finding/installing the CLI, its flags and prompts, stream-json → UI events (one file per concern) |
| `src-tauri/src/session/` | warm per-chat `claude` processes, stop and rewind |
| `src-tauri/src/artifacts.rs` | the artifact MCP server |
| `src-tauri/src/db/` | SQLite store, one file per concern (threads, turns, projects, tasks, pins, artifacts, …) |
| `src-tauri/src/cloud/` | linking this computer to Krystal Cloud (app.krystal.rip), and the live connection that keeps it online there; the key lives in Credential Manager |
| `src-tauri/src/remote/` | the commands a caller from outside may run, and a turn as a stream of events |
| `src-tauri/src/models.rs`, `catalog.rs` | models, efforts, modes, live model list |
| `src-tauri/src/skills.rs`, `discord.rs` | skill discovery, optional Discord presence |
| `src-tauri/src/util.rs` | the few helpers several modules share |
| `tests/` | frontend tests, plus checks that the command wiring, EN/HR strings and script load order agree (`npm test`) |
| `.github/workflows/release.yml` | build, sign and publish on every `v*` tag |

---

<div align="center">
<sub>Built with <a href="https://tauri.app">Tauri</a>, Rust and Claude Code.</sub>
</div>
