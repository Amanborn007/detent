// curator annotation SDK — injected into the plan artifact iframe by the
// curator server. The artifact runs in a sandboxed iframe (allow-scripts
// allow-forms, no allow-same-origin), so this script never touches the
// network and never opens modals: everything goes to the parent chrome page
// via postMessage, and the parent prompts the user and talks to the server.
// Concept credit: lavish-axi by kunchenguid (MIT) — concepts only.
(function () {
  'use strict';

  // Pages carry an offline banner; only a page this script reached can send a decision.
  document.documentElement.dataset.curator = 'connected';

  function post(msg) {
    window.parent.postMessage(Object.assign({ curator: true }, msg), '*');
  }

  // --- robust CSS selector for an element -------------------------------
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + cssEscape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var tag = node.tagName.toLowerCase();
      var part = tag;
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  // --- (1) alt-click any element → annotate ------------------------------
  document.addEventListener(
    'click',
    function (e) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      var el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      post({ action: 'annotate-request', selector: cssPath(el), elementText: textOf(el) });
    },
    true
  );

  // --- (2) select text → floating "Annotate" button ----------------------
  var floatBtn = null;

  function hideFloat() {
    if (floatBtn && floatBtn.parentNode) floatBtn.parentNode.removeChild(floatBtn);
    floatBtn = null;
  }

  function containerElement(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node instanceof Element ? node : document.body;
  }

  document.addEventListener('mouseup', function (e) {
    if (floatBtn && (e.target === floatBtn || floatBtn.contains(e.target))) return;
    window.setTimeout(function () {
      var sel = window.getSelection();
      var text = sel ? String(sel).trim() : '';
      hideFloat();
      if (!sel || sel.isCollapsed || text === '') return;
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      var anchor = containerElement(sel.getRangeAt(0).commonAncestorContainer);
      floatBtn = document.createElement('button');
      floatBtn.type = 'button';
      floatBtn.textContent = 'Annotate';
      floatBtn.setAttribute('data-curator-ui', '');
      floatBtn.style.cssText =
        'position:fixed;z-index:2147483647;padding:4px 10px;font:600 12px -apple-system,system-ui,sans-serif;' +
        'background:var(--accent,#2563c9);color:#fff;border:0;border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'left:' + Math.max(4, Math.min(window.innerWidth - 90, rect.left + rect.width / 2 - 40)) + 'px;' +
        'top:' + Math.max(4, rect.top - 32) + 'px;';
      floatBtn.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // keep selection
      floatBtn.addEventListener('click', function () {
        post({ action: 'selection-request', selector: cssPath(anchor), selectedText: text.slice(0, 1000) });
        hideFloat();
        var s = window.getSelection();
        if (s) s.removeAllRanges();
      });
      document.body.appendChild(floatBtn);
    }, 0);
  });
  document.addEventListener('scroll', hideFloat, true);
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideFloat();
  });

  // --- (3) decision controls: data-plan-question / data-plan-option ------
  var CHOSEN = 'data-curator-chosen';
  var NOTE = 'data-curator-note'; // the free-text "why" field attached to a decision
  // Written to disk by the `answer` CLI verb, never by this SDK — the DRAFT
  // (CHOSEN) and the on-disk RECORD (ANSWERED) must never be conflated.
  var ANSWERED = 'data-curator-answered';
  var ANSWERED_NOTE = 'data-curator-answered-note';
  var ANSWERED_NOTE_TEXT = 'data-curator-answered-note-text'; // the rendered child, not the attribute carrier
  var ANSWERED_OPTION = 'data-curator-answered-option';
  var SENT = 'data-curator-sent'; // the shell has delivered this decision to the agent

  // Attach an optional free-text note field under a decision block, unless the
  // author already supplied one (any [data-curator-note] element inside it).
  function ensureNoteField(qEl) {
    if (qEl.querySelector('[' + NOTE + ']')) return;
    var field = document.createElement('div');
    field.setAttribute('data-curator-note-field', '');
    var label = document.createElement('label');
    label.setAttribute('data-curator-note-label', '');
    var ta = document.createElement('textarea');
    ta.setAttribute(NOTE, '');
    ta.setAttribute('rows', '2');
    ta.setAttribute('maxlength', '2000'); // keep the poll payload bounded
    ta.placeholder = 'Add the reasoning behind your choice…';
    field.appendChild(label);
    field.appendChild(ta);
    qEl.appendChild(field);
    updateNoteHint(qEl);
  }

  // The note is answerable on its own: none of the offered options may be the
  // answer, and disagreeing is a real reply rather than something to discard.
  function updateNoteHint(qEl) {
    var field = qEl.querySelector('[data-curator-note-field]');
    if (!field) return; // author-supplied note fields manage their own labelling
    var label = field.querySelector('[data-curator-note-label]');
    var hasAnswer = !!qEl.querySelector('[' + CHOSEN + ']') || qEl.hasAttribute(ANSWERED);
    field.setAttribute('data-curator-note-armed', '1');
    if (label) label.textContent = hasAnswer ? 'Why / note (optional)' : 'Why / note — or answer in your own words, no option needed';
  }

  // Restores the answered record at load: the DOM starts with only what the
  // `answer` verb stamped to disk, so the recorded note has to be lifted into
  // visible content here or a reload shows just the raw attribute.
  function renderAnswered(qEl) {
    var note = qEl.getAttribute(ANSWERED_NOTE);
    if (!note) return;
    // A distinct attribute from ANSWERED_NOTE: that one sits on the question
    // element, so styling it directly would italicise the whole block.
    var el = qEl.querySelector('[' + ANSWERED_NOTE_TEXT + ']');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute(ANSWERED_NOTE_TEXT, '');
      qEl.insertBefore(el, qEl.querySelector('[data-curator-note-field]'));
    }
    el.textContent = note; // untrusted: text content only, never HTML
  }

  function noteOf(qEl) {
    var t = qEl.querySelector('[' + NOTE + ']');
    return t ? String(t.value || '').trim() : '';
  }

  function chosenAnswer(qEl) {
    var o = qEl.querySelector('[' + CHOSEN + ']');
    return o ? o.getAttribute('data-plan-option') || textOf(o) : null;
  }

  // answer null carries a note-only reply; null with no note retracts it.
  function emitDecision(qEl, answer) {
    var msg = { action: 'decision', question: qEl.getAttribute('data-plan-question'), answer: answer };
    var note = noteOf(qEl);
    if (note) msg.note = note;
    post(msg);
  }

  function enhanceQuestion(qEl, n) {
    qEl.setAttribute('role', 'radiogroup');
    var head = qEl.querySelector('h2, h3, h4');
    if (head) {
      if (!head.id) head.id = 'curator-q-' + n;
      qEl.setAttribute('aria-labelledby', head.id);
    }
    var rec = qEl.getAttribute('data-plan-recommended');
    var reasonEl = qEl.querySelector('[data-plan-reason]');
    Array.prototype.forEach.call(qEl.querySelectorAll('[data-plan-option]'), function (o) {
      o.setAttribute('role', 'radio');
      o.setAttribute('tabindex', '0');
      o.setAttribute('aria-checked', 'false');
      if (!rec || o.getAttribute('data-plan-option') !== rec) return;
      var box = document.createElement('div');
      box.setAttribute('data-curator-rec', '');
      var tag = document.createElement('b');
      tag.textContent = 'Recommended';
      box.appendChild(tag);
      if (reasonEl) {
        var why = document.createElement('span');
        why.textContent = (reasonEl.textContent || '').replace(/\s+/g, ' ').trim().replace(/^recommended\s*:\s*/i, '');
        box.appendChild(why);
        reasonEl.setAttribute('data-curator-moved', '');
      }
      o.insertBefore(box, o.firstChild);
    });
    var none = qEl.getAttribute('data-plan-no-recommendation');
    if (none) {
      var p = document.createElement('p');
      p.setAttribute('data-curator-no-rec', '');
      p.textContent = 'No recommendation: ' + none;
      var firstOpt = qEl.querySelector('[data-plan-option]');
      if (firstOpt) firstOpt.parentNode.insertBefore(p, firstOpt);
      else qEl.appendChild(p);
    }
  }

  function initDecisions() {
    var style = document.createElement('style');
    var A = 'var(--accent,#2563c9)';
    var LINE = 'var(--line,rgba(128,128,128,.4))';
    var tint = function (pct) { return 'color-mix(in srgb,' + A + ' ' + pct + '%,transparent)'; };
    style.textContent =
      // The brief is the first thing read, so it is larger than body text and has its own box.
      '[data-plan-brief]{margin:0 0 24px;padding:18px 20px;border:1px solid ' + LINE + ';border-radius:12px;' +
      'background:var(--chip,rgba(128,128,128,.07));font-size:1.06em;line-height:1.55;}' +
      '[data-plan-brief] [data-brief]{margin:0 0 10px;}[data-plan-brief] [data-brief]:last-child{margin-bottom:0;}' +
      '[data-plan-brief] [data-brief] b{display:block;font:700 11px/1.3 -apple-system,system-ui,sans-serif;' +
      'letter-spacing:.08em;text-transform:uppercase;opacity:.68;}' +
      '[data-plan-brief] [data-brief="ask"]{font-weight:600;}' +
      // A decision is the one thing on the page that needs an action, so it reads
      // as a panel rather than as more prose. Options sit side by side as cards.
      '[data-plan-question]{position:relative;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));' +
      'gap:12px;margin:22px 0;padding:16px 18px 14px;border-radius:10px;' +
      'border:1px solid ' + tint(34) + ';border-left:4px solid var(--accent,#2563c9);background:' + tint(6) + ';}' +
      '[data-plan-question]>*{margin:0;}[data-plan-question]>:not([data-plan-option]){grid-column:1/-1;}' +
      '[data-plan-question]::before{content:"Decision needed";grid-column:1/-1;justify-self:start;' +
      'padding:3px 9px;border-radius:999px;background:' + tint(14) + ';color:' + A + ';' +
      'font:700 10px/1.35 -apple-system,system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;}' +
      '[data-plan-question][data-plan-required]::before{content:"Decision needed \\00b7  Required";}' +
      // Answered, nothing queued on top of it: the record is settled, so the
      // panel reads as settled rather than as still asking for a click.
      '[data-plan-question][' + ANSWERED + ']:not(:has([' + CHOSEN + '])){border-color:rgba(120,124,132,.32);' +
      'border-left-color:#8a8f98;background:rgba(120,124,132,.06);}' +
      '[data-plan-question][' + ANSWERED + ']:not(:has([' + CHOSEN + ']))::before{' +
      'content:"Answered: " attr(' + ANSWERED + ');background:rgba(120,124,132,.16);color:#5b6169;}' +
      // Queued over answered: must not read as either plain state, so the
      // badge text (not colour alone) says both halves are true at once.
      '[data-plan-question][' + ANSWERED + ']:has([' + CHOSEN + '])::before{' +
      'content:"Answered, new answer queued";background:rgba(217,119,6,.16);color:#b45309;}' +
      '[' + ANSWERED_NOTE_TEXT + ']{font-style:italic;opacity:.75;}' +
      '@media (prefers-color-scheme: dark){' +
      '[data-plan-question]{border-color:rgba(122,169,255,.42);border-left-color:var(--accent,#7aa9ff);background:rgba(122,169,255,.07);}' +
      '[data-plan-question]::before{background:rgba(122,169,255,.16);color:var(--accent,#9dc0ff);}' +
      '[data-plan-question][' + ANSWERED + ']:not(:has([' + CHOSEN + '])){border-color:rgba(148,152,160,.4);' +
      'border-left-color:#9298a2;background:rgba(148,152,160,.08);}' +
      '[data-plan-question][' + ANSWERED + ']:not(:has([' + CHOSEN + ']))::before{' +
      'background:rgba(148,152,160,.2);color:#c2c6cf;}' +
      '[data-plan-question][' + ANSWERED + ']:has([' + CHOSEN + '])::before{background:rgba(251,191,36,.2);color:#fbbf24;}' +
      '[data-plan-option]:hover{outline-color:var(--accent,#7aa9ff);}}' +
      // After the dark block and doubled: the answered rules, light and dark, weigh the same.
      '[data-plan-question][' + SENT + '][' + SENT + ']::before{content:"Sent — awaiting agent";' +
      'background:' + tint(14) + ';color:' + A + ';}' +
      '[data-plan-option]{cursor:pointer;display:flex;flex-direction:column;gap:6px;padding:12px 14px;' +
      'border:1px solid ' + LINE + ';border-radius:10px;background:var(--paper,transparent);' +
      'transition:outline-color .1s, box-shadow .1s;}' +
      '[data-plan-option]>*{margin:0;}[data-plan-option] strong{font-size:1.05em;}' +
      '[data-plan-then]{font-size:.9em;opacity:.75;}' +
      '[data-plan-option]:hover{outline:2px solid var(--accent,#2563c9);outline-offset:2px;}' +
      '[data-plan-option]:focus-visible{outline:3px solid var(--accent,#2563c9);outline-offset:2px;}' +
      '[' + CHOSEN + ']{outline:3px solid #2fa34f !important;outline-offset:2px;box-shadow:0 0 0 4px rgba(47,163,79,.18);}' +
      '[' + ANSWERED_OPTION + ']:not([' + CHOSEN + ']){outline:2px solid rgba(47,163,79,.55);outline-offset:2px;}' +
      '[data-curator-rec]{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;background:' + tint(10) + ';}' +
      '[data-curator-rec] b{font:700 10px/1.35 -apple-system,system-ui,sans-serif;letter-spacing:.09em;' +
      'text-transform:uppercase;color:' + A + ';}' +
      '[data-curator-moved]{display:none;}' +
      '[data-curator-note-field]{display:flex;flex-direction:column;gap:4px;}' +
      '[data-curator-note-label]{font:600 11px/1.3 -apple-system,system-ui,sans-serif;letter-spacing:.03em;text-transform:uppercase;opacity:.62;}' +
      '[' + NOTE + ']{width:100%;min-height:42px;resize:vertical;border:1px solid rgba(128,128,128,.45);border-radius:6px;' +
      'padding:6px 8px;font:13px/1.4 -apple-system,system-ui,sans-serif;background:rgba(128,128,128,.06);color:inherit;}' +
      '[' + NOTE + ']:focus{outline:2px solid ' + A + ';outline-offset:0;}' +
      'html[data-curator=connected] .curator-offline{display:none;}';
    (document.head || document.documentElement).appendChild(style);

    document.addEventListener('click', function (e) {
      if (e.altKey) return; // alt-click is annotation
      var el = e.target instanceof Element ? e.target.closest('[data-plan-option]') : null;
      if (!el) return;
      var qEl = el.closest('[data-plan-question]');
      if (!qEl) return;
      e.preventDefault();
      emitDecision(qEl, el.getAttribute('data-plan-option') || textOf(el));
    });

    // Enter or Space on a focused card chooses it, same as a click.
    document.addEventListener('keydown', function (e) {
      if (!(e.key === 'Enter' || e.key === ' ')) return;
      var el = e.target instanceof Element && e.target.hasAttribute('data-plan-option') ? e.target : null;
      var qEl = el && el.closest('[data-plan-question]');
      if (!qEl) return;
      e.preventDefault();
      emitDecision(qEl, el.getAttribute('data-plan-option') || textOf(el));
    });

    // Typing in a note keeps the queued decision in sync, with or without a
    // chosen option: the note alone is a valid answer.
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!(t instanceof Element) || !t.hasAttribute(NOTE)) return;
      var qEl = t.closest('[data-plan-question]');
      if (!qEl) return;
      emitDecision(qEl, chosenAnswer(qEl));
    });

    // Last, so a malformed block cannot stop the listeners above from attaching.
    Array.prototype.forEach.call(document.querySelectorAll('[data-plan-question]'), function (qEl, n) {
      enhanceQuestion(qEl, n);
      ensureNoteField(qEl);
      renderAnswered(qEl);
    });
  }

  function markChosen(question, answer) {
    var qEl = document.querySelector('[data-plan-question="' + cssEscape(question) + '"]');
    if (!qEl) return;
    var target = null;
    if (answer !== null) {
      Array.prototype.some.call(qEl.querySelectorAll('[data-plan-option]'), function (o) {
        if ((o.getAttribute('data-plan-option') || textOf(o)) === answer) {
          target = o;
          return true;
        }
        return false;
      });
    }
    var chosen = qEl.querySelectorAll('[' + CHOSEN + ']');
    // No-op when the selection is unchanged — avoids re-outlining (flicker) on
    // the idempotent decision-accepted echo that follows every note keystroke.
    if (!(chosen.length === 1 && chosen[0] === target && answer !== null)) {
      Array.prototype.forEach.call(chosen, function (o) {
        o.removeAttribute(CHOSEN);
      });
      if (target) target.setAttribute(CHOSEN, '');
    }
    Array.prototype.forEach.call(qEl.querySelectorAll('[data-plan-option]'), function (o) {
      o.setAttribute('aria-checked', o === target ? 'true' : 'false');
    });
    qEl.removeAttribute(SENT); // a new answer or a retraction is not sent yet
    updateNoteHint(qEl);
  }

  function markSent(question) {
    var qEl = document.querySelector('[data-plan-question="' + cssEscape(question) + '"]');
    if (qEl) qEl.setAttribute(SENT, '');
  }

  // Keeps the artifact's textarea in step when the note is edited from the queue,
  // so the two never disagree about what is about to be sent.
  function setNote(question, note) {
    var qEl = document.querySelector('[data-plan-question="' + cssEscape(question) + '"]');
    if (!qEl) return;
    var ta = qEl.querySelector('[' + NOTE + ']');
    if (ta) ta.value = note || '';
    updateNoteHint(qEl);
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.curator !== true) return;
    if (d.action === 'decision-accepted') markChosen(d.question, d.answer);
    else if (d.action === 'decision-cleared') {
      // The decision has left the queue, so the note goes with it: text left in
      // the box reads as queued and a later keystroke would resurrect it.
      setNote(d.question, '');
      markChosen(d.question, null);
    } else if (d.action === 'decision-sent') {
      markSent(d.question);
    } else if (d.action === 'note-set') setNote(d.question, d.note);
  });

  // --- (4) public API for custom artifact buttons ------------------------
  window.curator = {
    queuePrompt: function (text) {
      if (typeof text !== 'string' || text.trim() === '') return;
      post({ action: 'prompt', text: text.trim() });
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDecisions);
  } else {
    initDecisions();
  }
})();
