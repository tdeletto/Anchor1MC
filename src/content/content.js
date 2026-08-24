/**
 * Runs in every page and frame. Three jobs:
 *   1. the bare-modifier hotkey (hold to talk, double-tap to toggle),
 *   2. the on-page recorder UI,
 *   3. putting the finished text into whatever field you were using.
 *
 * Content scripts cannot be ES modules, so the message names are repeated here
 * rather than imported. They mirror src/lib/messaging.js.
 */
(() => {
  // The worker injects this into tabs that were already open when the
  // extension loaded, which can race with the manifest's own injection on a
  // tab that reloads at the same moment. Running twice would double every
  // listener, so the second run stops here. The flag lives in the isolated
  // world, so a page cannot see or clear it.
  if (window.__anchor1mcLoaded) return;
  window.__anchor1mcLoaded = true;

  const MSG = {
    PING: 'ping',
    HOTKEY_DOWN: 'hotkey-down',
    HOTKEY_UP: 'hotkey-up',
    CANCEL: 'cancel',
    CONTENT_READY: 'content-ready',
    SHOW_RECORDER: 'show-recorder',
    UPDATE_RECORDER: 'update-recorder',
    HIDE_RECORDER: 'hide-recorder',
    INSERT_TEXT: 'insert-text',
    COLLECT_CONTEXT: 'collect-context',
  };

  const isTopFrame = window.top === window;

  let settings = null;
  /** 'idle' | 'holding' | 'pending-confirm' | 'toggle' */
  let hotkeyState = 'idle';
  let downAt = 0;
  let confirmTimer = null;
  /** The field to type into, remembered from before the hotkey was pressed. */
  let lastEditable = null;

  // ------------------------------------------------------------- settings --

  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    settings = stored.settings ?? null;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) settings = changes.settings.newValue;
  });

  const hotkeys = () => settings?.hotkeys ?? { modifierKey: 'AltRight', holdToTalk: true, doubleTapToggle: true, doubleTapWindowMs: 400, holdThresholdMs: 250, escapeCancels: true };
  const recordingMode = () => settings?.recording?.mode ?? 'both';
  const extensionEnabled = () => settings?.enabled !== false;

  const post = (type, payload = {}) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    } catch {
      // Extension context invalidated (reloaded/updated); nothing to do.
    }
  };

  // --------------------------------------------------------- editable field --

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      const typeable = ['text', 'search', 'url', 'email', 'tel', 'password', 'number', ''];
      return typeable.includes(type) && !el.disabled && !el.readOnly;
    }
    return false;
  }

  // Remember the field before the recorder appears, since some sites move focus.
  document.addEventListener('focusin', (e) => {
    if (isEditable(e.target)) lastEditable = e.target;
  }, true);

  function targetField() {
    const active = document.activeElement;
    if (isEditable(active)) return active;
    if (lastEditable?.isConnected && isEditable(lastEditable)) return lastEditable;
    return null;
  }

  // ---------------------------------------------------------------- hotkey --

  /** Does this event's code match the configured bare modifier? */
  function isHotkey(event) {
    const key = hotkeys().modifierKey;
    if (!key || key === 'none') return false;
    return event.code === key;
  }

  /**
   * A modifier press only counts when no *other* modifier is held with it.
   *
   * Each check ignores the family the pressed key itself belongs to, since
   * pressing Alt naturally sets altKey. Meta was previously checked
   * unconditionally, which meant Command could never be the hotkey on a Mac:
   * pressing it set metaKey and immediately disqualified itself.
   */
  function isCleanModifierPress(event) {
    const code = event.code ?? '';
    const others = [
      !code.startsWith('Alt') && event.altKey,
      !code.startsWith('Control') && event.ctrlKey,
      !code.startsWith('Shift') && event.shiftKey,
      !code.startsWith('Meta') && event.metaKey,
    ];
    return !others.some(Boolean);
  }

  function clearConfirm() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }

  function onKeyDown(event) {
    if (!extensionEnabled()) return;

    if (event.key === 'Escape' && hotkeyState !== 'idle' && hotkeys().escapeCancels) {
      clearConfirm();
      hotkeyState = 'idle';
      post(MSG.CANCEL);
      return;
    }

    if (!isHotkey(event) || event.repeat || !isCleanModifierPress(event)) return;

    const mode = recordingMode();

    // Already toggled on: this press stops it.
    if (hotkeyState === 'toggle') {
      hotkeyState = 'idle';
      post(MSG.HOTKEY_UP, { heldMs: Infinity });
      return;
    }

    // Second tap inside the window: keep recording, in toggle mode.
    if (hotkeyState === 'pending-confirm') {
      clearConfirm();
      hotkeyState = 'toggle';
      return;
    }

    if (mode === 'toggle') {
      // No push-to-talk: one press starts, the next stops.
      hotkeyState = 'toggle';
      post(MSG.HOTKEY_DOWN);
      return;
    }

    // Start capturing immediately, so the first syllable is not clipped. What
    // kind of press this was is decided on release.
    downAt = performance.now();
    hotkeyState = 'holding';
    post(MSG.HOTKEY_DOWN);
  }

  function onKeyUp(event) {
    if (!isHotkey(event) || hotkeyState !== 'holding') return;

    const held = performance.now() - downAt;
    const { holdThresholdMs, doubleTapToggle, doubleTapWindowMs } = hotkeys();
    const mode = recordingMode();

    if (held >= holdThresholdMs && mode !== 'toggle') {
      hotkeyState = 'idle';
      post(MSG.HOTKEY_UP, { heldMs: held });
      return;
    }

    // A tap. Either it becomes a toggle immediately, or we wait to see whether
    // a second tap confirms it — and cancel the recording if none arrives.
    if (!doubleTapToggle) {
      hotkeyState = 'toggle';
      return;
    }
    hotkeyState = 'pending-confirm';
    confirmTimer = setTimeout(() => {
      if (hotkeyState !== 'pending-confirm') return;
      hotkeyState = 'idle';
      post(MSG.CANCEL);
    }, doubleTapWindowMs);
  }

  // A dropped keyup (alt-tab, focus loss) would otherwise leave us recording.
  window.addEventListener('blur', () => {
    if (hotkeyState === 'holding') {
      hotkeyState = 'idle';
      post(MSG.HOTKEY_UP, { heldMs: performance.now() - downAt });
    }
  });

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // ------------------------------------------------------------ recorder UI --

  const RECORDER_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
      padding: 9px 14px; border-radius: 999px;
      font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: rgba(22, 22, 26, 0.94); color: #f4f4f5;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.34); backdrop-filter: blur(8px);
      pointer-events: none; user-select: none;
      transition: opacity 140ms ease, transform 140ms ease;
      opacity: 0; transform: translateY(6px);
    }
    .wrap.show { opacity: 1; transform: translateY(0); }
    .wrap.notch { border-radius: 0 0 16px 16px; padding: 10px 20px; }
    .bottom-center { bottom: 28px; left: 50%; transform: translate(-50%, 6px); }
    .bottom-center.show { transform: translate(-50%, 0); }
    .top-center { top: 0; left: 50%; transform: translate(-50%, -6px); }
    .top-center.show { transform: translate(-50%, 0); }
    .bottom-right { bottom: 24px; right: 24px; }
    .bottom-left { bottom: 24px; left: 24px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; flex: none;
           animation: pulse 1.1s ease-in-out infinite; }
    .dot.busy { background: #f5a524; animation-duration: 0.7s; }
    .dot.error { background: #e5484d; animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .bars { display: flex; align-items: center; gap: 2px; height: 18px; }
    .bar { width: 3px; min-height: 3px; border-radius: 2px; background: #a1a1aa; transition: height 70ms linear; }
    .timer { font-variant-numeric: tabular-nums; color: #a1a1aa; font-size: 12px; }
    .label { max-width: 42ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .partial { color: #d4d4d8; font-weight: 400; max-width: 46ch;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { color: #71717a; font-size: 11px; }
    .profile { color: #d4d4d8; font-size: 11px; }
    @media (prefers-color-scheme: light) {
      .wrap { background: rgba(255, 255, 255, 0.96); color: #18181b; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16); }
      .bar { background: #71717a; }
      .timer, .hint { color: #52525b; }
      .partial { color: #3f3f46; }
      .profile { color: #52525b; }
    }
  `;

  const BAR_COUNT = 14;
  let host = null;
  let ui = null;
  let timerHandle = null;
  let startedAt = 0;

  function buildRecorder(uiSettings, profileName) {
    if (!isTopFrame) return;
    destroyRecorder();

    host = document.createElement('div');
    host.setAttribute('data-anchor1mc', '');
    // Shadow DOM so no page stylesheet can reach in and break the pill.
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = RECORDER_CSS;

    const wrap = document.createElement('div');
    const position = uiSettings.recorderStyle === 'notch' ? 'top-center' : (uiSettings.position ?? 'bottom-center');
    wrap.className = `wrap ${position}${uiSettings.recorderStyle === 'notch' ? ' notch' : ''}`;

    const dot = document.createElement('div');
    dot.className = 'dot';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Listening';

    const bars = document.createElement('div');
    bars.className = 'bars';
    const barEls = [];
    if (uiSettings.showWaveform) {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = '3px';
        bars.append(bar);
        barEls.push(bar);
      }
    }

    const timer = document.createElement('div');
    timer.className = 'timer';
    timer.textContent = '0:00';

    const partial = document.createElement('div');
    partial.className = 'partial';

    const profile = document.createElement('div');
    profile.className = 'profile';
    if (profileName) profile.textContent = profileName;

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Esc to cancel';

    wrap.append(dot, label);
    if (uiSettings.showWaveform) wrap.append(bars);
    if (uiSettings.showTimer) wrap.append(timer);
    wrap.append(partial);
    if (profileName) wrap.append(profile);
    wrap.append(hint);
    root.append(style, wrap);
    (document.body ?? document.documentElement).append(host);

    ui = { wrap, dot, label, barEls, timer, partial, uiSettings };
    startedAt = performance.now();
    requestAnimationFrame(() => wrap.classList.add('show'));

    if (uiSettings.showTimer) {
      timerHandle = setInterval(() => {
        const s = Math.floor((performance.now() - startedAt) / 1000);
        timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 250);
    }
  }

  function updateRecorder(payload) {
    if (!ui) return;
    const { state, level, partial, error, progress } = payload;

    if (typeof level === 'number' && ui.barEls.length) {
      // Shift the history left and push the newest level on the right.
      for (let i = 0; i < ui.barEls.length - 1; i += 1) {
        ui.barEls[i].style.height = ui.barEls[i + 1].style.height;
      }
      const height = Math.max(3, Math.min(18, Math.round(level * 90)));
      ui.barEls.at(-1).style.height = `${height}px`;
    }

    if (state === 'transcribing') { ui.label.textContent = 'Transcribing'; ui.dot.className = 'dot busy'; }
    if (state === 'enhancing') { ui.label.textContent = 'Enhancing'; ui.dot.className = 'dot busy'; }
    if (state === 'inserting') { ui.label.textContent = 'Inserting'; ui.dot.className = 'dot busy'; }
    if (state === 'recording') { ui.label.textContent = 'Listening'; ui.dot.className = 'dot'; }
    if (state === 'error' || error) {
      ui.label.textContent = error ?? 'Something went wrong';
      ui.dot.className = 'dot error';
    }

    if (progress?.message) ui.label.textContent = progress.total
      ? `${progress.message} ${Math.round((progress.loaded / progress.total) * 100)}%`
      : progress.message;

    if (partial && ui.uiSettings.showPartials) ui.partial.textContent = partial;
  }

  function destroyRecorder(delayMs = 0) {
    clearInterval(timerHandle);
    timerHandle = null;
    const doomed = host;
    const wrap = ui?.wrap;
    host = null;
    ui = null;
    if (!doomed) return;
    const remove = () => {
      wrap?.classList.remove('show');
      setTimeout(() => doomed.remove(), 160);
    };
    if (delayMs) setTimeout(remove, delayMs);
    else remove();
  }

  // ------------------------------------------------------------- insertion --

  /**
   * Type text into the focused field.
   *
   * execCommand('insertText') is deprecated but remains the only way to insert
   * text that React, Slate, ProseMirror, CodeMirror, and friends all treat as
   * real user input. The native-setter path is the fallback for the rare field
   * where it is refused.
   */
  function insertText(field, text) {
    field.focus({ preventScroll: true });

    if (document.execCommand('insertText', false, text)) return true;

    if (field.isContentEditable) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return false;
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }

    // Go through the prototype setter so frameworks see the change.
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    setter.call(field, field.value.slice(0, start) + text + field.value.slice(end));
    field.selectionStart = field.selectionEnd = start + text.length;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Best-effort "send": what most chat and search inputs listen for. */
  function pressEnter(field) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const accepted = field.dispatchEvent(new KeyboardEvent('keydown', init));
    field.dispatchEvent(new KeyboardEvent('keypress', init));
    field.dispatchEvent(new KeyboardEvent('keyup', init));
    // Nothing intercepted the key, so fall back to submitting the form.
    if (accepted && field.form?.requestSubmit) {
      try { field.form.requestSubmit(); } catch { /* no submit button */ }
    }
  }

  // --------------------------------------------------------------- context --

  function fieldDescription(field) {
    if (!field) return null;
    const labelled = field.labels?.[0]?.textContent;
    return (
      labelled
      || field.getAttribute('aria-label')
      || field.getAttribute('placeholder')
      || field.getAttribute('name')
      || field.getAttribute('id')
      || null
    )?.trim().slice(0, 120) ?? null;
  }

  function collectContext(capture) {
    const field = targetField();
    const context = {};
    if (capture.url) context.url = location.href;
    if (capture.title) context.title = document.title;
    if (capture.fieldLabel) context.fieldLabel = fieldDescription(field);
    if (capture.selection) {
      const selected = window.getSelection()?.toString()?.trim();
      if (selected) context.selection = selected.slice(0, capture.maxChars ?? 2000);
    }
    if (capture.pageText) {
      // Only what is near the field, not the whole document.
      const scope = field?.closest('form, main, article, section') ?? document.body;
      context.pageText = (scope?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, capture.maxChars ?? 2000);
    }
    return context;
  }

  // -------------------------------------------------------------- messages --

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case MSG.PING:
        // Lets the settings page report whether a tab can actually be typed
        // into, which is otherwise invisible until a hotkey silently does
        // nothing.
        sendResponse({ ok: true, top: window.top === window, url: location.href });
        return false;

      case MSG.SHOW_RECORDER:
        buildRecorder(message.ui, message.profileName);
        return false;

      case MSG.UPDATE_RECORDER:
        updateRecorder(message);
        return false;

      case MSG.HIDE_RECORDER:
        if (message.error) {
          updateRecorder({ error: message.error });
          destroyRecorder(2600);
        } else {
          destroyRecorder();
        }
        hotkeyState = 'idle';
        clearConfirm();
        return false;

      case MSG.COLLECT_CONTEXT:
        sendResponse(collectContext(message.capture ?? {}));
        return false;

      case MSG.INSERT_TEXT: {
        const field = targetField();
        // Frames with nothing to type into stay silent so the frame that does
        // have the field gets to answer.
        if (!field) return false;
        const run = () => {
          const text = message.addTrailingSpace ? `${message.text} ` : message.text;
          const ok = insertText(field, text);
          if (ok && message.autoSend) pressEnter(field);
          sendResponse({ ok });
        };
        if (message.delayMs > 0) setTimeout(run, message.delayMs);
        else run();
        return true;
      }

      default:
        return false;
    }
  });

  loadSettings().then(() => post(MSG.CONTENT_READY));
})();
