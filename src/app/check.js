/* check.js      — "done means checked": the project's check, in the transcript
   Part of the chat frontend; shares one global scope (see core.js).

   A project can have a check command (tests, a build; set in the RUN panel,
   run.js). When a reply that changed files tries to finish, Claude Code's Stop
   hook runs it (src-tauri/src/check.rs); a failure goes back to Claude, who
   carries on and fixes it. Each run of the check is a segment of the reply, so
   the transcript keeps the story where it happened: "Check failed: npm test.
   Claude is fixing it", then "Checked: npm test passed".

   The chip is an action chip (chips.js) like any other: it opens onto the end
   of the check's output. While the check runs the working line says so
   (working.js `check` phase), because nothing else comes down the wire for as
   long as the tests take. The words are pure (`checkChipText`), tested in
   tests/check.test.js. */

/* What a check's chip says. `seg`: the hook's report (`check.rs` `report`). */
function checkChipText(seg) {
  const cmd = seg.command || '';
  if (seg.ok) {
    return { label: tr(seg.attempt > 1 ? 'check.passedAfter' : 'check.passed', { cmd, n: seg.attempt }), tone: 'ok' };
  }
  if (seg.timedOut) return { label: tr('check.timedOut', { cmd }), tone: 'warn' };
  if (seg.retrying) return { label: tr('check.failedFixing', { cmd }), tone: 'fail' };
  return { label: tr('check.gaveUp', { cmd }), tone: 'fail' };
}

/* The chip for one run of the check, live or on reload. */
function renderCheckChip(seg) {
  const t = checkChipText(seg);
  const el = document.createElement('div');
  el.className = 'action-chip expandable done check-chip ' + t.tone + (t.tone === 'fail' ? ' error' : '');
  if (seg.id) el.dataset.id = seg.id;
  el._seg = seg;
  const row = document.createElement('div');
  row.className = 'chip-row';
  row.title = tr('chip.expandTitle');
  const time = seg.ms ? fmtDur(seg.ms) : '';
  row.innerHTML =
    `<span class="chip-status" aria-hidden="true">${CHIP_TICK_SVG}</span>` +
    `<span class="chip-ico" aria-hidden="true">${icon(t.tone === 'ok' ? 'shield' : 'alert')}</span>` +
    `<span class="chip-label">${escapeHtml(t.label)}</span>` +
    `<span class="chip-time">${escapeHtml(time)}</span>` +
    '<span class="chip-caret" aria-hidden="true">▸</span>';
  el.appendChild(row);
  const details = document.createElement('div');
  details.className = 'chip-details';
  details.hidden = true;
  fillChipDetails(details, { name: '', output: seg.output || '', isError: t.tone !== 'ok' });
  el.appendChild(details);
  row.onclick = () => toggleChip(el);
  return el;
}
