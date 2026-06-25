# CLAUDE.md — Krystal

## Overview
- **Krystal** is a native Windows desktop chat application for **Claude Code** — it wraps the `claude` CLI in a clean graphical UI so users get a proper app experience instead of the terminal.
- **Stack:** Tauri 2 — Rust backend in `src-tauri/` + vanilla HTML/CSS/JS frontend in `src/`. No framework, no bundler.
- **Audience/goal:** make Claude Code pleasant for everyone, including non-technical users. Originally single-purpose; now being generalized to support **any** project type (writing / research / code / data).
- **Status:** functional and shipping at **v0.3.0**; releases automated via GitHub Actions.

## Architecture (keep this split)
- `src-tauri/claude.rs` — shells out to the `claude` CLI, handles streaming.
- `src-tauri/commands.rs` — Tauri command handlers exposed to the frontend.
- `src-tauri/db.rs` — SQLite persistence for chats/projects.
- `src/app/` — the frontend UI logic, split into cohesive **classic scripts that share one global scope** (no bundler/modules). They load in order via `<script defer>` (see `index.html`); a symbol declared in an earlier file is visible to all later ones, so **load order matters** and `boot.js` (the entry point) loads last. Layout: `core` (IPC/`els`/`state`/`api`/utils) → `sidebar` → `chat` → `projects` → `controls` → `activity` → `search` → `messages` → `stream` → `wizard` → `localization` → `settings` → `git` → `links` → `logo` → `usage` → `boot`. See `src/app/core.js` for the full map.
- `src/i18n.js`, `src/onboarding.js`, `src/updater.js` — i18n dictionary, first-run onboarding, and self-update (load before the `app/` modules).
- Self-updates ship via **GitHub Releases**.

## Frontend file map (where to find things)
Loaded in this order; each file may use symbols from any earlier one (shared global scope).
- `src/i18n.js` — EN/HR string dictionary + `window.I18N` (`t`/`getLang`/`setLang`); fires `i18n:changed`.
- `src/onboarding.js` — first-run gate: install Claude Code + sign-in flow (own IIFE scope).
- `src/updater.js` — self-update overlay (check GitHub Releases, download, install).
- `src/app/core.js` — foundation: Tauri IPC handles, `$`, `tr`, the `els` element map, `state`, context-window constants, the `api` wrapper, and shared utils (`basename`, `escapeHtml`, `closeOverlay`/`openOverlay`, `replayClass`, `cssEsc`, …).
- `src/app/sidebar.js` — thread list rendering, inline rename, search/saved results list.
- `src/app/chat.js` — thread view (`openThread`/`showEmpty`), usage meter + context-rot tips, message bubbles (`appendMessage`), star/favorite.
- `src/app/projects.js` — project picker (entry screen), `startNewChat`, welcome-screen Initialize/Reinitialize.
- `src/app/controls.js` — model/mode pickers (`createPicker`), compact/clear/hint actions, the compact/clear progress overlay.
- `src/app/activity.js` — Activity panel: live shells & sub-agents (track/render tool runs).
- `src/app/search.js` — sidebar search box + Saved (favorites) toggle.
- `src/app/messages.js` — assistant transcript building blocks: action chips (expand/diff/output), plan & AskUserQuestion cards, `renderSegments`.
- `src/app/stream.js` — composer input/autosize, the typewriter (`makeTyper`), concurrent per-thread streaming (`state.live`), `send`/stop.
- `src/app/mentions.js` — `#`-reference another chat from the composer: a `#` autocomplete over the project's chats, reference pills above the input, and `resolveComposerRefs` → thread ids passed as `refs` to the `chat` command (backend folds the referenced transcripts into the prompt as background context).
- `src/app/wizard.js` — Initialize wizard state machine (brief → analyze → questions → review → save) + the CLAUDE.md editor.
- `src/app/localization.js` — EN/HR flag toggle; re-renders dynamic surfaces on language change.
- `src/app/settings.js` — Discord presence + the Settings modal (tabs, feature switches, persisted in localStorage).
- `src/app/tasks.js` — per-project to-do list: sidebar-foot Tasks button (open-count badge) + Tasks modal (add/rename/complete/delete/clear-done), plus a "generate from a description" flow that may ask clarifying questions then has Claude draft the tasks (`generate_tasks` backend command; stored in the SQLite `tasks` table keyed by project path).
- `src/app/git.js` — git status line + branch picker (switch/create/fetch/pull/push).
- `src/app/links.js` — intercepts reply links; opens via browser / ask-each-time / in-app viewer.
- `src/app/logo.js` — RYSTAL wordmark per-letter split, logo intro + idle "living logo" glow.
- `src/app/usage.js` — Claude subscription usage (5h + weekly): scans local history via the `claude_usage` backend command, calibrate-once percentages, header chip + Settings tab + limit-warning tips.
- `src/app/boot.js` — entry point: runs the startup sequence (loads **last**).

