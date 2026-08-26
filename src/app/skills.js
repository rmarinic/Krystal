/* skills.js     — the `/` picker: run a Claude Code skill from the composer
   Part of the chat frontend; shares one global scope (see core.js).

   Claude Code has always taken `/skill-name` at the head of a message, and
   Krystal's chats have always passed it straight through — so skills already
   worked here. They were just invisible: nothing said they existed and nothing
   listed them. This is that list, in the one place it's useful — the composer.

   Type `/` at the start of a message and the picker opens; pick one and the
   message begins with it. Everything after it is yours to write as usual
   ("/code-review the login screen").

   Where the list comes from — two halves, because neither is complete:
     • The backend scans this project's and your `.claude/skills` and
       `.claude/commands` folders (`list_skills`), which is the only place a
       description can be read from.
     • The CLI names its *own* built-ins — /code-review, /run, /security-review —
       in the `system.init` event of every session, and they exist nowhere on
       disk. We learn those as chats run and remember them per project, so the
       picker is complete from the second session on and never empty in between.

   Skills belong to the project, like pins. */

/* ---------------------------- the known list ------------------------------ */

let fileSkills = [];      // scanned from disk (have descriptions)
let learnedSkills = [];   // names the CLI reported for this project

const skillState = { open: false, items: [], sel: 0 };

/* Commands that exist in the CLI but mean nothing here: Krystal has its own
 * buttons for them, or they only do something in a terminal. Listing them would
 * be offering the user a control that quietly does nothing. */
const SKILLS_HIDDEN = new Set([
  'clear', 'compact', 'model', 'config', 'effort', 'context', 'usage', 'agents',
  'mcp', 'color', 'fast', 'rename', 'autocompact', 'heapdump', 'doctor', 'import',
]);

function skillCacheKey() {
  return state.project ? `krystal.skills.${state.project.path}` : null;
}

/* A blurb for a built-in we recognise (localized), or whatever the file said. */
function skillBlurb(skill) {
  return tr('skillBlurb.' + skill.name, null, '') || skill.description || '';
}

/* The merged, ordered list. A scanned skill wins over a bare learned name — it
 * carries a description — and project-local ones stay ahead of the rest, which
 * is the order the backend already hands them to us in. */
