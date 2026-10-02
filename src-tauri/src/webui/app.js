/* app.js — the phone client for Krystal (served by src-tauri/src/server.rs).
 *
 * Deliberately small and self-contained: one file, no build step, no framework —
 * the same rules the desktop frontend plays by. It speaks the HTTP/SSE API in
 * server.rs, which fronts the very same backend commands the desktop window
 * calls, so a chat started on the phone and one started on the computer are the
 * same chat in the same database.
 *
 * Three screens, one at a time: projects → chats → conversation, plus a PIN gate
 * in front of all of them. The token the PIN buys is kept in localStorage so the
 * phone only pairs once per server run.
 */
(function () {
  'use strict';

  /* ------------------------------- i18n --------------------------------- */
  /* The phone picks its own language rather than inheriting the desktop's — it
   * is the phone's owner reading it. EN + HR, like the rest of Krystal. */

  const STRINGS = {
    en: {
      gateSub: 'Enter the code shown in Krystal on your computer.',
      connect: 'Connect', connecting: 'Connecting…',
      badPin: 'Wrong code — {n} tries left.',
      locked: 'Too many wrong codes. Restart phone access on the computer.',
      offline: 'Can’t reach Krystal. Is it still running on your computer?',
      projects: 'Projects', noProjects: 'No projects yet. Create one in Krystal on your computer.',
      chats: 'Chats', newChat: 'New', noChats: 'No chats yet — tap “New” to start one.',
      untitled: 'New chat', back: 'Back', stop: 'Stop',
      placeholder: 'Message Claude…',
      emptyChat: 'Say something to get started.',
      busy: 'This chat is already replying — try again in a moment.',
      sendFailed: 'Couldn’t send that. Check the connection and try again.',
      thinking: 'Thinking…',
      qaTitle: 'Claude needs a decision',
      qaPickOne: 'Pick one', qaPickMany: 'Pick any that apply',
      qaCustom: 'Or type your own answer…', qaSend: 'Send answer',
      chats_one: 'chat', chats_many: 'chats',
      turns_one: 'message', turns_many: 'messages',
      plan: 'Proposed plan',
      permRun: 'Claude wants to run a command',
      permEdit: 'Claude wants to edit a file',
      permWrite: 'Claude wants to write a file',
      permRead: 'Claude wants to read a file',
      permFetch: 'Claude wants to fetch a web page',
      permSearch: 'Claude wants to search the web',
      permTool: 'Claude wants to use {tool}',
      permAllow: 'Allow', permDeny: 'Deny',
      permAlways: 'Always allow',
      permAlwaysEdits: 'Allow all edits for now',
      permAlwaysRule: 'Don’t ask again for {rule}',
      permFailed: 'Couldn’t send that answer. Check the connection and try again.',
      tool: {
        Read: 'Reading a file', Write: 'Writing a file', Edit: 'Editing a file',
        MultiEdit: 'Editing a file', NotebookEdit: 'Editing a file',
        Bash: 'Running a command', Glob: 'Finding files', Grep: 'Searching',
        WebSearch: 'Searching the web', WebFetch: 'Fetching a page',
        Agent: 'Delegating to a subagent', Task: 'Delegating to a subagent',
        TodoWrite: 'Planning', AskUserQuestion: 'Asking you a question',
        ExitPlanMode: 'Proposing a plan',
      },
    },
    hr: {
      gateSub: 'Upiši kod prikazan u Krystalu na računalu.',
      connect: 'Poveži se', connecting: 'Povezivanje…',
      badPin: 'Pogrešan kod — još {n} pokušaja.',
      locked: 'Previše pogrešnih kodova. Ponovno pokreni pristup s mobitela na računalu.',
      offline: 'Krystal nije dostupan. Radi li još uvijek na računalu?',
      projects: 'Projekti', noProjects: 'Još nema projekata. Stvori ga u Krystalu na računalu.',
      chats: 'Razgovori', newChat: 'Novi', noChats: 'Još nema razgovora — dodirni „Novi” za početak.',
      untitled: 'Novi razgovor', back: 'Natrag', stop: 'Zaustavi',
      placeholder: 'Poruka Claudeu…',
      emptyChat: 'Napiši nešto za početak.',
      busy: 'Ovaj razgovor već odgovara — pokušaj za koji trenutak.',
      sendFailed: 'Slanje nije uspjelo. Provjeri vezu i pokušaj ponovno.',
      thinking: 'Razmišlja…',
      qaTitle: 'Claude treba odluku',
      qaPickOne: 'Odaberi jedno', qaPickMany: 'Odaberi sve što odgovara',
      qaCustom: 'Ili upiši vlastiti odgovor…', qaSend: 'Pošalji odgovor',
      chats_one: 'razgovor', chats_many: 'razgovora',
      turns_one: 'poruka', turns_many: 'poruka',
      plan: 'Predloženi plan',
      permRun: 'Claude želi pokrenuti naredbu',
      permEdit: 'Claude želi urediti datoteku',
      permWrite: 'Claude želi zapisati datoteku',
      permRead: 'Claude želi pročitati datoteku',
      permFetch: 'Claude želi dohvatiti web-stranicu',
      permSearch: 'Claude želi pretražiti web',
      permTool: 'Claude želi koristiti {tool}',
      permAllow: 'Dopusti', permDeny: 'Odbij',
      permAlways: 'Uvijek dopusti',
      permAlwaysEdits: 'Dopusti sva uređivanja zasad',
      permAlwaysRule: 'Ne pitaj više za {rule}',
      permFailed: 'Odgovor nije poslan. Provjeri vezu i pokušaj ponovno.',
      tool: {
        Read: 'Čitam datoteku', Write: 'Pišem datoteku', Edit: 'Uređujem datoteku',
        MultiEdit: 'Uređujem datoteku', NotebookEdit: 'Uređujem datoteku',
        Bash: 'Izvodim naredbu', Glob: 'Tražim datoteke', Grep: 'Pretražujem',
        WebSearch: 'Pretražujem web', WebFetch: 'Dohvaćam stranicu',
        Agent: 'Delegiram pod-agentu', Task: 'Delegiram pod-agentu',
        TodoWrite: 'Planiram', AskUserQuestion: 'Postavlja ti pitanje',
        ExitPlanMode: 'Predlaže plan',
      },
    },
  };

  const LANG = (navigator.language || 'en').toLowerCase().startsWith('hr') ? 'hr' : 'en';
  const S = STRINGS[LANG];
  const t = (key, vars) => {
    let out = S[key] != null ? S[key] : key;
    if (vars) for (const k in vars) out = out.split('{' + k + '}').join(vars[k]);
    return out;
  };
  const toolLabel = (name) => S.tool[name] || name || '';
  const plural = (n, key) => t(n === 1 ? key + '_one' : key + '_many');

  /* ------------------------------ elements ------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const els = {
    gate: $('#gate'), gateSub: $('#gate-sub'), gateErr: $('#gate-err'),
    pin: $('#pin-input'), pinGo: $('#pin-go'),
    projects: $('#projects'), projectList: $('#project-list'),
    threads: $('#threads'), threadList: $('#thread-list'),
    threadsTitle: $('#threads-title'), threadsBack: $('#threads-back'), newChat: $('#new-chat'),
    chat: $('#chat'), chatTitle: $('#chat-title'), chatBack: $('#chat-back'),
    feed: $('#feed'), composer: $('#composer'), input: $('#input'),
    send: $('#send'), stop: $('#stop-btn'),
    toast: $('#toast'),
  };

  /* ------------------------------- state --------------------------------- */

  const TOKEN_KEY = 'krystal.phone.token';
  const PROJECT_KEY = 'krystal.phone.project';

  const state = {
    token: null,
    project: null,      // { path, name, … }
    threadId: null,
    threadTitle: '',
    streaming: false,
    // A question card can be tapped while the turn that produced it is still
    // running, and nothing can be sent mid-turn — so the answer waits here and
    // goes out the moment the turn lands. The tap is never lost.
    pendingAnswer: null,
  };

  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (_) {}

  /* ------------------------------ utilities ------------------------------ */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderMarkdown(md) {
    const html = window.marked ? window.marked.parse(md || '') : escapeHtml(md);
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  }

  function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function show(screen) {
    for (const s of [els.gate, els.projects, els.threads, els.chat]) s.hidden = s !== screen;
  }

  function atBottom() {
    return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 120;
  }
  function toBottom() { els.feed.scrollTop = els.feed.scrollHeight; }

  /* --------------------------------- API --------------------------------- */

  async function apiFetch(path, options) {
    const opts = Object.assign({}, options);
    opts.headers = Object.assign(
      { 'content-type': 'application/json' },
      opts.headers,
      state.token ? { authorization: 'Bearer ' + state.token } : {}
    );
    const res = await fetch(path, opts);
    if (res.status === 401 && path !== '/api/auth') { forgetToken(); throw new Error('unauthorized'); }
    return res;
  }

  async function apiJson(path, options) {
    const res = await apiFetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { data, status: res.status });
    return data;
  }

  function forgetToken() {
    state.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    openGate();
  }

  /* ------------------------------- PIN gate ------------------------------ */

  function openGate() {
    els.gateSub.textContent = t('gateSub');
    els.pinGo.textContent = t('connect');
    els.pin.value = '';
    els.gateErr.hidden = true;
    show(els.gate);
    setTimeout(() => els.pin.focus(), 260);
  }

  async function submitPin() {
    const pin = els.pin.value.replace(/\D/g, '');
    if (pin.length < 6) return;
    els.pinGo.disabled = true;
    els.pinGo.textContent = t('connecting');
    els.gateErr.hidden = true;
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        state.token = data.token;
        try { localStorage.setItem(TOKEN_KEY, data.token); } catch (_) {}
        await enter();
        return;
      }
      els.gateErr.textContent = res.status === 429
        ? t('locked')
        : t('badPin', { n: data.attemptsLeft != null ? data.attemptsLeft : 0 });
      els.gateErr.hidden = false;
      els.pin.value = '';
    } catch (_) {
      els.gateErr.textContent = t('offline');
      els.gateErr.hidden = false;
    } finally {
      els.pinGo.disabled = false;
      els.pinGo.textContent = t('connect');
    }
  }

  els.pinGo.addEventListener('click', submitPin);
  els.pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
  // Six digits in is unambiguous — connect without making them reach for a button.
  els.pin.addEventListener('input', () => {
    els.pin.value = els.pin.value.replace(/\D/g, '').slice(0, 6);
    if (els.pin.value.length === 6) submitPin();
  });

  /* ------------------------------ projects ------------------------------- */

  async function openProjects() {
    els.threadsTitle.textContent = t('chats');
    show(els.projects);
    let projects = [];
    try { projects = (await apiJson('/api/projects')).projects || []; }
    catch (e) { if (e.message !== 'unauthorized') toast(t('offline')); return; }

    els.projectList.innerHTML = '';
    if (!projects.length) {
      els.projectList.innerHTML = '<div class="empty">' + escapeHtml(t('noProjects')) + '</div>';
      return;
    }
    for (const p of projects) {
      const n = p.chatCount || 0;
      const row = document.createElement('button');
      row.className = 'row';
      row.innerHTML =
        '<div class="row-name">' + escapeHtml(p.name || basename(p.path)) + '</div>' +
        '<div class="row-meta">' + escapeHtml(n + ' ' + plural(n, 'chats') + ' · ' + p.path) + '</div>';
      row.addEventListener('click', () => openThreads(p));
      els.projectList.appendChild(row);
    }
  }

  /* ------------------------------- threads ------------------------------- */

  async function openThreads(project) {
    state.project = project;
    try { localStorage.setItem(PROJECT_KEY, project.path); } catch (_) {}
    els.threadsTitle.textContent = project.name || basename(project.path);
    els.newChat.textContent = t('newChat');
    show(els.threads);

    let threads = [];
    try {
      const q = '/api/threads?project=' + encodeURIComponent(project.path);
      threads = (await apiJson(q)).threads || [];
    } catch (e) { if (e.message !== 'unauthorized') toast(t('offline')); return; }

    els.threadList.innerHTML = '';
    if (!threads.length) {
      els.threadList.innerHTML = '<div class="empty">' + escapeHtml(t('noChats')) + '</div>';
      return;
    }
    for (const th of threads) {
      const turns = (th.usage && th.usage.turns) || 0;
      const row = document.createElement('button');
      row.className = 'row';
      row.innerHTML =
        '<div class="row-name">' + escapeHtml(th.title || t('untitled')) + '</div>' +
        '<div class="row-meta">' + escapeHtml(turns + ' ' + plural(turns, 'turns') + ' · ' + when(th.updatedAt)) + '</div>';
      row.addEventListener('click', () => openChat(th.id, th.title));
      els.threadList.appendChild(row);
    }
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(LANG, { day: 'numeric', month: 'short' });
  }

  els.newChat.addEventListener('click', async () => {
    if (!state.project) return;
    try {
      const created = await apiJson('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ project: state.project.path }),
      });
      const th = created.thread || created;
      openChat(th.id, th.title);
    } catch (e) { if (e.message !== 'unauthorized') toast(t('offline')); }
  });

  els.threadsBack.addEventListener('click', openProjects);
  els.chatBack.addEventListener('click', () => openThreads(state.project));

  /* -------------------------------- chat --------------------------------- */

  async function openChat(id, title) {
    state.threadId = id;
    state.threadTitle = title || t('untitled');
    els.chatTitle.textContent = state.threadTitle;
    els.input.placeholder = t('placeholder');
    els.stop.textContent = t('stop');
    els.stop.hidden = !state.streaming;
    show(els.chat);
    els.feed.innerHTML = '';
    await loadMessages();
  }

  async function loadMessages() {
    let thread;
    try { thread = await apiJson('/api/thread?id=' + encodeURIComponent(state.threadId)); }
    catch (e) { if (e.message !== 'unauthorized') toast(t('offline')); return; }

    if (thread.title) {
      state.threadTitle = thread.title;
      els.chatTitle.textContent = thread.title;
    }
    els.feed.innerHTML = '';
    const messages = thread.messages || [];
    if (!messages.length) {
      els.feed.innerHTML = '<div class="empty">' + escapeHtml(t('emptyChat')) + '</div>';
      return;
    }
    for (const m of messages) els.feed.appendChild(renderMessage(m));
    toBottom();
  }

  function renderMessage(m) {
    if (m.role === 'user') {
      const el = document.createElement('div');
      el.className = 'msg user';
      el.textContent = m.text || '';
      return el;
    }
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const segs = Array.isArray(m.segments) && m.segments.length
      ? m.segments
      : [{ type: 'text', text: m.text || '' }];
    for (const seg of segs) {
      const node = renderSegment(seg);
      if (node) el.appendChild(node);
    }
    return el;
  }

  /* Persisted segment → DOM. Mirrors the desktop's renderSegments, minus the
   * expandable tool detail: on a phone the chips stay as one quiet line each. */
  function renderSegment(seg) {
    if (!seg) return null;
    if (seg.type === 'text') {
      const d = document.createElement('div');
      d.className = 'msg-body';
      d.innerHTML = renderMarkdown(seg.text || '');
      return d;
    }
    if (seg.type === 'shell') {
      const pre = document.createElement('pre');
      pre.className = 'msg-body';
      pre.textContent = '$ ' + (seg.command || '') + '\n' + (seg.output || '');
      return pre;
    }
    if (seg.type === 'tool') return renderToolSegment(seg, false);
    return null;
  }

  function renderToolSegment(seg, working) {
    if (seg.name === 'AskUserQuestion' && Array.isArray(seg.questions) && seg.questions.length) {
      return renderQuestionCard(seg);
    }
    if ((seg.name === 'ExitPlanMode' || seg.name === 'exit_plan_mode') && seg.plan) {
      const card = document.createElement('div');
      card.className = 'qa';
      card.innerHTML = '<div class="qa-title">' + escapeHtml(t('plan')) + '</div>' +
        '<div class="msg-body">' + renderMarkdown(seg.plan) + '</div>';
      return card;
    }
    return renderChip(seg, working);
  }

  function renderChip(seg, working) {
    const el = document.createElement('div');
    el.className = 'chip' + (working ? ' working' : '');
    if (seg.id) el.dataset.id = seg.id;
    el.dataset.tool = seg.name || '';
    el.innerHTML =
      '<span class="chip-dot" aria-hidden="true"></span>' +
      '<span class="chip-name">' + escapeHtml(toolLabel(seg.name)) + '</span>' +
      (seg.target ? '<span class="chip-target">' + escapeHtml(seg.target) + '</span>' : '');
    return el;
  }

  /* --------------------------- question cards ---------------------------- */
  /* Claude can't receive a tool answer in a headless session, so the pick is
   * sent as the next message — exactly what the desktop does. */

  function renderQuestionCard(seg) {
    const questions = seg.questions || [];
    const card = document.createElement('div');
    card.className = 'qa';

    const title = document.createElement('div');
    title.className = 'qa-title';
    title.textContent = '🗳️ ' + t('qaTitle');
    card.appendChild(title);

    const picked = questions.map(() => new Set());
    const customs = [];
    let sendBtn = null;

    const anyChosen = () =>
      picked.some((s) => s.size) || customs.some((c) => c && c.value.trim());
    const syncSend = () => {
      if (sendBtn) sendBtn.disabled = card.classList.contains('answered') || !anyChosen();
    };

    function submit() {
      if (card.classList.contains('answered') || !anyChosen()) return;
      const parts = [];
      questions.forEach((q, qi) => {
        const answers = [...picked[qi]];
        const custom = (customs[qi] && customs[qi].value.trim()) || '';
        if (custom) answers.push(custom);
        if (!answers.length) return;
        parts.push(questions.length === 1
          ? answers.join(', ')
          : (q.header || q.question) + ': ' + answers.join(', '));
      });
      const text = parts.join('\n');
      if (!text.trim()) return;
      card.classList.add('answered');
      syncSend();
      answer(text);
    }

    questions.forEach((q, qi) => {
      const multi = !!q.multiSelect;
      const block = document.createElement('div');
      block.className = 'qa-q ' + (multi ? 'multi' : 'single');
      let head = '';
      if (q.header) head += '<div class="qa-head">' + escapeHtml(q.header) + '</div>';
      if (q.question) head += '<div class="qa-text">' + escapeHtml(q.question) + '</div>';
      head += '<div class="qa-hint">' + escapeHtml(t(multi ? 'qaPickMany' : 'qaPickOne')) + '</div>';
      block.innerHTML = head;

      for (const opt of (q.options || [])) {
        const label = typeof opt === 'string' ? opt : (opt.label || '');
        const desc = typeof opt === 'string' ? '' : (opt.description || '');
        if (!label) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'qa-opt';
        b.innerHTML =
          '<span class="mark" aria-hidden="true"></span>' +
          '<span><span class="qa-opt-label">' + escapeHtml(label) + '</span>' +
          (desc ? '<span class="qa-opt-desc">' + escapeHtml(desc) + '</span>' : '') + '</span>';
        b.addEventListener('click', () => {
          if (card.classList.contains('answered')) return;
          if (multi && picked[qi].has(label)) {
            picked[qi].delete(label);
          } else {
            if (!multi) {
              picked[qi].clear();
              block.querySelectorAll('.qa-opt').forEach((x) => x.classList.remove('sel'));
            }
            picked[qi].add(label);
          }
          b.classList.toggle('sel', picked[qi].has(label));
          syncSend();
        });
        block.appendChild(b);
      }

      const custom = document.createElement('input');
      custom.type = 'text';
      custom.className = 'qa-custom';
      custom.placeholder = t('qaCustom');
      custom.addEventListener('input', syncSend);
      custom.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      customs[qi] = custom;
      block.appendChild(custom);
      card.appendChild(block);
    });

    sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn primary qa-send';
    sendBtn.textContent = t('qaSend');
    sendBtn.addEventListener('click', submit);
    card.appendChild(sendBtn);
    syncSend();
    return card;
  }

  /* -------------------------- permission prompts -------------------------- */
  /* Ask mode (set on the computer): the turn stops before changing or running
   * anything and asks. The question travels with the turn's events, so a turn
   * started here has to be answerable here — otherwise it would sit waiting for
   * somebody to walk over to the desktop. Same three answers as the window. */

  const PERM_TITLES = {
    Bash: 'permRun', Edit: 'permEdit', MultiEdit: 'permEdit', NotebookEdit: 'permEdit',
    Write: 'permWrite', Read: 'permRead', WebFetch: 'permFetch', WebSearch: 'permSearch',
  };

  function permToolName(tool) {
    const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
    return m ? m[2] + ' (' + m[1] + ')' : (tool || '');
  }

  /* What "always" would do, as the CLI proposed it (see claude.rs). */
  function permAlwaysLabel(msg) {
    const items = Array.isArray(msg.always) ? msg.always : [];
    if (!items.length) return null;
    if (items.some((a) => a.kind === 'mode' && a.text === 'acceptEdits')) return t('permAlwaysEdits');
    const rule = items.find((a) => a.kind === 'rule');
    if (rule) {
      const text = rule.text || permToolName(rule.tool);
      return t('permAlwaysRule', { rule: text.length > 30 ? text.slice(0, 29) + '…' : text });
    }
    return t('permAlways');
  }

  function renderPermissionCard(msg, threadId) {
    const card = document.createElement('div');
    card.className = 'qa perm';
    card.dataset.pid = msg.id;

    const title = document.createElement('div');
    title.className = 'qa-title';
    const key = PERM_TITLES[msg.tool];
    title.textContent = '🛡 ' + (key ? t(key) : t('permTool', { tool: permToolName(msg.tool) }));
    card.appendChild(title);

    // Exactly what is being agreed to: the command, or the file and its change.
    const edits = Array.isArray(msg.edits) ? msg.edits : [];
    const body = edits.length > 0 || msg.content != null;
    if (msg.detail) {
      const what = document.createElement(body ? 'div' : 'pre');
      what.className = body ? 'perm-path' : 'perm-what';
      what.textContent = (msg.tool === 'Bash' ? '$ ' : '') + msg.detail;
      card.appendChild(what);
    }
    if (body) {
      const pre = document.createElement('pre');
      pre.className = 'perm-what';
      if (edits.length) {
        for (const e of edits) {
          for (const [cls, sign, text] of [['del', '- ', e.old], ['add', '+ ', e.new]]) {
            if (!text) continue;
            for (const line of String(text).split('\n')) {
              const row = document.createElement('div');
              row.className = cls;
              row.textContent = sign + line;
              pre.appendChild(row);
            }
          }
        }
      } else {
        pre.textContent = msg.content;
      }
      card.appendChild(pre);
    }

    const acts = document.createElement('div');
    acts.className = 'perm-acts';
    const button = (cls, text, decision) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + cls;
      b.textContent = text;
      b.addEventListener('click', async () => {
        const all = [...acts.querySelectorAll('button')];
        all.forEach((x) => { x.disabled = true; });
        try {
          await apiJson('/api/invoke', {
            method: 'POST',
            body: JSON.stringify({
              cmd: 'answer_permission',
              args: { threadId: threadId, requestId: msg.id, decision: decision },
            }),
          });
          card.remove();   // the turn's own `permission_gone` would do it too
        } catch (e) {
          all.forEach((x) => { x.disabled = false; });
          if (e.message !== 'unauthorized') toast(t('permFailed'));
        }
      });
      acts.appendChild(b);
    };
    button('primary', t('permAllow'), 'allow');
    const always = permAlwaysLabel(msg);
    if (always) button('', always, 'always');
    button('', t('permDeny'), 'deny');
    card.appendChild(acts);
    return card;
  }

  /* ------------------------------ streaming ------------------------------ */
  /* A turn is streamed for liveness and then re-read from the database once it
   * lands, so what stays on screen is byte-identical to what the desktop shows
   * for the same turn — no second opinion about how a transcript looks. */

  function newLiveBubble() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    els.feed.appendChild(el);
    return el;
  }

  function makeLiveView(bubble) {
    let textEl = null;      // the open text block, if any
    let text = '';          // its accumulated markdown
    let chip = null;        // the most recent tool chip (for the two-event refine)
    let raf = null;

    const paint = () => {
      raf = null;
      if (textEl) textEl.innerHTML = renderMarkdown(text) + '<span class="caret"></span>';
    };
    const schedule = () => { if (raf == null) raf = requestAnimationFrame(paint); };

    return {
      thinking() {
        if (bubble.querySelector('.chip.thinking')) return;
        const el = document.createElement('div');
        el.className = 'chip working thinking';
        el.innerHTML = '<span class="chip-dot" aria-hidden="true"></span>' +
          '<span class="chip-name">' + escapeHtml(t('thinking')) + '</span>';
        bubble.appendChild(el);
      },
      clearThinking() {
        const el = bubble.querySelector('.chip.thinking');
        if (el) el.remove();
      },
      push(chunk) {
        this.clearThinking();
        if (!textEl) {
          textEl = document.createElement('div');
          textEl.className = 'msg-body';
          text = '';
          bubble.appendChild(textEl);
          chip = null;
        }
        text += chunk;
        schedule();
      },
      tool(seg) {
        this.clearThinking();
        const rich = seg.name === 'AskUserQuestion' || seg.name === 'ExitPlanMode';
        const card = rich ? renderToolSegment(seg, true) : null;
        if (card && !card.classList.contains('chip')) {
          // The detailed event carries the payload the first (name-only) event
          // lacked — swap the placeholder chip for the real card.
          if (chip && chip.dataset.tool === seg.name) { chip.remove(); }
          chip = null;
          textEl = null;
          bubble.appendChild(card);
          return;
        }
        const detailed = !!(seg.target || seg.detail);
        if (chip && chip.dataset.tool === (seg.name || '') && detailed && chip.dataset.detailed !== '1') {
          const next = renderChip(seg, true);
          next.dataset.detailed = '1';
          chip.replaceWith(next);
          chip = next;
          return;
        }
        if (chip) chip.classList.remove('working');
        textEl = null;
        chip = renderChip(seg, true);
        if (detailed) chip.dataset.detailed = '1';
        bubble.appendChild(chip);
      },
      toolResult(msg) {
        if (!msg || !msg.id) return;
        const el = bubble.querySelector('.chip[data-id="' + String(msg.id).replace(/"/g, '\\"') + '"]');
        if (el) el.classList.remove('working');
      },
      // Ask mode: the turn is stopped on a question. The card sits where the
      // turn has got to; whatever Claude says next starts below it.
      permission(msg, threadId) {
        if (!msg || !msg.id) return;
        this.clearThinking();
        if (textEl) textEl.innerHTML = renderMarkdown(text);   // close the open block, caret and all
        textEl = null;
        bubble.appendChild(renderPermissionCard(msg, threadId));
      },
      // Answered (here or on the computer) or withdrawn by a stop.
      permissionGone(id) {
        for (const el of bubble.querySelectorAll('.perm')) {
          if (el.dataset.pid === id) el.remove();
        }
      },
      error(message) {
        this.clearThinking();
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
        if (textEl) textEl.innerHTML = renderMarkdown(text);
        const el = document.createElement('div');
        el.className = 'msg-error';
        el.textContent = message;
        bubble.appendChild(el);
      },
      settle() {
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
        this.clearThinking();
        if (textEl) textEl.innerHTML = renderMarkdown(text);
        bubble.querySelectorAll('.perm').forEach((c) => c.remove());   // the turn is over: nothing left to answer
        bubble.querySelectorAll('.chip.working').forEach((c) => c.classList.remove('working'));
      },
    };
  }

  function setStreaming(on) {
    state.streaming = on;
    if (on) state.stopAsked = '';   // a new turn starts from the polite stop again
    els.stop.hidden = !on;
    // Send is off mid-turn, but the box stays live: you can be typing the next
    // message while Claude is still on this one.
    els.send.disabled = on;
  }

  /* Send an answer to a question card — now if the turn is over, otherwise the
   * instant it ends (see `state.pendingAnswer`). */
  function answer(text) {
    if (!text || !text.trim()) return;
    state.pendingAnswer = text.trim();
    flushAnswer();
  }
  function flushAnswer() {
    if (!state.pendingAnswer || state.streaming || !state.threadId) return;
    const text = state.pendingAnswer;
    state.pendingAnswer = null;
    sendMessage(text);
  }

  async function sendMessage(text) {
    const body = (text != null ? text : els.input.value).trim();
    if (!body || state.streaming || !state.threadId) return;
    const threadId = state.threadId;   // the view may move on mid-turn

    const empty = els.feed.querySelector('.empty');
    if (empty) empty.remove();

    if (text == null) { els.input.value = ''; autosize(); }

    const mine = document.createElement('div');
    mine.className = 'msg user';
    mine.textContent = body;
    els.feed.appendChild(mine);
    toBottom();

    const bubble = newLiveBubble();
    const view = makeLiveView(bubble);
    view.thinking();
    toBottom();

    setStreaming(true);

    let res;
    try {
      res = await apiFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ threadId: threadId, text: body }),
      });
    } catch (e) {
      setStreaming(false);
      if (e.message !== 'unauthorized') view.error(t('sendFailed'));
      return;
    }
    if (!res.ok || !res.body) {
      setStreaming(false);
      view.error(res.status === 409 ? t('busy') : t('sendFailed'));
      return;
    }

    await readStream(res, view, threadId);
    setStreaming(false);
    view.settle();
    // Only touch the feed if this chat is still the one on screen — a turn can
    // outlive the user's interest in watching it.
    if (state.threadId === threadId) {
      // The turn is on disk now; re-read it so the transcript matches the desktop's.
      await loadMessages();
      toBottom();
    }
    flushAnswer();   // a question card tapped mid-turn has been waiting for this
  }

  /* Read the SSE body frame by frame. `fetch` + a reader rather than
   * EventSource: EventSource can't carry the Authorization header. */
  async function readStream(res, view, threadId) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (_) { break; }                       // the link dropped
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!frame.startsWith('data: ')) continue;
        let msg;
        try { msg = JSON.parse(frame.slice(6)); } catch (_) { continue; }
        const follow = atBottom();
        handleEvent(msg, view, threadId);
        if (follow) toBottom();
      }
    }
  }

  function handleEvent(msg, view, threadId) {
    switch (msg.type) {
      case 'token': view.push(msg.text || ''); break;
      case 'tool': view.tool(msg); break;
      case 'tool_result': view.toolResult(msg); break;
      case 'permission': view.permission(msg, threadId); break;
      case 'permission_gone': view.permissionGone(msg.id); break;
      case 'title':
        // The first turn names the chat. Only rename the header if that chat is
        // still the one being looked at.
        if (msg.title && state.threadId === threadId) {
          state.threadTitle = msg.title;
          els.chatTitle.textContent = msg.title;
        }
        break;
      case 'error': view.error(msg.message || 'error'); break;
      default: break;   // done / end / the rest: the reload after the turn settles it
    }
  }

  /* ------------------------------- composer ------------------------------- */

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  els.input.addEventListener('input', autosize);

  els.composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

  // Two-step, like the window: the first press asks Claude to stop, a second one
  // kills the process — an interrupt deep inside a tool run can go unheard.
  els.stop.addEventListener('click', async () => {
    if (!state.threadId) return;
    const force = state.stopAsked === state.threadId;
    state.stopAsked = state.threadId;
    try {
      await apiJson('/api/stop', {
        method: 'POST',
        body: JSON.stringify({ threadId: state.threadId, force }),
      });
    } catch (_) {}
  });

  /* ------------------------- catching up on return ------------------------ */
  /* The desktop mirrors the phone's turns live; the reverse would mean holding a
   * socket open on a device that suspends it the moment the screen locks. So the
   * phone catches up instead: whenever you come back to it, whatever is on screen
   * is re-read. Cheap, and it covers both a reply typed on the computer and a
   * turn whose stream the phone slept through. */

  let catchUpTimer = null;
  function catchUp() {
    // Coming back to the tab fires both `visibilitychange` and `focus`; one
    // re-read is enough.
    clearTimeout(catchUpTimer);
    catchUpTimer = setTimeout(() => {
      if (document.hidden || state.streaming) return;
      if (!els.chat.hidden && state.threadId) loadMessages();
      else if (!els.threads.hidden && state.project) openThreads(state.project);
      else if (!els.projects.hidden) openProjects();
    }, 120);
  }

  document.addEventListener('visibilitychange', catchUp);
  window.addEventListener('focus', catchUp);

  /* --------------------------------- boot -------------------------------- */

  async function enter() {
    let ok = false;
    try { ok = !!(await apiJson('/api/hello')).ok; } catch (_) {}
    if (!ok) { openGate(); return; }

    // Straight back into the project this phone was last in, if it still exists.
    let last = null;
    try { last = localStorage.getItem(PROJECT_KEY); } catch (_) {}
    if (last) {
      try {
        const projects = (await apiJson('/api/projects')).projects || [];
        const match = projects.find((p) => p.path === last);
        if (match) { await openThreads(match); return; }
      } catch (_) {}
    }
    await openProjects();
  }

  if (state.token) enter(); else openGate();
})();
