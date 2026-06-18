# Krystal — Tauri desktop app

A **full 1:1 rewrite** of the `claude_kristina` web app as a native Windows
desktop application built with [Tauri 2](https://tauri.app) (Rust backend +
WebView2 frontend). Same UI, same features, same behaviour — but it's a real
`.exe` window instead of a Node server + browser tab.

There is no HTTP server, no `localhost` port and no browser. The frontend runs
in an embedded WebView2 and talks to a Rust backend over Tauri IPC.

```
WebView2 (src/)  ──invoke()──►  Rust commands (src-tauri/)  ──spawn──►  claude -p …
   index.html                     commands.rs                  (stream-json)
   app.js        ──Channel──◄     chat()  ── streams tokens/tools back
   *.css                          db.rs   ──────►  kristina.db (SQLite, rusqlite)
                                  dialog plugin ─►  native folder picker
```

## What it does (unchanged from the web version)

- **Project picker (entry screen)** — every launch opens a project picker. You
  pick a **project** (a folder) to enter its chat screen, or **✨ Initialize new
  project** to choose a new folder (the Tauri dialog plugin). Each project keeps
  its own chats, model and history. Inside a project, **▸ new chat** starts a
  chat in that folder (no folder prompt), and the **⇄ switch** button in the
  sidebar returns you to the picker.
- **Multiple threads** — sidebar lists the current project's conversations; each
  remembers its Claude session (resumed via `--resume`), its model, and the
  folder it runs in. Search and ★ Saved are scoped to the open project.
- **Live streaming** — a typewriter reveals tokens + tool activity, streamed
  from Rust to the UI over a Tauri `Channel` (the moral equivalent of the old
  SSE stream).
- **Model picker / Compact / Clear / Insight** — per-chat model; tidy or reset
  the conversation; an on-demand usage tip. A context meter + side tips warn (in
  plain language) when a chat grows long enough to slow Claude down.
- **Initialize wizard** — Claude explores the folder, asks tailored Croatian
  questions, and writes a `CLAUDE.md` project guide (backing up any existing one).
- **SQLite store** (`rusqlite`, bundled — no external SQLite needed) holds all
  threads + messages. **Search** across every chat and **★ Save** any reply.
- **Word support probe** — pandoc / python-docx are detected at startup and
  Claude is told which `.docx` tricks are available, exactly as before.

## Requirements

- The **`claude` CLI** on your `PATH`, logged in. (Found automatically; you can
  override with the `CLAUDE_BIN` environment variable.)
- **WebView2 runtime** — preinstalled on Windows 10/11.
- To build from source: the **Rust toolchain** (`rustup`, stable). Microsoft
  Visual C++ Build Tools are needed for linking (standard Rust-on-Windows setup).

## Run it

**Dev (compile + launch the window):**

```sh
cd src-tauri
cargo run
```

or double-click **`run.bat`**. The first build pulls in Tauri and takes a few
minutes; after that it's fast.

**Standalone release `.exe` (everything embedded):**

```sh
cd src-tauri
cargo build --release
# → src-tauri/target/release/krystal.exe   (copy it anywhere and double-click)
```

or double-click **`build.bat`**. The entire UI is baked into the executable, so
the single `krystal.exe` is the whole app (it still needs the `claude` CLI).

**Windows installer (.msi / NSIS setup):** install the Tauri CLI once, then build:

```sh
cargo install tauri-cli --locked   # or:  npm install   (uses @tauri-apps/cli)
cargo tauri build                  # or:  npm run build
```

Installers land in `src-tauri/target/release/bundle/`.

## Where your data lives

The SQLite database is created at:

```
%APPDATA%\com.kristina.claudecode\kristina.db
```

To carry over chats from the old web app, copy its `data/kristina.db` there
(close the app first). On first run, an old `threads.json` sitting next to the
database is auto-imported (kept as `threads.json.imported`).

## Capabilities / safety

Claude runs with `--dangerously-skip-permissions`, i.e. **full Claude Code**: it
can read, write, edit files and run shell commands in the chosen folder — the
power this app is meant to give. Only point new chats at folders you trust it to
touch. To make it read-only, edit `base_args()` in `src-tauri/src/claude.rs`
(drop the skip flag, add `--allowedTools Read Grep Glob WebSearch WebFetch`).

## Project layout

| path | role |
|------|------|
| `src/index.html` | app shell (sidebar + chat pane + composer) |
| `src/app.js` | frontend logic — talks to Rust via `invoke` + `Channel` |
| `src/base.css`, `src/chat.css` | styles (copied verbatim from the web version) |
| `src/vendor/` | marked + DOMPurify + highlight.js, vendored so the UI works offline |
| `src-tauri/src/main.rs` | app bootstrap: probe env, open DB, register commands |
| `src-tauri/src/commands.rs` | every IPC command (1:1 with the old `/api/*` routes) |
| `src-tauri/src/claude.rs` | spawn `claude`, stream stream-json, build prompts |
| `src-tauri/src/db.rs` | SQLite store (faithful port of `db.js`) |
| `src-tauri/src/models.rs` | the model catalogue |
| `src-tauri/tauri.conf.json` | window + bundle config |
| `src-tauri/capabilities/default.json` | IPC permissions (core + dialog) |

## How the rewrite maps to the original

| original (`server.js` / `db.js`) | here |
|----------------------------------|------|
| `POST /api/chat` (SSE) | `chat` command streaming over a `Channel` |
| `POST /api/pick` (PowerShell dialog) | `dialog.open({directory:true})` plugin, via the project picker |
| *(new)* projects / entry screen | `list_projects` / `create_project` / `select_project` / `delete_project` |
| `GET/POST/DELETE /api/threads` | `list_threads` (project-scoped) / `create_thread` / `get_thread` / `delete_thread` |
| `/api/threads/:id/{model,clear,compact,hint}` | `set_model` / `clear_thread` / `compact_thread` / `hint_thread` |
| `/api/threads/:id/init/{analyze,draft,save}` | `init_analyze` / `init_draft` / `init_save` |
| `/api/{config,search,favorites}`, favorite toggle | `get_config` / `search_messages` / `list_favorites` / `toggle_favorite` |
| `node:sqlite` store | `rusqlite` (bundled SQLite) |
| `claude -p … --output-format stream-json` | identical flags, spawned from `claude.rs` |