function allSkills() {
  const seen = new Set();
  const out = [];
  for (const s of fileSkills) {
    if (SKILLS_HIDDEN.has(s.name) || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  const learned = learnedSkills
    .filter((n) => !SKILLS_HIDDEN.has(n) && !seen.has(n))
    .sort((a, b) => a.localeCompare(b));
  for (const name of learned) out.push({ name, description: '', source: 'claude' });
  return out;
}

/* Load this project's skills. Called when a project opens. */
async function refreshSkills() {
  if (!state.project) { fileSkills = []; learnedSkills = []; return; }
  try {
    const raw = localStorage.getItem(skillCacheKey());
    learnedSkills = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(learnedSkills)) learnedSkills = [];
  } catch { learnedSkills = []; }
  try {
    const r = await api.listSkills(state.project.path);
    fileSkills = (r && r.skills) || [];
  } catch { fileSkills = []; }
}

/* A session just started and told us what it can run. Remember it for this
 * project so the picker is complete before the next session exists. */
function learnSkills(names) {
  if (!Array.isArray(names) || !names.length) return;
  const merged = [...new Set(names.filter((n) => typeof n === 'string' && n))];
  if (merged.length === learnedSkills.length && merged.every((n) => learnedSkills.includes(n))) return;
  learnedSkills = merged;
  const key = skillCacheKey();
  if (key) { try { localStorage.setItem(key, JSON.stringify(merged)); } catch {} }
}

/* ----------------------------- query detect ------------------------------- */

/* The `/token` being typed, or null. A skill only counts at the *head* of the
 * message — that's the only place Claude Code reads one — so the slash has to be
 * the first non-space character of the whole box, not just of the current line.
 * Everything after the caret is ignored, so re-editing a slash you already typed
 * reopens the picker. */
function currentSkillQuery() {
  const el = els.input;
  if (document.activeElement !== el) return null;
  const before = el.value.slice(0, el.selectionStart);
  const m = /^\s*\/([A-Za-z0-9:_.-]*)$/.exec(before);
  return m ? { query: m[1] } : null;
}

function onComposerSlash() {
  if (isShellInput(els.input.value)) return closeSkillPop();   // `$` shell mode owns the line
  const q = currentSkillQuery();
  if (!q) return closeSkillPop();
  openSkillPop(q.query);
}

/* -------------------------------- popup ----------------------------------- */

function openSkillPop(query) {
  const q = (query || '').toLowerCase();
  let items = allSkills();
  if (q) {
    // Name matches first, then anything whose description mentions it — so a
    // half-remembered "/rev" finds code-review, and "/security" still finds it.
    const starts = items.filter((s) => s.name.toLowerCase().startsWith(q));
    const rest = items.filter(
      (s) => !starts.includes(s) &&
        (s.name.toLowerCase().includes(q) || skillBlurb(s).toLowerCase().includes(q))
    );
    items = starts.concat(rest);
  }
  skillState.items = items.slice(0, 8);
  skillState.sel = 0;
  skillState.open = true;
  renderSkillPop();
}

function renderSkillPop() {
  const pop = els.skillPop;
  if (!pop) return;
  if (!skillState.items.length) {
    pop.innerHTML = `<div class="mention-empty">${escapeHtml(tr('skill.none'))}</div>`;
    pop.hidden = false;
    replayClass(pop, 'mention-in');
    return;
  }
  pop.innerHTML = skillState.items.map((s, i) => {
    const blurb = skillBlurb(s);
    return `<button class="mention-item skill-item${i === skillState.sel ? ' sel' : ''}" data-i="${i}">` +
        `<span class="mention-hash" aria-hidden="true">/</span>` +
        `<span class="skill-text">` +
          `<span class="mention-title">${escapeHtml(s.name)}</span>` +
          (blurb ? `<span class="skill-blurb">${escapeHtml(blurb)}</span>` : '') +
        `</span>` +
      `</button>`;
  }).join('');
  pop.hidden = false;
  replayClass(pop, 'mention-in');
  // mousedown (not click) so picking an item doesn't blur the textarea first.
  pop.querySelectorAll('.skill-item').forEach((b) => {
    b.addEventListener('mousedown', (e) => { e.preventDefault(); chooseSkill(skillState.items[+b.dataset.i]); });
  });
}

function paintSkillSel() {
  if (!els.skillPop) return;
  els.skillPop.querySelectorAll('.skill-item').forEach((b, i) => {
    b.classList.toggle('sel', i === skillState.sel);
    if (i === skillState.sel) b.scrollIntoView({ block: 'nearest' });
  });
}

function closeSkillPop() {
  skillState.open = false;
  skillState.items = [];
  if (els.skillPop) { els.skillPop.hidden = true; els.skillPop.innerHTML = ''; }
}

/* Returns true when it consumed the key (so the composer's Enter-to-send bails). */
function skillKeydown(e) {
  if (!skillState.open) return false;
  if (e.key === 'Escape') { closeSkillPop(); e.preventDefault(); return true; }
  const n = skillState.items.length;
  if (!n) return false;                       // nothing matched — let Enter send as usual
  if (e.key === 'ArrowDown') { skillState.sel = (skillState.sel + 1) % n; paintSkillSel(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { skillState.sel = (skillState.sel - 1 + n) % n; paintSkillSel(); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { chooseSkill(skillState.items[skillState.sel]); e.preventDefault(); return true; }
  return false;
}

/* ------------------------------- selecting -------------------------------- */

/* Replace the half-typed `/query` with the real name and leave the caret after
 * it, ready for the rest of the sentence. */
function chooseSkill(skill) {
  if (!skill) return closeSkillPop();
  const el = els.input;
  const pos = el.selectionStart;
  const before = el.value.slice(0, pos);
  const after = el.value.slice(pos);
  const m = /^\s*\/([A-Za-z0-9:_.-]*)$/.exec(before);
  if (!m) return closeSkillPop();

  const insert = '/' + skill.name + ' ';
  el.value = insert + after;
  el.setSelectionRange(insert.length, insert.length);
  closeSkillPop();
  // Setting `.value` fires no input event, so the chat's draft would otherwise
  // remember the half-typed `/co` the user started with.
  if (typeof saveDraft === 'function') saveDraft(state.activeId, el.value);
  autosize();
  el.focus();
}

/* --------------------------------- wiring --------------------------------- */

// Close the popup when focus leaves the composer (after a tick so an item's
// mousedown still registers).
els.input.addEventListener('blur', () => { setTimeout(closeSkillPop, 120); });

// Blurbs are localized, so a language switch re-renders an open picker.
window.addEventListener('i18n:changed', () => { if (skillState.open) renderSkillPop(); });
