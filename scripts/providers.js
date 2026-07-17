// Capability registry for translation providers, shared by the popup and the
// content scripts (loaded before them in both contexts). It drives which
// settings panel the popup shows, how runTranslate() gates and dispatches, and
// which storage keys a provider needs — so adding a provider means describing
// it here (plus a translate function in background.js, which keeps its own map
// keyed by the same ids) instead of extending if-chains in four files.
const TRANSLATION_PROVIDERS = {
    google: {
        // Needs no configuration; translates line by line only.
        modes: ['perline'],
        defaultMode: 'perline',
        requiredSettings: [],
        modeSetting: null,
        panelId: null,
        buttonClass: null,
    },
    dlx: {
        modes: ['batch', 'perline'],
        defaultMode: 'batch',
        requiredSettings: ['dlxEndpoint'],
        modeSetting: 'dlxTranslationMode',
        panelId: 'dlxSettings',
        buttonClass: null,
    },
    customAI: {
        modes: ['batch'],
        defaultMode: 'batch',
        requiredSettings: ['aiEndpoint'],
        modeSetting: null,
        panelId: 'aiSettings',
        buttonClass: 'translateButton--ai',
    },
};

const FALLBACK_PROVIDER = 'google';

// Every storage key runTranslate() needs to resolve a provider and its mode.
const PROVIDER_SETTING_KEYS = ['translationProvider', ...Object.values(TRANSLATION_PROVIDERS)
    .flatMap(spec => [...spec.requiredSettings, spec.modeSetting])
    .filter(Boolean)];

// The provider actually used for a pass: the configured one when all of its
// required settings are present, otherwise google. `fallback` is true when the
// user's choice could not be honored (unknown or misconfigured provider), so
// callers can surface that instead of silently translating with Google.
function resolveTranslationProvider(settings) {
    const requested = settings.translationProvider || FALLBACK_PROVIDER;
    const spec = TRANSLATION_PROVIDERS[requested];
    if (spec && !spec.requiredSettings.some(key => !settings[key])) {
        return { id: requested, spec, fallback: false };
    }
    return {
        id: FALLBACK_PROVIDER,
        spec: TRANSLATION_PROVIDERS[FALLBACK_PROVIDER],
        fallback: requested !== FALLBACK_PROVIDER,
    };
}

// Effective mode for a resolved provider: the stored choice when the provider
// supports it, its default otherwise.
function resolveTranslationMode(resolved, settings) {
    const { spec } = resolved;
    const stored = spec.modeSetting ? settings[spec.modeSetting] : null;
    return spec.modes.includes(stored) ? stored : spec.defaultMode;
}