## Language & communication
- When developing Krystal in this repo, **reply in English** (match the codebase and README).
- The app UI itself supports **EN + HR**.

## Conventions
- **Frontend stays vanilla JS** — no framework, no bundler. Preserve the single-exe simplicity.
- **Match the surrounding style**; keep dependencies minimal.
- Keep files cohesive as they are (the `claude.rs` / `commands.rs` / `db.rs` split on the Rust side; the per-concern `src/app/*.js` modules on the frontend). When adding UI, put it in the module that owns that concern rather than growing one file back into a monolith.
- Prefer **small, readable changes** over large refactors.

## i18n
- For **every new user-facing string, add both EN and HR** — never leave one locale behind.
- Keep **Croatian output gender-neutral**. Always use UTF-8 so č/ć/ž/š/đ are preserved exactly.

## Motion & animation
- **Every new feature/UI element should carry the app's clean, polished, *subtle* motion** where it's appropriate (opens/closes, hovers, state changes, transitions) — never ship a raw cut where a small animation fits.
- Match the established style: short durations (~.15–.35s), gentle spring/ease curves (e.g. `cubic-bezier(.2,.9,.3,1.25)`), small offsets — taste over flash. Reuse existing helpers/patterns (`replayClass`, `openOverlay`/`closeOverlay`, the `.panel-swap`/`.list-swap` crossfades, `prefers-reduced-motion` guards) rather than inventing new ones.
- **Always add a `@media (prefers-reduced-motion: reduce)` fallback** for any non-trivial animation.
- Default state should be the *resting* state: don't let an animation hook (e.g. an expandable panel) change an element's collapsed size/footprint when idle.
- **Restraint — don't go overboard.** Animate **one** thing calmly (usually a size/position slide), not a stack of properties at once. Never morph an element's **shape** (e.g. `border-radius` pill→box) *during* a size change — it reads as a weird springing/ellipse; let shape and width **snap** instead. Reserve springy/overshoot curves for tiny accents (a star pop), never for an open/close — use a plain `ease` there. When unsure, do less.

## Verification (before considering work done)
- Make sure it compiles: `cargo build`.
- Make sure `tauri build` succeeds.
- Add automated tests where it makes sense.

## Versioning & releases
- Suggest a release when appropriate, but **always wait for the maintainer's go-ahead** before cutting one.

## Current focus / next steps
- Generally the focus will always come from the user's messages and requests in chat sessions.
- Finish **generalizing the app for any project type** (writing/research/code/data).
- **Add features:**.
- **Polish UX for non-technical users.**
- **Naming migration:** the project is named **Krystal**. In-repo "kristina" mentions are renamed: identifier `com.krystal.claudecode`, DB `krystal.db` (with a first-launch migration from the old `com.kristina.claudecode/kristina.db` store), Cargo author, README. *(Remaining: rename the working folder `claude_kristina` → `claude_krystal` on disk — must be done with the app/session closed.)*

## Do this / avoid this
- ✅ Always provide EN + HR for new strings.
- ✅ Keep Croatian gender-neutral and UTF-8 clean.
- ✅ Verify with `cargo build` + `tauri build`.
- ✅ Keep changes small and in-style.
- ✅ Give new UI the app's subtle, polished motion (with a reduced-motion fallback) where appropriate.
- ❌ **Never restrict Claude to a curated toolset** — keep full tool freedom in the app.
- ❌ Don't introduce a frontend framework or bundler.
- ❌ Don't cut a release without explicit approval.