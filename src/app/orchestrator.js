/* orchestrator.js — Orchestrator mode: run a premium model as a supervisor that
   delegates the heavy lifting to cheaper worker sub-agents (via the Task tool),
   spending the expensive model's tokens on planning & synthesis, not grunt work.
   The button sits left of Compact; its popover picks the orchestrator model and
   the sub-agent model (or Auto — let the orchestrator choose a tier per task).
   Part of the chat frontend; shares one global scope (see core.js). */
/* ------------------------------ orchestrator ----------------------------- */

// Per-thread orchestrator settings, mirrored from the DB on open and written
// back on every change. `sub` is a model id or 'auto'.
let orchState = { enabled: false, sub: 'auto' };
let orchModelSel = null;
let orchSubSel = null;

/* Build (or rebuild) the popover contents — the on/off switch plus the two
 * pickers — from the cached model list, localizing every label. Rebuilding is
 * how a language switch re-translates it; selections are preserved. Called from
 * buildPickers() so it stays in lock-step with the model/mode pickers. */
function buildOrchestrator() {
  if (!els.orchPop) return;
  const curModel = orchModelSel ? orchModelSel.getValue()
    : (modelSel ? modelSel.getValue() : ((state.models[0] && state.models[0].id) || ''));

  els.orchPop.innerHTML =
    '<div class="orch-panel">' +
      '<div class="orch-head">' +
        `<div class="orch-title">⚡ <span>${escapeHtml(tr('orch.title'))}</span></div>` +
        `<button type="button" class="orch-switch" id="orch-switch" role="switch" aria-label="${escapeHtml(tr('orch.title'))}"><span class="orch-knob"></span></button>` +
      '</div>' +
      `<p class="orch-desc">${escapeHtml(tr('orch.desc'))}</p>` +
      '<div class="orch-fields" id="orch-fields">' +
        `<div class="orch-field"><div class="orch-field-label">${escapeHtml(tr('orch.modelLabel'))}</div><div class="picker" id="orch-model-picker"></div></div>` +
        `<div class="orch-field"><div class="orch-field-label">${escapeHtml(tr('orch.subLabel'))}</div><div class="picker" id="orch-sub-picker"></div></div>` +
        `<p class="orch-hint">${escapeHtml(tr('orch.hint'))}</p>` +
      '</div>' +
    '</div>';

  // Orchestrator model — the main session model, kept in sync with the header
  // model picker (both write the thread's `model`).
  orchModelSel = createPicker($('#orch-model-picker'), {
    tag: tr('model.tag'),
    up: true,
    items: state.models.map((m) => ({
      value: m.id, name: m.name, blurb: modelBlurb(m),
    })),
    value: curModel,
    onChange: async (v) => {
      if (!state.activeId) return;
      await api.setModel(state.activeId, v);
      if (modelSel) modelSel.set(v);          // keep the header picker in step
      updateUsage(state.lastUsage, { silent: true });   // re-scale meter to new window
    },
  });

  // Sub-agent model — Auto (orchestrator chooses a tier) or a fixed model.
  orchSubSel = createPicker($('#orch-sub-picker'), {
    tag: tr('orch.subTag'),
    up: true,
    items: [
      { value: 'auto', name: tr('orch.sub.auto'), blurb: tr('orch.sub.autoBlurb') },
      ...state.models.map((m) => ({
        value: m.id, name: m.name, blurb: modelBlurb(m),
      })),
    ],
    value: orchState.sub,
    onChange: async (v) => { orchState.sub = v; await persistOrch(); },
  });

  // Wire the on/off switch (rebuilt with the panel, so re-wired each time).
  const sw = $('#orch-switch');
  if (sw) sw.addEventListener('click', (e) => { e.stopPropagation(); toggleOrch(); });
  paintOrch();
}

/* Reflect current state onto the button, the switch, and the fields' enabled
 * look. Cheap and idempotent — safe to call after any change. */
function paintOrch() {
  els.orchBtn.classList.toggle('on', orchState.enabled);
  const sw = $('#orch-switch');
  if (sw) {
    sw.classList.toggle('on', orchState.enabled);
    sw.setAttribute('aria-checked', String(orchState.enabled));
  }
  const fields = $('#orch-fields');
  if (fields) fields.classList.toggle('off', !orchState.enabled);
}

async function persistOrch() {
  if (!state.activeId) return;
  try { await api.setOrchestration(state.activeId, orchState.enabled, orchState.sub); } catch {}
}

async function toggleOrch() {
  orchState.enabled = !orchState.enabled;
  paintOrch();
  await persistOrch();
}

// External hook: the header model picker changed → mirror it into the popover.
function orchReflectModel(v) { if (orchModelSel) orchModelSel.set(v); }

// Called from openThread: adopt this thread's saved orchestrator settings.
function syncOrchestratorThread(t) {
  orchState.enabled = !!(t && t.orch);
  orchState.sub = (t && t.orchSub) || 'auto';
  if (orchSubSel) orchSubSel.set(orchState.sub);
  if (orchModelSel) orchModelSel.set(t.model || (state.models[0] && state.models[0].id) || '');
  paintOrch();
}

/* ---- popover open / close (matches the picker-menu motion) ---- */
let orchCloseT = null;
function openOrchPop() {
  if (!els.orchPop.hidden) return;
  clearTimeout(orchCloseT);
  els.orchPop.hidden = false;
  els.orchWrap.classList.add('on');
  requestAnimationFrame(() => els.orchPop.classList.add('open'));
}
function closeOrchPop() {
  if (els.orchPop.hidden) return;
  els.orchWrap.classList.remove('on');
  els.orchPop.classList.remove('open');
  clearTimeout(orchCloseT);
  orchCloseT = setTimeout(() => { els.orchPop.hidden = true; }, 180);
}
const orchPopOpen = () => els.orchPop.classList.contains('open');

els.orchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  orchPopOpen() ? closeOrchPop() : openOrchPop();
});
// Clicks inside the wrap (button, pickers, switch) must never close the popover.
document.addEventListener('click', (e) => {
  if (els.orchWrap.contains(e.target)) return;
  closeOrchPop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOrchPop(); });
