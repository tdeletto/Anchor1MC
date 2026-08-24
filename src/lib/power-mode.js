/**
 * Power Mode: per-site profiles that override settings automatically.
 *
 * A desktop dictation tool would key these off whichever application is in
 * front. In a Chrome extension the URL is all there is, which covers the same
 * ground for anything you can actually type into from a browser.
 */

/** @typedef {{type:'domain'|'contains'|'regex', value:string}} Match */

export function makeProfile(partial = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'New profile',
    enabled: true,
    match: { type: 'domain', value: '' },
    overrides: {
      // null means "inherit the global setting"
      engine: null,
      language: null,
      enhancementEnabled: null,
      modeId: null,
      autoSend: null,
      insertMode: null,
      recorderStyle: null,
    },
    ...partial,
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function profileMatches(profile, url) {
  if (!profile?.enabled) return false;
  const value = (profile.match?.value ?? '').trim();
  if (!value) return false;
  const host = hostOf(url);
  switch (profile.match.type) {
    case 'domain': {
      const target = value.toLowerCase().replace(/^\*?\./, '');
      return host === target || host.endsWith(`.${target}`);
    }
    case 'contains':
      return (url ?? '').toLowerCase().includes(value.toLowerCase());
    case 'regex':
      try { return new RegExp(value, 'i').test(url ?? ''); } catch { return false; }
    default:
      return false;
  }
}

/** First matching profile for a URL, or null. */
export function resolveProfile(settings, url) {
  if (!settings.powerMode?.enabled || !url) return null;
  return settings.powerMode.profiles.find((p) => profileMatches(p, url)) ?? null;
}

/**
 * Settings with a profile's overrides applied. Returns the original object when
 * nothing matches, so the common path allocates nothing.
 */
export function applyProfile(settings, profile) {
  if (!profile) return settings;
  const o = profile.overrides ?? {};
  const next = structuredClone(settings);
  if (o.engine) next.transcription.engine = o.engine;
  if (o.language) next.transcription.language = o.language;
  if (o.enhancementEnabled !== null && o.enhancementEnabled !== undefined) next.enhancement.enabled = o.enhancementEnabled;
  if (o.modeId) next.enhancement.activeModeId = o.modeId;
  if (o.autoSend !== null && o.autoSend !== undefined) next.output.autoSend = o.autoSend;
  if (o.insertMode) next.output.insertMode = o.insertMode;
  if (o.recorderStyle) next.ui.recorderStyle = o.recorderStyle;
  next._activeProfile = { id: profile.id, name: profile.name };
  return next;
}

export function isSiteDisabled(settings, url) {
  const host = hostOf(url);
  if (!host) return false;
  return (settings.sites?.disabled ?? []).some((d) => {
    const t = d.toLowerCase().replace(/^\*?\./, '');
    return host === t || host.endsWith(`.${t}`);
  });
}
