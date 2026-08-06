# Changelog

All notable changes to Krystal are listed here. The most recent version's notes
also appear in the in-app "update available" prompt, so keep them written for the
person clicking Install — plain language, what actually changed.

## v0.16.0
- A project can now be pointed at a different folder. Moved or renamed the folder on disk? Hover the project on the picker screen and click 📁 to choose where it lives now — its chats, tasks and run command all come along, and the transcripts stay exactly as they are. Claude simply starts a fresh session in the new folder on your next message, which the confirmation tells you before anything changes.
- Fixed: a pasted screenshot followed you into whatever chat you opened next, and would ride along with the next message you sent there. Attachments now belong to the chat you queued them in — just like drafts — so they wait where you left them. The same fix applies to the `#`-referenced chats above the input.
- Fixed: an occasional reply where a set of choices arrived as a wall of raw code instead of clickable cards. If the card data is slightly malformed the app now repairs it and shows the cards anyway.
- The chat list now says when each conversation last saw activity — "Today · 14:23", "Yesterday · 09:10", "4 days ago" — instead of a bare clock time that told you nothing about which day it was. Today's chats read a touch brighter.

## v0.15.1
- Fixed the sub-agent window from v0.15.0: it never opened. Claude Code's delegation tool is called **Agent** and the new code was looking for the old name (`Task`), so sub-agent chips stayed ordinary chips — gear icon, the raw word "Agent", no live steps at all. Both names are recognised now, and if the CLI ever renames it again the chip repairs itself the moment the first progress arrives. Sub-agents also show up in the Activity panel again, and their chips carry the brief they were given plus a live step/token tally.
- The task list now keeps itself current on its own. When work in a chat finishes something on your list, Claude ticks it off as part of that reply; ask it to track something new and the task appears. A small note tells you what changed, and edits are no longer lost if you stop a reply half-way.
- Orchestrator mode got a serious tune-up: it was pointing the orchestrator at a delegation tool that no longer existed, and it insisted on delegating *every* action — even a single file read, each one booting a fresh sub-agent — which is what made simple requests crawl. Quick look-ups now stay with the orchestrator, only the heavy work is handed off, worker briefs are far more specific, workers can no longer spawn their own sub-agents (a turn could quietly become a tree of them), no more than a handful run at once, and in Plan mode workers are kept read-only so nothing stalls waiting for a permission prompt. Leftover worker files from a crashed run are cleaned up automatically.
- A worker's own commentary now streams through as it works, so the Activity panel and the sub-agent window show what it's doing rather than sitting blank until it finishes.

## v0.15.0
- Sub-agents now open in a window of their own. Click a sub-agent chip and you can follow exactly what it's doing, step by step, as it happens: every file it reads, every command it runs, everything it says — with its token count, step count and elapsed time on top, and the report it hands back at the end. You can stop it from in there too. Also reachable from Activity → Inspect.
- Scrolling up to re-read something while a reply is still coming in no longer drags you back down to the bottom. The moment you scroll up, following stops; scroll back to the bottom and it picks the newest text up again.
- Fixed buttons that quietly did nothing while a reply was being generated: **view summary** (after compacting), **Branch**, and **Edit instructions** / **Reinitialize** all work mid-reply now. Pasting or dropping a file mid-reply queues it for your next message instead of being ignored. **Compact** genuinely needs a settled chat, so it's now clearly greyed out with a tooltip rather than looking clickable.

## v0.14.3
- Fixed the model dropdown: opening it, only the top option was clickable — the other models were rendered behind the chat and swallowed clicks. All options are now selectable.
- The model list now stays current with the latest Claude models on its own — it refreshes live (when the window regains focus and hourly), so newly released models (e.g. Claude Opus 5) appear without restarting the app. Chats still pinned to a superseded model are moved to the current one automatically.

## v0.14.2
- Reworked the ambient chat glow into a soft green "backlight" that emanates from directly behind the message column, so the chat reads as lit from behind rather than a diffuse cloud. Still controlled by the **Extra effects** setting.

## v0.14.0
- Reply language now follows your latest message only — an English message is never answered in another language just because the project or interface is set to Croatian.
- Drafts: unsent messages are saved per chat and survive restarting the app; the sidebar marks any chat that has a pending draft.
- Click any attached image or preview thumbnail to view it full-size in a lightbox.
- Delete an individual message from a chat's transcript.
- Watch a delegated sub-agent work live inside its action chip while it runs.
- Renamed the "Living logo" setting to **Extra effects** and added a subtle glow behind the chat under it.
