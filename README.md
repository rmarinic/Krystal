<div align="center">

# K R Y S T A L
**`// claude code`**

### A native desktop home for Claude Code 💚

Talk to **Claude Code** over your own folders — code, documents, anything — in a fast,
offline, beautifully dark little app. No terminal, no browser tab, no server. Just a window.

<br>

![Platform](https://img.shields.io/badge/platform-Windows-2b3a30?style=flat-square&logo=windows)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-6cc78e?style=flat-square&logo=tauri&logoColor=white)
![Backend](https://img.shields.io/badge/backend-Rust-2b3a30?style=flat-square&logo=rust)
![Self-updating](https://img.shields.io/badge/updates-automatic-8fe0aa?style=flat-square)
![Languages](https://img.shields.io/badge/i18n-EN%20%2F%20HR-2b3a30?style=flat-square)

</div>

---

## ✨ What is Krystal?

Krystal is a desktop chat app for [Claude Code](https://claude.com/claude-code). You point it
at a **project folder** and chat with Claude about what's inside — it can read, write, edit
files and run commands right there, with a live view of everything it does. It's built to feel
calm and friendly for everyday work, not just for developers: pick a folder, start a chat, go.

Under the hood it's a single native `.exe` — a Rust backend in an embedded WebView2 window,
no `localhost`, no Node server, no browser. It launches instantly and works entirely offline
(it only talks to Claude through the `claude` CLI you already have).

## 🌟 Highlights

- **📁 Projects** — each project is a folder. Every project keeps its own chats, model and
  history. A polished picker greets you on launch; switch projects any time.
- **💬 Multiple threads** — a sidebar of conversations, each remembering its Claude session,
  model and working folder. Search across every chat and ★ save any reply.
- **⚡ Live streaming** — answers and tool activity stream in with a typewriter feel; pop open
  the **Activity** panel to watch shells and sub-agents work in real time.
- **🧠 Pick the brain & the leash** — choose the model per chat (Opus / Sonnet / Haiku / Fable)
  and a mode: **Auto** acts freely, **Plan** only researches and proposes.
- **🪄 Setup wizard** — Claude explores your folder, asks a few tailored questions, and writes a
  `CLAUDE.md` project guide so it always knows the context.
- **🧹 Stay sharp** — a context meter warns when a chat grows long; **Compact** keeps a summary
  and trims the rest, **Clear** starts fresh.
- **🔄 Updates itself** — Krystal checks for new versions on launch and updates with one click
  (more below). Install once, stay current forever.
- **🌍 Bilingual** — full English 🇬🇧 and Croatian 🇭🇷 interface, toggle any time.
- **📝 Word-aware** — detects `pandoc` / `python-docx` and lets Claude work with `.docx` files
  when they're available.

## 🚀 Install

**Just want to use it?**

1. Go to the [**latest release**](https://github.com/rmarinic/Krystal/releases/latest).
2. Download `Krystal_x.y.z_x64-setup.exe` and run it.
3. Launch Krystal from the Start menu. 🎉

That's the only manual download you'll ever do — from then on Krystal **updates itself**.

> **Requirements:** the [`claude` CLI](https://claude.com/claude-code) on your `PATH` and logged
> in (Krystal finds it automatically; override with the `CLAUDE_BIN` env var). WebView2 ships
> with Windows 10/11.

## 🔄 Automatic updates

Krystal keeps itself current — no reinstalling, no sending files around.

- On every launch it quietly checks GitHub for a newer signed release.
- If one exists, a friendly screen appears: **“A new version of Krystal is available ✨”**.
- Click **Install now** and a live progress bar shows the download; Krystal then installs and
  relaunches into the new version. Prefer to wait? **Later** dismisses it until next launch.

Every update is **cryptographically signed** — Krystal refuses to install anything that isn't
signed with the project's private key, so the update channel can't be tampered with.

<details>
<summary><b>Cutting a release (maintainer)</b></summary>

<br>

Releases are fully automated by [GitHub Actions](.github/workflows/release.yml). To ship one:

```bat
release.bat 0.2.0
```

That bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`, commits, tags
`v0.2.0` and pushes. The tag triggers the workflow, which builds + signs the installer on a
Windows runner and publishes a GitHub Release with the installer and a signed `latest.json`
manifest. Installed apps pick it up on their next launch.

**One-time setup** — add two repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of your `~/.tauri/krystal_updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (empty if you set none) |

Keep the private key safe — losing it means you can no longer sign updates.

</details>

## 🛠️ Build from source

```sh
# dev — compile and open the window (hot-ish reload)
cd src-tauri
cargo run

# release — a standalone installer in src-tauri/target/release/bundle/
npm install            # once: pulls the Tauri CLI
npm run build
```

Double-clickable `run.bat` (dev) and `build.bat` (release) are included too. Building needs the
[Rust toolchain](https://rustup.rs) and the MSVC build tools (standard Rust-on-Windows setup).

## 🧩 How it works

```
WebView2 (src/)  ──invoke()──►  Rust commands (src-tauri/)  ──spawn──►  claude -p …
   index.html                     commands.rs                  (stream-json)
   app.js        ──Channel──◄     chat()  ── streams tokens/tools back
   updater.js    ──checks──►      GitHub Releases (signed latest.json)
   *.css                          db.rs   ──────►  kristina.db (SQLite, rusqlite)
                                  dialog plugin ─►  native folder picker
```

The frontend is plain HTML/CSS/JS (vendored `marked` + `DOMPurify` + `highlight.js`, so it
renders offline) running in WebView2. It calls Rust `#[tauri::command]`s over Tauri IPC and
receives streamed output over a `Channel`. Rust spawns the `claude` CLI, stores everything in a
bundled SQLite database, and the updater plugin handles self-updates.

## 💾 Where your data lives

```
%APPDATA%\com.kristina.claudecode\kristina.db
```

All threads and messages live in that single SQLite file — back it up or copy it to another
machine to carry your chats with you (close the app first).

## 🔐 Safety

Claude runs with full Claude Code powers in the folder you choose — it can read, write, edit
files and run shell commands there. That's the point: real work needs real access. **Only open
projects on folders you trust Claude to touch.** To make it read-only, edit `base_args()` in
`src-tauri/src/claude.rs` (drop the skip-permissions flag and add
`--allowedTools Read Grep Glob WebSearch WebFetch`).

## 🗂️ Project layout

| path | role |
|------|------|
| `src/index.html` | app shell — picker, sidebar, chat pane, composer, update overlay |
| `src/app.js` | frontend logic — talks to Rust via `invoke` + `Channel` |
| `src/updater.js` | self-update flow (check → ask → download → relaunch) |
| `src/i18n.js` | English / Croatian strings |
| `src/base.css`, `src/chat.css` | the dark, green-on-black theme |
| `src-tauri/src/main.rs` | app bootstrap: probe env, open DB, register commands + plugins |
| `src-tauri/src/commands.rs` | every IPC command |
| `src-tauri/src/claude.rs` | spawn `claude`, stream stream-json, build prompts |
| `src-tauri/src/db.rs` | SQLite store |
| `src-tauri/src/models.rs` | the model catalogue |
| `src-tauri/tauri.conf.json` | window, bundle and updater config |
| `.github/workflows/release.yml` | build + sign + publish on every `v*` tag |

---

<div align="center">
<sub>Built with 💚 using <a href="https://tauri.app">Tauri</a>, Rust and Claude Code.</sub>
</div>
