# Changelog

All notable changes to Krystal are listed here. The most recent version's notes
also appear in the in-app "update available" prompt, so keep them written for the
person clicking Install — plain language, what actually changed.

## v0.20.0
- **New: use Krystal from your phone.** A **📱 Phone** button now sits at the bottom of the chat list (and in Settings → Phone). Start it and you get an address plus a six-digit code; type the address into your phone's browser, enter the code, and your projects and conversations are right there — pick a chat, read the replies as they arrive, answer Claude's questions by tapping, and write new messages. Everything still runs on your computer: the phone is just a second window onto the same app, on the same Wi-Fi. Nothing goes to the internet.
- It's off until you switch it on, it shuts down when you close Krystal, and the code is new every time you start it — so nobody wanders in. The first time you start it Windows will ask whether to let Krystal through the firewall; say yes for private networks.
- **The two stay in step.** A message you send from the phone appears on the computer as it's being written — the same live reply, the same tool chips, the same Stop button — and a chat you start on the phone shows up in the list straight away. Come back to the phone and it catches up on whatever happened while you were away. A chat will only take one message at a time, so the two devices can't talk over each other.
- The phone page follows your phone's own language (English or Croatian) and is built for a touchscreen rather than being the desktop layout squeezed down.

## v0.19.0
- Run a skill straight from the message box: type `/` and pick one.
- A project can now reach folders outside its own — click the project path under the chat title to grant them.

## v0.18.0
- **New: pin files to the side of the chat.** Hover the right edge of a conversation and a slim rail slides open; the **+** lets you pin any file you want to keep an eye on — a task list, a brief, your notes. Click one and it opens in a light panel right over the chat, so you can check what a file actually says mid-conversation without leaving the chat or asking Claude to read it back to you. The file is read fresh every time you open it, so you always see the current version — handy for a task list Claude has just ticked something off.
- The rail is deliberately unobtrusive: it rests almost invisible and takes up no room, so it never competes with the conversation, and only comes forward when you point at it. Pinned files belong to the project, so they're waiting for you in every chat in that folder — and if you later point the project at a different folder, the pins come along.

## v0.17.0
- **Replies come back faster, and Claude keeps its train of thought.** Until now every message started a brand-new Claude process, which had to re-read the whole conversation from scratch before it could begin answering — a cost that grew with every message you exchanged. A chat now keeps one Claude running for as long as you're using it, so the second message and every one after it starts answering noticeably sooner, especially in long conversations.
- **Stopping a reply no longer throws the conversation away.** Stop used to kill Claude outright, and the next message had to rebuild everything. It now simply asks Claude to put the work down — the chat keeps its place and carries straight on.
- **New: an effort control, next to the model picker.** It sets how hard Claude thinks before it answers, from Low to Max, and it's remembered per chat. Everyday chats are fine on the default (High); turn it up for a genuinely hard problem and Claude will take longer and go deeper, or down for quick back-and-forth. This has been available to people using Claude Code in a terminal for a while — now it's a click.
- **A busy model no longer costs you the reply.** When Anthropic's servers are under load your chosen model can briefly become unavailable, which used to end the turn with an error. Krystal now quietly falls back to the next model so you still get your answer, and returns to your choice as soon as it can.
- **Very long conversations look after themselves.** Claude now tidies its own context when a conversation outgrows what it can hold, instead of you having to notice and press Compact. The Compact button is still there for when *you* want a clean slate.
- **New: a suggested next message.** After a reply, Krystal may offer a likely follow-up under the message box — click it to drop it in, or dismiss it. It shows up once a conversation is under way and only when Claude has a confident guess, so treat it as a bonus rather than something that's always there. You can switch it off in Settings → General.
- Orchestrator mode is faster and tidier: its helper agents are now described to Claude directly instead of being written as files into your personal Claude Code folder, which means nothing of Krystal's is left lying around there, and each orchestrated reply no longer starts from a cold cache.
- The Initialize wizard and the "generate tasks from a description" flow are more reliable — Claude is now held to the exact shape of answer they need, so they fail to understand the reply far less often.
- Under the hood, the instructions Krystal gives Claude were rewritten from one long run-on line into clear sections, which makes them easier for Claude to follow.

## v0.16.1
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
