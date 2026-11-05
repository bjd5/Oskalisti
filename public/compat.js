// Fallbacks for older browsers – mainly Safari before 15.4 (macOS 11 and older Macs), which
// lacks <dialog>, structuredClone and crypto.randomUUID. Loaded first by app.js.
// Modern browsers skip everything here.

// ---- <dialog>: showModal()/close()/open, Escape → "cancel", "close" event -------------
if (typeof window.HTMLDialogElement !== 'function' || !('showModal' in window.HTMLDialogElement.prototype)) {
  document.documentElement.classList.add('no-dialog');
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  const openDialogs = [];

  const sync = () => {
    backdrop.hidden = openDialogs.length === 0;
    document.body.classList.toggle('dialog-open', openDialogs.length > 0);
  };

  const upgrade = (dlg) => {
    if (dlg.showModal) return;
    Object.defineProperty(dlg, 'open', {
      configurable: true,
      get: () => dlg.hasAttribute('open'),
      set: (value) => (value ? dlg.setAttribute('open', '') : dlg.removeAttribute('open')),
    });
    dlg.showModal = () => {
      if (dlg.open) return;
      dlg.setAttribute('open', '');
      openDialogs.push(dlg);
      sync();
      const focusable = dlg.querySelector('[autofocus], input, select, textarea, button');
      focusable?.focus();
    };
    dlg.show = dlg.showModal;
    dlg.close = () => {
      if (!dlg.open) return;
      dlg.removeAttribute('open');
      openDialogs.splice(openDialogs.indexOf(dlg), 1);
      sync();
      dlg.dispatchEvent(new Event('close'));
    };
  };

  const init = () => {
    backdrop.hidden = true;
    document.body.append(backdrop);
    document.querySelectorAll('dialog').forEach(upgrade);
  };
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  document.addEventListener('keydown', (e) => {
    const top = openDialogs[openDialogs.length - 1];
    if (e.key !== 'Escape' || !top) return;
    const cancel = new Event('cancel', { cancelable: true });
    if (top.dispatchEvent(cancel)) top.close();
  });
  // A click on the dimmed area closes the top dialog the same way Escape does.
  backdrop.addEventListener('click', () => {
    const top = openDialogs[openDialogs.length - 1];
    if (top && top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
  });
}

// ---- structuredClone (plain JSON data only, which is all this app clones) -------------
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
}

// ---- crypto.randomUUID ----------------------------------------------------------------
if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = () => {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}
