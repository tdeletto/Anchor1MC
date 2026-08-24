/**
 * Key naming across platforms.
 *
 * The hotkey is matched on `event.code`, which is physical rather than logical:
 * the key to the right of the space bar reports `AltRight` whether it is
 * engraved Alt on a Chromebook or Option on a Mac. So the default works on both
 * without any branching — but the *label* has to change, because nobody looking
 * at a Mac keyboard is hunting for a key marked Alt.
 */

export const isMac = (() => {
  const platform = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '';
  return /mac/i.test(platform);
})();

/** Offered as bare-modifier hotkeys, in the order they should be listed. */
export const MODIFIER_KEYS = [
  { code: 'AltRight', mac: 'Right Option (⌥)', other: 'Right Alt' },
  { code: 'AltLeft', mac: 'Left Option (⌥)', other: 'Left Alt' },
  { code: 'ControlRight', mac: 'Right Control (⌃)', other: 'Right Ctrl' },
  { code: 'ControlLeft', mac: 'Left Control (⌃)', other: 'Left Ctrl' },
  { code: 'ShiftRight', mac: 'Right Shift (⇧)', other: 'Right Shift' },
  // Meta is Command on a Mac and the Search/Launcher key on a Chromebook, which
  // ChromeOS claims for itself — so it is worth offering, but not by default.
  { code: 'MetaRight', mac: 'Right Command (⌘)', other: 'Right Search key' },
  { code: 'MetaLeft', mac: 'Left Command (⌘)', other: 'Left Search key' },
  { code: 'none', mac: 'Disabled', other: 'Disabled' },
];

/** @param {boolean} [mac] overridable so the mapping is testable off-browser */
export function keyLabel(code, mac = isMac) {
  const entry = MODIFIER_KEYS.find((k) => k.code === code);
  if (!entry) return code;
  return mac ? entry.mac : entry.other;
}

/** Options for a <select>, as [value, label] pairs. */
export function modifierOptions(mac = isMac) {
  return MODIFIER_KEYS.map((k) => [k.code, mac ? k.mac : k.other]);
}

/** Render a chrome.commands shortcut the way the platform writes it. */
export function commandLabel(shortcut, mac = isMac) {
  if (!shortcut) return 'unassigned';
  if (!mac) return shortcut;
  return shortcut
    .replace(/\bCommand\b|\bMeta\b/g, '⌘')
    .replace(/\bAlt\b|\bOption\b/g, '⌥')
    .replace(/\bShift\b/g, '⇧')
    .replace(/\bMacCtrl\b|\bCtrl\b|\bControl\b/g, '⌃')
    .replace(/\+/g, '');
}
