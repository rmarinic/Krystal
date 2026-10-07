# Changelog

All notable changes to Krystal are listed here. The most recent version's notes
also appear in the in-app "update available" prompt, so keep them written for the
person clicking Install — plain language, what actually changed.

## v0.24.1
- **Fixed: first-run setup could sit on "Installing Claude Code…" forever.** The download is a couple of hundred megabytes and said nothing while it ran, so on a slower connection it looked frozen — and there was no way past it. Krystal now shows how much has been downloaded, and **Continue anyway** stays available the whole time.
- **Fixed: "Claude Code isn't installed" when it was.** Krystal only looked for it once, at launch, so installing it yourself while the app was open (or through winget) went unnoticed. It now looks again before saying so, and skips the install entirely if Claude Code is already there.

## v0.24.0
- **New: queue your next message while Claude is still working.** Until now a reply in progress left two choices: wait for it, or stop it. Now just type and press Enter — the message waits above the box and is sent the moment Claude finishes, so you can line up "and then do this" without watching the clock. Queue as many as you like; they go out one at a time, in the order you typed them, even if you've moved to another chat in the meantime.
- Each queued message can be pulled back into the box to change it (✎) or dropped (×), attachments and #-references included. While Claude is working, a small queue button appears next to Stop once you've typed something, and the chat list shows how many messages a chat has waiting.
- **Stopping holds the queue.** If you press Stop, or the reply fails, nothing queued is sent behind your back — it waits, marked "on hold", with a **Send now** button for when you're ready. Queued messages also survive closing Krystal, and come back on hold.
- Sending a message now clears the "Next:" suggestion left over from the reply before it.

## v0.22.1
- **Fixed: the model picker was stuck on an old list.** Claude Opus 5.5 came out and Krystal carried on offering Opus 5. The list isn't built into the app — Krystal asks Anthropic for it, so a new model turns up on its own — but it also remembers the last list it managed to fetch, and it was serving that one forever: the fetch had been quietly failing at every launch. Opus 5.5 is there now, and the chats you had on Opus 5 move across by themselves.
- Two things behind that: a remembered list is now only trusted for a week, after which the app falls back to the one it shipped with rather than a stale memory; and a fetch that doesn't get through is retried within seconds instead of an hour later. (It needs a sign-in that Claude Code only renews when it actually runs, so opening Krystal after a break was usually a moment too early — the first message of the session fixes that, and now Krystal notices.)

## v0.22.0
- **New: artifacts — what Claude builds, beside the conversation.** Ask for a page, a chart, a diagram or a one-page report and it arrives as a real thing you can look at, in a panel next to the chat, instead of a wall of code buried in the reply. Pages and drawings actually run, diagrams are drawn properly, and documents are set in the app's own reading style. Every artifact is self-contained, so **Save a copy** hands you a single file that works anywhere — offline, on someone else's computer, sent as an attachment — and **Open in browser** shows it full size.
- Artifacts belong to the project, so the **Artifacts** button at the foot of the chat list holds everything Claude has built in that folder, whichever conversation it came up in. Ask for a change and you get a new version rather than a replacement, and the arrows step back through them — one version per thing you asked for, not one per edit Claude made getting there.
- **Fixed: Remote said it was running, but nothing could connect.** Windows Firewall was dropping every connection from your phone before Krystal ever heard it — and since your own computer is never filtered, the address and the code both looked perfectly fine from here. Krystal now checks, says so plainly when it's blocked, and can fix it for you: press **Allow**, say yes to the Windows prompt, and your phone gets in. (Earlier versions counted on Windows asking you once, on its own. It doesn't always, and never for a Krystal you've since updated.)

## v0.21.1
- Fixed: pressing **Remote** on the project screen appeared to do nothing. The panel was opening, but *underneath* the project screen — so it only became visible after you'd picked a project and the screen got out of the way. Settings opened from that screen had the same problem. Both now open on top, where you can see them.

## v0.21.0
- **New: work on another computer's Krystal.** Remote access is no longer just for phones. Switch it on over there (Settings → Remote), then press **Remote** on this computer's project screen and type in the address and six-digit code it shows — and this window is working on that computer's projects: its chats, its folders, its files, with the replies arriving here as they're written. A bar across the top reminds you whose machine you're on, and Disconnect drops you back to your own. Addresses you've used are remembered, so the next time is a click.
- A few things stay on the computer in front of you, because they need to browse your own files: creating a project, changing a project's folder, adding a folder, pinning a file and dropping a file into the message box. Krystal tells you so instead of quietly failing. Pasting an image still works — that travels as data.
- The **📱 Phone** button is now simply **Remote**, since a phone is only one of the things that can connect. Phones and tablets work exactly as they did.
- **Stop now actually stops.** Pressing Stop asks Claude to put the work down, which is the polite thing to do — but a reply buried in a long tool run could take its time about noticing, or never notice, and pressing Stop again did nothing at all. A second press now ends it outright, and if the first press hasn't landed within a few seconds Krystal escalates on its own. Same on the phone, and in the sub-agent window.
- **Nothing is lost if Krystal closes mid-answer.** Your message used to be written down only once the whole reply had finished — so closing the app while Claude was still writing took both your question and the half-written answer with it, and coming back there was no trace of what had been going on. Your message is now saved the moment you send it, and the answer is saved as it's being written. Come back and the conversation is where you left it, with the unfinished reply marked as interrupted. Stopping a reply before Claude has said anything keeps your message now too, instead of dropping it.

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
