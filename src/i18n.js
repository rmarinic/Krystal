/* i18n.js — tiny localization layer for Krystal.
 *
 * Loaded before app.js. Exposes window.I18N with:
 *   I18N.t(key, vars?, fallback?)  → translated string ({var} placeholders filled)
 *   I18N.setLang(lang)             → switch language, persist, re-translate static
 *                                    DOM, and dispatch the 'i18n:changed' event
 *   I18N.getLang()                 → current language code ('en' | 'hr')
 *   I18N.applyStatic(root?)        → translate elements carrying data-i18n* attrs
 *
 * Static text lives in the HTML via attributes:
 *   data-i18n="key"           → element.textContent
 *   data-i18n-html="key"      → element.innerHTML (when the string has markup)
 *   data-i18n-ph="key"        → element.placeholder
 *   data-i18n-title="key"     → element.title
 * Dynamic (JS-built) text calls I18N.t directly; app.js re-renders on change.
 */
(function () {
  const STORAGE_KEY = 'krystal.lang';
  const LANGS = ['en', 'hr'];

  const dict = {
    en: {
      /* ---- project picker ---- */
      'project.choose': 'Choose a project',
      'project.sub': 'Pick the folder Claude should work in. Each project keeps its own chats, model and history.',
      'project.initBtn': '✨ Initialize new project',
      'project.none': 'No projects yet. Click “✨ Initialize new project” to pick a folder.',
      'project.removeTitle': 'Remove project',
      'project.meta': '{n} {chats} · last used {when}',
      'project.removeConfirm': 'Remove project “{label}” and its {n} {chats}? This cannot be undone.',
      'word.chat.one': 'chat',
      'word.chat.many': 'chats',

      /* ---- sidebar / nav ---- */
      'nav.projectLabel': 'project',
      'nav.switchTitle': 'Switch project',
      'nav.newChat': '▸ new chat',
      'nav.newChatTitle': 'New chat',
      'search.placeholder': 'Search all chats…',
      'list.conversations': 'Conversations',
      'list.savedReplies': 'Saved replies',
      'list.searchResults': 'Search results',
      'saved.toggle': '★ Saved',
      'saved.toggleTitle': 'Show your saved replies',
      'sidebar.connecting': 'Connecting…',
      'sidebar.noChats': 'No chats yet. Tap “▸ new chat”.',
      'sidebar.noMatches': 'No matches.',
      'sidebar.noSaved': 'No saved replies yet. Star a reply with ★ to keep it here.',
      'sidebar.deleteTitle': 'Delete',
      'sidebar.deleteConfirm': 'Delete this conversation for good?',
      'result.saved': '★ saved',
      'result.you': 'you',
      'result.claude': 'claude',
      'result.in': 'in {title}',
      'result.chat': 'chat',

      /* ---- chat header / tools ---- */
      'header.noConversation': 'No conversation',
      'model.tag': 'model',
      'model.pickerTitle': 'Which Claude brain to use',
      'mode.tag': 'mode',
      'mode.pickerTitle': 'How much Claude may do on its own: Auto acts freely; Plan only researches and proposes',
      'init.editBtn': '✎ Edit instructions',
      'init.editBtnTitle': "Edit instructions: open this project's CLAUDE.md to edit it directly (or reinitialize from there)",
      'compact.btn': '🧹 Compact',
      'compact.btnTitle': 'Tidy up: keep a summary, drop the bulk — keeps Claude quick & sharp',
      'clear.btn': '🗑 Clear',
      'clear.btnTitle': 'Start fresh: Claude forgets this chat',

      /* ---- composer / empty ---- */
      'composer.placeholder': 'Message Claude…  (Enter to send, Shift+Enter for newline)',
      'empty.title': 'Start a conversation',
      'empty.body': 'This project is ready. Start a chat with “▸ new chat” in the sidebar, or open one from the list. Claude can read anything in the project folder automatically; to point it at a file elsewhere, paste its path in your message.',

      /* ---- usage meter ---- */
      'meter.used': '≈{ctx} of {win} used <span class="cost">· {cost} so far</span>',
      'meter.new': 'new chat <span class="cost">· {win} window</span>',

      /* ---- context tips ---- */
      'ctx.warnLabel': 'Heads up',
      'ctx.warnBody': 'This chat is getting long. The more it grows, the more Claude has to re-read every time — so replies can get slower and a little less focused. When you finish a topic, <strong>Compact</strong> tidies it up (it keeps a summary).',
      'ctx.compactNow': '🧹 Compact now',
      'ctx.gotIt': 'Got it',
      'ctx.highLabel': 'This chat is very long',
      'ctx.highBody': 'Claude is juggling a lot of history here, which makes answers slower and less sharp. <strong>Compact</strong> keeps the important bits and trims the rest; <strong>Clear</strong> starts fresh. Either one keeps things snappy.',
      'ctx.compact': '🧹 Compact',
      'ctx.clear': '🗑 Clear',
      'ctx.later': 'Later',

      /* ---- messages ---- */
      'msg.you': 'You',
      'msg.claude': 'Claude',
      'msg.saveReply': 'Save this reply',

      /* ---- clear / compact ---- */
      'clear.confirm': 'Start fresh? Claude will forget this conversation. (Your other chats stay.)',
      'clear.toastLabel': 'Fresh start',
      'clear.toastBody': 'Done — this chat is empty and Claude is starting clean.',
      'compact.tidying': '🧹 Tidying…',
      'compact.doneLabel': 'Tidied up',
      'compact.doneBody': 'I kept a summary of everything important and dropped the bulk. Replies should feel quick and sharp again — just keep chatting.',
      'compact.failLabel': 'Compact failed',

      /* ---- insight (hint) ---- */
      'hint.label': 'Insight',
      'hint.title': 'Ask Claude for a small insight on how to get even better results',
      'hint.looking': 'Looking…',
      'hint.allGood': "You're communicating clearly — nothing to change. Keep going!",

      /* ---- activity ---- */
      'activity.label': 'Activity',
      'activity.working': 'Working…',
      'activity.btnTitle': "Agents & shells: when Claude runs a command or launches a sub-agent, open this to watch what it's doing",
      'activity.panelTitle': '⚡ Agents & shells',
      'activity.close': 'Close',
      'activity.filter.all': 'All',
      'activity.filter.active': 'Active',
      'activity.filter.done': 'Done',
      'activity.empty': 'No shells or sub-agents have run in this chat yet.',
      'activity.emptyActive': 'No active shells or sub-agents.',
      'activity.emptyClosed': 'No closed shells or sub-agents.',
      'activity.kindShell': 'Shell',
      'activity.kindAgent': 'Sub-agent',
      'activity.state.running': 'running',
      'activity.state.done': 'done',
      'activity.state.error': 'error',
      'activity.noOutput': '(no output)',
      'activity.running': 'Running…',
      'activity.noCapture': '(no output captured)',

      /* ---- stream chips / tools ---- */
      'chip.thinking': 'Thinking…',
      'tool.Read': 'Reading a file',
      'tool.Write': 'Writing a file',
      'tool.Edit': 'Editing a file',
      'tool.Bash': 'Running a command',
      'tool.Glob': 'Finding files',
      'tool.Grep': 'Searching',
      'tool.WebSearch': 'Searching the web',
      'tool.WebFetch': 'Fetching a page',
      'tool.Task': 'Delegating to a subagent',
      'tool.TodoWrite': 'Planning',
      'tool.AskUserQuestion': 'Asking you a question',
      'tool.ExitPlanMode': 'Proposing a plan',
      'qa.title': 'Claude is asking you to choose',
      'qa.send': 'Send answer',
      'qa.answeredNote': 'Answer sent',
      'plan.title': 'Proposed plan',

      /* ---- folder picker / errors ---- */
      'dialog.chooseFolder': 'Choose a project folder',
      'dialog.pickerError': 'Could not open folder picker: {err}',

      /* ---- model blurbs (fall back to backend value if absent) ---- */
      'modelblurb.claude-opus-4-8': 'Smartest',
      'modelblurb.claude-sonnet-4-6': 'Balanced & fast',
      'modelblurb.claude-haiku-4-5-20251001': 'Quick & cheap',
      'modelblurb.claude-fable-5': 'Creative',
      /* ---- modes ---- */
      'mode.auto.name': 'Auto',
      'mode.auto.blurb': 'Reads, writes & runs on its own',
      'mode.plan.name': 'Plan',
      'mode.plan.blurb': 'Researches & proposes — no changes',

      /* ---- setup wizard / CLAUDE.md editor ---- */
      'wiz.title': '✨ Initial setup',
      'wiz.editTitle': '📝 Project instructions (CLAUDE.md)',
      'wiz.loadingClaude': 'Loading CLAUDE.md…',
      'wiz.close': 'Close',
      'wiz.retry': 'Try again',
      'wiz.cancel': 'Cancel',
      'wiz.save': 'Save',
      'wiz.saving': 'Saving…',
      'wiz.editNoteExists': 'These are the instructions Claude reads at the start of every conversation in this folder. Edit the text and save — the existing version is kept as a backup.',
      'wiz.editNoteNew': "There's no CLAUDE.md for this project yet. You can write one here and save it, or run the wizard to have Claude draft it for you.",
      'wiz.editPlaceholder': '# Project\n\nA short description of the project and rules for Claude…',
      'wiz.reinit': '↻ Reinitialize',
      'wiz.reinitTitle': 'Run the setup wizard from scratch',
      'wiz.reinitConfirm': 'Run the setup wizard from scratch? Your current CLAUDE.md stays until you save a new one.',
      'wiz.emptyLabel': 'Empty',
      'wiz.emptyBody': 'Type something before saving (or choose Reinitialize).',
      'wiz.savedLabel': 'Saved',
      'wiz.savedBodyEdit': '<strong>CLAUDE.md</strong> updated. Claude will read it at the start of every conversation.',
      'wiz.errorLabel': 'Error',
      'wiz.briefIntro': 'In short: what is this project about? What is in this folder and what is the goal? Claude will use it as a starting point before exploring the files. You can also leave this empty.',
      'wiz.briefPlaceholder': 'e.g. A book about the history of printing in Bjelovar — chapter outlines and sources are here…',
      'wiz.analyzeBtn': 'Review folder →',
      'wiz.analyzingTitle': 'Reviewing your folder…',
      'wiz.analyzingSub': 'Claude is reading the files and preparing questions about your project. This can take a minute.',
      'wiz.questionsIntro': 'Answer the questions below. You can pick a suggested answer or write your own. Everything can be edited later.',
      'wiz.questionCustom': 'Or write your own answer…',
      'wiz.writeBtn': 'Write CLAUDE.md →',
      'wiz.moreLabel': 'Just a bit more',
      'wiz.moreBody': 'Pick or type at least one answer before continuing.',
      'wiz.writingTitle': 'Writing CLAUDE.md…',
      'wiz.writingSub': 'Combining your answers into a project guide.',
      'wiz.reviewNote': "Here's the draft. Review and feel free to edit the text — it's saved as <strong>CLAUDE.md</strong> in the project folder and Claude will read it at the start of every conversation. Any existing CLAUDE.md is kept as a backup.",
      'wiz.backToQuestions': '‹ Back to questions',
      'wiz.rewrite': '↻ Rewrite',
      'wiz.acceptSave': 'Accept & save',
      'wiz.savedBodyAccept': 'Saved! <strong>CLAUDE.md</strong> is now in your folder. Claude will read it at the start of every conversation — you no longer need to repeat what it is about.',

      /* ---- self-update ---- */
      'update.title': 'A new version of Krystal is available',
      'update.version': 'v{current} → v{version}',
      'update.whatsNew': "What's new",
      'update.install': 'Install now',
      'update.later': 'Later',
      'update.preparing': 'Preparing…',
      'update.downloading': 'Downloading update…',
      'update.progress': '{done} MB of {total} MB · {pct}%',
      'update.progressNoTotal': '{done} MB downloaded…',
      'update.installing': 'Installing — Krystal will restart in a moment…',
      'update.restarting': 'Restarting…',
      'update.failed': 'Update failed: {err}',

      /* ---- language toggle ---- */
      'lang.toggleTitle': 'Switch language (English → Hrvatski)',
    },

    hr: {
      /* ---- project picker ---- */
      'project.choose': 'Odaberi projekt',
      'project.sub': 'Odaberi mapu u kojoj Claude radi. Svaki projekt ima svoje razgovore, model i povijest.',
      'project.initBtn': '✨ Pokreni novi projekt',
      'project.none': 'Još nema projekata. Klikni “✨ Pokreni novi projekt” da odabereš mapu.',
      'project.removeTitle': 'Ukloni projekt',
      'project.meta': '{n} {chats} · zadnje korišteno {when}',
      'project.removeConfirm': 'Ukloniti projekt “{label}” i njegovih {n} {chats}? Ovo se ne može poništiti.',
      'word.chat.one': 'razgovor',
      'word.chat.many': 'razgovora',

      /* ---- sidebar / nav ---- */
      'nav.projectLabel': 'projekt',
      'nav.switchTitle': 'Promijeni projekt',
      'nav.newChat': '▸ novi razgovor',
      'nav.newChatTitle': 'Novi razgovor',
      'search.placeholder': 'Pretraži razgovore…',
      'list.conversations': 'Razgovori',
      'list.savedReplies': 'Spremljeni odgovori',
      'list.searchResults': 'Rezultati pretrage',
      'saved.toggle': '★ Spremljeno',
      'saved.toggleTitle': 'Prikaži spremljene odgovore',
      'sidebar.connecting': 'Povezivanje…',
      'sidebar.noChats': 'Još nema razgovora. Klikni “▸ novi razgovor”.',
      'sidebar.noMatches': 'Nema rezultata.',
      'sidebar.noSaved': 'Još nema spremljenih odgovora. Označi odgovor sa ★ da ga zadržiš ovdje.',
      'sidebar.deleteTitle': 'Izbriši',
      'sidebar.deleteConfirm': 'Trajno izbrisati ovaj razgovor?',
      'result.saved': '★ spremljeno',
      'result.you': 'ti',
      'result.claude': 'claude',
      'result.in': 'u {title}',
      'result.chat': 'razgovor',

      /* ---- chat header / tools ---- */
      'header.noConversation': 'Nema razgovora',
      'model.tag': 'model',
      'model.pickerTitle': 'Koji Claude model koristiti',
      'mode.tag': 'način',
      'mode.pickerTitle': 'Koliko Claude smije sam: Auto radi slobodno; Plan samo istražuje i predlaže',
      'init.editBtn': '✎ Uredi upute',
      'init.editBtnTitle': 'Uredi upute: otvori CLAUDE.md ovog projekta i uredi ga izravno (ili pokreni postavljanje ispočetka)',
      'compact.btn': '🧹 Sažmi',
      'compact.btnTitle': 'Pospremi: zadrži sažetak, izbaci višak — Claude ostaje brz i bistar',
      'clear.btn': '🗑 Očisti',
      'clear.btnTitle': 'Počni iznova: Claude zaboravlja ovaj razgovor',

      /* ---- composer / empty ---- */
      'composer.placeholder': 'Poruka Claudeu…  (Enter za slanje, Shift+Enter za novi red)',
      'empty.title': 'Započni razgovor',
      'empty.body': 'Ovaj projekt je spreman. Pokreni razgovor s “▸ novi razgovor” u bočnoj traci ili otvori jedan s popisa. Claude može sam čitati sve u mapi projekta; da ga uputiš na datoteku drugdje, zalijepi njezinu putanju u poruku.',

      /* ---- usage meter ---- */
      'meter.used': '≈{ctx} od {win} iskorišteno <span class="cost">· {cost} dosad</span>',
      'meter.new': 'novi razgovor <span class="cost">· prozor {win}</span>',

      /* ---- context tips ---- */
      'ctx.warnLabel': 'Pažnja',
      'ctx.warnBody': 'Ovaj razgovor postaje dug. Što više raste, to Claude svaki put mora ponovno čitati više — pa odgovori mogu biti sporiji i malo manje fokusirani. Kad završiš temu, <strong>Sažmi</strong> ga pospremi (zadrži sažetak).',
      'ctx.compactNow': '🧹 Sažmi sada',
      'ctx.gotIt': 'U redu',
      'ctx.highLabel': 'Ovaj razgovor je vrlo dug',
      'ctx.highBody': 'Claude ovdje barata velikom poviješću, što čini odgovore sporijima i manje oštrima. <strong>Sažmi</strong> zadrži bitno i izreže ostatak; <strong>Očisti</strong> kreće iznova. Oboje vraća brzinu.',
      'ctx.compact': '🧹 Sažmi',
      'ctx.clear': '🗑 Očisti',
      'ctx.later': 'Kasnije',

      /* ---- messages ---- */
      'msg.you': 'Ti',
      'msg.claude': 'Claude',
      'msg.saveReply': 'Spremi ovaj odgovor',

      /* ---- clear / compact ---- */
      'clear.confirm': 'Početi iznova? Claude će zaboraviti ovaj razgovor. (Ostali razgovori ostaju.)',
      'clear.toastLabel': 'Novi početak',
      'clear.toastBody': 'Gotovo — ovaj razgovor je prazan i Claude kreće načisto.',
      'compact.tidying': '🧹 Sažimam…',
      'compact.doneLabel': 'Sažeto',
      'compact.doneBody': 'Zadržao sam sažetak svega važnog i izbacio višak. Odgovori bi opet trebali biti brzi i oštri — samo nastavi razgovor.',
      'compact.failLabel': 'Sažimanje nije uspjelo',

      /* ---- insight (hint) ---- */
      'hint.label': 'Uvid',
      'hint.title': 'Pitaj Claudea za mali savjet kako dobiti još bolje rezultate',
      'hint.looking': 'Tražim…',
      'hint.allGood': 'Jasno se izražavaš — nema se što mijenjati. Samo nastavi!',

      /* ---- activity ---- */
      'activity.label': 'Aktivnost',
      'activity.working': 'Radim…',
      'activity.btnTitle': 'Agenti i ljuske: kad Claude pokrene naredbu ili pod-agenta, otvori ovo da vidiš što radi',
      'activity.panelTitle': '⚡ Agenti i ljuske',
      'activity.close': 'Zatvori',
      'activity.filter.all': 'Sve',
      'activity.filter.active': 'Aktivni',
      'activity.filter.done': 'Gotovi',
      'activity.empty': 'U ovom razgovoru još nije pokrenuta nijedna ljuska ni pod-agent.',
      'activity.emptyActive': 'Nema aktivnih ljuski ni pod-agenata.',
      'activity.emptyClosed': 'Nema završenih ljuski ni pod-agenata.',
      'activity.kindShell': 'Ljuska',
      'activity.kindAgent': 'Pod-agent',
      'activity.state.running': 'u tijeku',
      'activity.state.done': 'gotovo',
      'activity.state.error': 'greška',
      'activity.noOutput': '(nema izlaza)',
      'activity.running': 'Izvodi se…',
      'activity.noCapture': '(izlaz nije zabilježen)',

      /* ---- stream chips / tools ---- */
      'chip.thinking': 'Razmišljam…',
      'tool.Read': 'Čitam datoteku',
      'tool.Write': 'Pišem datoteku',
      'tool.Edit': 'Uređujem datoteku',
      'tool.Bash': 'Izvodim naredbu',
      'tool.Glob': 'Tražim datoteke',
      'tool.Grep': 'Pretražujem',
      'tool.WebSearch': 'Pretražujem web',
      'tool.WebFetch': 'Dohvaćam stranicu',
      'tool.Task': 'Delegiram pod-agentu',
      'tool.TodoWrite': 'Planiram',
      'tool.AskUserQuestion': 'Postavlja ti pitanje',
      'tool.ExitPlanMode': 'Predlaže plan',
      'qa.title': 'Claude te traži da odabereš',
      'qa.send': 'Pošalji odgovor',
      'qa.answeredNote': 'Odgovor poslan',
      'plan.title': 'Predloženi plan',

      /* ---- folder picker / errors ---- */
      'dialog.chooseFolder': 'Odaberi mapu projekta',
      'dialog.pickerError': 'Nije moguće otvoriti odabir mape: {err}',

      /* ---- model blurbs ---- */
      'modelblurb.claude-opus-4-8': 'Najpametniji',
      'modelblurb.claude-sonnet-4-6': 'Uravnotežen i brz',
      'modelblurb.claude-haiku-4-5-20251001': 'Brz i jeftin',
      'modelblurb.claude-fable-5': 'Kreativan',
      /* ---- modes ---- */
      'mode.auto.name': 'Auto',
      'mode.auto.blurb': 'Čita, piše i izvodi sam',
      'mode.plan.name': 'Plan',
      'mode.plan.blurb': 'Istražuje i predlaže — bez promjena',

      /* ---- setup wizard / CLAUDE.md editor ---- */
      'wiz.title': '✨ Početno postavljanje',
      'wiz.editTitle': '📝 Upute za projekt (CLAUDE.md)',
      'wiz.loadingClaude': 'Učitavam CLAUDE.md…',
      'wiz.close': 'Zatvori',
      'wiz.retry': 'Pokušaj ponovno',
      'wiz.cancel': 'Odustani',
      'wiz.save': 'Spremi',
      'wiz.saving': 'Spremam…',
      'wiz.editNoteExists': 'Ovo su upute koje Claude čita na početku svakog razgovora u ovoj mapi. Uredi tekst i spremi — postojeća verzija čuva se kao kopija.',
      'wiz.editNoteNew': 'Za ovaj projekt još ne postoji CLAUDE.md. Možeš ga napisati ovdje i spremiti, ili pokrenuti čarobnjak da ga Claude sastavi za tebe.',
      'wiz.editPlaceholder': '# Projekt\n\nKratak opis projekta i pravila za Claudea…',
      'wiz.reinit': '↻ Reinitialize',
      'wiz.reinitTitle': 'Pokreni čarobnjak za postavljanje ispočetka',
      'wiz.reinitConfirm': 'Pokrenuti čarobnjak za postavljanje ispočetka? Trenutačni CLAUDE.md ostaje sve dok ne spremiš novi.',
      'wiz.emptyLabel': 'Prazno',
      'wiz.emptyBody': 'Upiši nešto prije spremanja (ili odaberi Reinitialize).',
      'wiz.savedLabel': 'Spremljeno',
      'wiz.savedBodyEdit': '<strong>CLAUDE.md</strong> je ažuriran. Claude će ga čitati na početku svakog razgovora.',
      'wiz.errorLabel': 'Greška',
      'wiz.briefIntro': 'Ukratko: o čemu je ovaj projekt? Što se nalazi u ovoj mapi i koji je cilj? Claude će to iskoristiti kao polazište prije nego pregleda datoteke. Polje možeš i ostaviti prazno.',
      'wiz.briefPlaceholder': 'npr. Knjiga o povijesti tiskarstva u Bjelovaru — ovdje su nacrti poglavlja i izvori…',
      'wiz.analyzeBtn': 'Pregledaj mapu →',
      'wiz.analyzingTitle': 'Pregledavam tvoju mapu…',
      'wiz.analyzingSub': 'Claude čita datoteke i sprema pitanja o tvom projektu. Ovo može potrajati minutu.',
      'wiz.questionsIntro': 'Odgovori na pitanja u nastavku. Možeš odabrati ponuđeni odgovor ili upisati svoj. Sve se kasnije može urediti.',
      'wiz.questionCustom': 'Ili upiši svoj odgovor…',
      'wiz.writeBtn': 'Napiši CLAUDE.md →',
      'wiz.moreLabel': 'Još malo',
      'wiz.moreBody': 'Odaberi ili upiši barem jedan odgovor prije nastavka.',
      'wiz.writingTitle': 'Pišem CLAUDE.md…',
      'wiz.writingSub': 'Spajam tvoje odgovore u vodič za projekt.',
      'wiz.reviewNote': 'Evo nacrta. Pregledaj i slobodno uredi tekst — sprema se kao <strong>CLAUDE.md</strong> u mapu projekta i Claude će ga čitati na početku svakog razgovora. Postojeći CLAUDE.md čuva se kao kopija.',
      'wiz.backToQuestions': '‹ Natrag na pitanja',
      'wiz.rewrite': '↻ Napiši ponovno',
      'wiz.acceptSave': 'Prihvati i spremi',
      'wiz.savedBodyAccept': 'Spremljeno! <strong>CLAUDE.md</strong> je sada u tvojoj mapi. Claude će ga čitati na početku svakog razgovora — ne moraš više ponavljati o čemu se radi.',

      /* ---- self-update ---- */
      'update.title': 'Dostupna je nova verzija Krystala',
      'update.version': 'v{current} → v{version}',
      'update.whatsNew': 'Novosti',
      'update.install': 'Instaliraj sada',
      'update.later': 'Kasnije',
      'update.preparing': 'Pripremam…',
      'update.downloading': 'Preuzimam ažuriranje…',
      'update.progress': '{done} MB od {total} MB · {pct}%',
      'update.progressNoTotal': '{done} MB preuzeto…',
      'update.installing': 'Instaliram — Krystal će se ponovno pokrenuti…',
      'update.restarting': 'Ponovno pokretanje…',
      'update.failed': 'Ažuriranje nije uspjelo: {err}',

      /* ---- language toggle ---- */
      'lang.toggleTitle': 'Promijeni jezik (Hrvatski → English)',
    },
  };

  let lang = 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.includes(saved)) lang = saved;
  } catch (_) {}

  function t(key, vars, fallback) {
    const table = dict[lang] || dict.en;
    let s = table[key];
    if (s == null) s = dict.en[key];
    if (s == null) s = (fallback != null ? fallback : key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    }
    return s;
  }

  function applyStatic(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) {
      if (next === lang) return;
      return;
    }
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    document.documentElement.lang = lang;
    applyStatic();
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
  }

  window.I18N = {
    t,
    setLang,
    getLang: () => lang,
    langs: () => LANGS.slice(),
    applyStatic,
  };

  // Translate the static DOM as soon as this script runs (defer ⇒ DOM parsed).
  document.documentElement.lang = lang;
  applyStatic();
})();
