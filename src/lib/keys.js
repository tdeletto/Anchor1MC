/**
 * Key naming and availability, per platform.
 *
 * The hotkey is matched on `event.code`, which is physical rather than logical:
 * the key to the right of the space bar reports `AltRight` whether it is
 * engraved Alt on a Chromebook or Option on a Mac. So one default works
 * everywhere and a synced profile behaves identically on both machines.
 *
 * What does differ is what the key is called, and whether the operating system
 * lets it through at all — ChromeOS keeps the Search key, Windows keeps the
 * Windows key. Those are the two things this module exists to describe.
 */

/** @typedef {'mac'|'chromeos'|'windows'|'linux'|'unknown'} Platform */

/**
 * @returns {Platform}
 *
 * userAgentData.platform is the reliable source where it exists; the userAgent
 * fallback matters because ChromeOS reports itself as Linux in the older
 * navigator.platform and would otherwise be indistinguishable from it.
 */
export function detectPlatform(nav = globalThis.navigator) {
  const declared = nav?.userAgentData?.platform ?? '';
  const agent = nav?.userAgent ?? '';
  const legacy = nav?.platform ?? '';

  if (/mac/i.test(declared) || /mac/i.test(legacy)) return 'mac';
  if (/chrome\s*os|chromium\s*os/i.test(declared) || /\bCrOS\b/.test(agent)) return 'chromeos';
  if (/win/i.test(declared) || /^win/i.test(legacy)) return 'windows';
  if (/linux/i.test(declared) || /linux/i.test(legacy)) return 'linux';
  return 'unknown';
}

export const PLATFORM = detectPlatform();
export const isMac = PLATFORM === 'mac';

/**
 * Bare-modifier hotkeys, in the order they should be listed.
 *
 * `capturedBy` names the platforms whose window manager takes the key before a
 * web page sees it. Those choices stay in the list — a remapped or external
 * keyboard may still deliver them — but they are labelled so that picking one
 * and finding it dead is not a mystery.
 */
export const MODIFIER_KEYS = [
  { code: 'AltRight', labels: { mac: 'Right Option (⌥)', default: 'Right Alt' } },
  { code: 'AltLeft', labels: { mac: 'Left Option (⌥)', default: 'Left Alt' } },
  { code: 'ControlRight', labels: { mac: 'Right Control (⌃)', default: 'Right Ctrl' } },
  { code: 'ControlLeft', labels: { mac: 'Left Control (⌃)', default: 'Left Ctrl' } },
  { code: 'ShiftRight', labels: { mac: 'Right Shift (⇧)', default: 'Right Shift' } },
  {
    code: 'MetaRight',
    labels: { mac: 'Right Command (⌘)', chromeos: 'Right Search key', windows: 'Right Windows key', default: 'Right Super key' },
    capturedBy: ['chromeos', 'windows', 'linux'],
  },
  {
    code: 'MetaLeft',
    labels: { mac: 'Left Command (⌘)', chromeos: 'Search / Launcher key', windows: 'Windows key', default: 'Super key' },
    capturedBy: ['chromeos', 'windows', 'linux'],
  },
  { code: 'none', labels: { default: 'Disabled' } },
];

const entryFor = (code) => MODIFIER_KEYS.find((k) => k.code === code) ?? null;

/** @param {Platform} [platform] passed explicitly so the mapping is testable */
export function keyLabel(code, platform = PLATFORM) {
  const entry = entryFor(code);
  if (!entry) return code;
  return entry.labels[platform] ?? entry.labels.default;
}

/** Will this platform's window manager swallow the key before a page sees it? */
export function isCapturedByOs(code, platform = PLATFORM) {
  return !!entryFor(code)?.capturedBy?.includes(platform);
}

/** Options for a <select>, as [value, label] pairs. */
export function modifierOptions(platform = PLATFORM) {
  return MODIFIER_KEYS.map((k) => {
    const label = keyLabel(k.code, platform);
    return [k.code, isCapturedByOs(k.code, platform) ? `${label} — usually captured by the system` : label];
  });
}

/** The advice line under the picker, for the currently chosen key. */
export function modifierNote(code, platform = PLATFORM) {
  if (code === 'none') return 'The hold-to-talk key is off. The browser-wide shortcut still works.';
  if (isCapturedByOs(code, platform)) {
    const owner = { chromeos: 'ChromeOS', windows: 'Windows', linux: 'your desktop environment' }[platform] ?? 'the system';
    return `Held down while you speak — but ${owner} usually claims this key before a page sees it, so it may never reach the extension.`;
  }
  return 'Held down while you speak.';
}

/** Render a chrome.commands shortcut the way the platform writes it. */
export function commandLabel(shortcut, platform = PLATFORM) {
  if (!shortcut) return 'unassigned';
  if (platform !== 'mac') return shortcut;
  return shortcut
    .replace(/\bCommand\b|\bMeta\b/g, '⌘')
    .replace(/\bAlt\b|\bOption\b/g, '⌥')
    .replace(/\bShift\b/g, '⇧')
    .replace(/\bMacCtrl\b|\bCtrl\b|\bControl\b/g, '⌃')
    .replace(/\+/g, '');
}

/** Human name for the running platform, for use in prose. */
export function platformName(platform = PLATFORM) {
  return { mac: 'macOS', chromeos: 'ChromeOS', windows: 'Windows', linux: 'Linux' }[platform] ?? 'this device';
}
