const ENDPOINTS = [
    (text, sl, tl) => ({
        url: `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`,
        parse: data => data[0].map(a => a[0]).join('')
    }),
    (text, sl, tl) => ({
        url: `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&dt=t&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`,
        parse: data => data[0].map(a => a[0]).join('')
    }),
    (text, sl, tl) => ({
        url: `https://translate.googleapis.com/translate_a/single?client=at&dt=t&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`,
        parse: data => data[0].map(a => a[0]).join('')
    }),
    (text, sl, tl) => ({
        url: `https://translate.googleapis.com/translate_a/single?client=te&dt=t&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`,
        parse: data => data[0].map(a => a[0]).join('')
    }),
];

// No default endpoint is bundled — the user configures a DLX endpoint in the
// popup. Empty source_lang triggers auto-detection.

// Maps selector codes to DLX codes. Only entries that differ from the fallback
// (uppercased base code) are listed. See dlx-lang.md for the full list.
const DLX_LANG_MAP = {
    // Regional/variant codes where DLX diverges from the simple fallback.
    'zh-cn': 'ZH',
    'zh-tw': 'ZH',
    'pt': 'PT',
    'pt-br': 'PT-BR',
    'pt-pt': 'PT-PT',
    'en': 'EN',
    'en-us': 'EN-US',
    'en-gb': 'EN-GB',
    // Aliases that map to a different DLX code than the uppercased base.
    'fil': 'TL',   // Filipino  -> DLX's Tagalog (TL), not "FIL"
    'no': 'NB',    // Norwegian -> DLX's Norwegian Bokmål (NB), not "NO"
    'ku': 'KMR',   // Kurdish   -> DLX's Kurmanji (KMR), not "KU"
    // 3-letter codes the fallback already handles, listed for documentation.
    'bho': 'BHO',
    'ceb': 'CEB',
    'ckb': 'CKB',
    'gom': 'GOM',
    'ig': 'IG',
    'mai': 'MAI',
    'pag': 'PAG',
    'pam': 'PAM',
    'scn': 'SCN',
    'yi': 'YI',
};

function dlxLangCode(lang) {
    if (!lang || lang === 'auto') return '';
    const lower = lang.toLowerCase();
    if (DLX_LANG_MAP[lower]) return DLX_LANG_MAP[lower];
    // Base code uppercased (e.g. "id" -> "ID", "fr" -> "FR")
    return lower.split('-')[0].toUpperCase();
}

// Extract the translated string from a DLX response. Two shapes:
// { data: "..." } and { translations: [{ text: "..." }] }; null if neither.
function parseDlxResponse(data) {
    if (data && typeof data.data === 'string') return data.data;
    if (Array.isArray(data?.translations) && data.translations[0]?.text != null) {
        return data.translations[0].text;
    }
    return null;
}

async function translateWithDlx(text, sourceLanguage, destinationLanguage) {
    const { dlxEndpoint } = await chrome.storage.local.get(['dlxEndpoint']);
    const endpoint = (dlxEndpoint || '').trim();
    if (!endpoint) throw new Error('No DLX endpoint configured. Set one in the extension settings.');
    const url = endpoint.replace(/\/+$/, '');

    const body = { text, target_lang: dlxLangCode(destinationLanguage) };
    const src = dlxLangCode(sourceLanguage);
    if (src) body.source_lang = src;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`DLX HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const result = parseDlxResponse(data);
    if (result != null) return result;
    throw new Error(`DLX unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
}

const GOOGLE_LANG_MAP = {
    'zh': 'zh-CN',
    'iw': 'he',
    'jw': 'jv',
};

function normalizeLang(lang) {
    if (!lang || lang === 'auto') return lang || 'auto';
    const lower = lang.toLowerCase();
    // Preserve regional variants Google supports
    if (['zh-cn', 'zh-tw', 'pt-br', 'pt-pt'].includes(lower)) {
        return lower === 'zh-cn' ? 'zh-CN'
             : lower === 'zh-tw' ? 'zh-TW'
             : lower === 'pt-br' ? 'pt-BR'
             : 'pt-PT';
    }
    const base = lower.split('-')[0];
    return GOOGLE_LANG_MAP[base] || base;
}

// Try each Google endpoint in order; return the first non-empty result.
async function translateWithGoogle(text, sourceLanguage, destinationLanguage) {
    const sl = normalizeLang(sourceLanguage);
    const tl = normalizeLang(destinationLanguage);
    const failures = [];
    for (const endpoint of ENDPOINTS) {
        try {
            const { url, parse } = endpoint(text, sl, tl);
            const res = await fetch(url);
            if (!res.ok) {
                failures.push(`${res.status} ${res.statusText}`);
                continue;
            }
            const data = await res.json();
            const result = parse(data);
            if (result) return result;
            failures.push('empty result');
        } catch (e) {
            failures.push(e.message);
        }
    }
    throw new Error(`All endpoints failed (sl=${sl}, tl=${tl}): ${failures.join('; ')}`);
}

// Batch-translate lyrics with the user's OpenAI-compatible endpoint. Returns
// one translated string per input line; throws otherwise.
async function translateWithAI({ lines, songTitle, artistName, destinationLanguage }) {
    const { aiEndpoint: endpoint, aiApiKey: apiKey, aiModel: model, aiThinkMode: thinkMode } =
        await chrome.storage.local.get(['aiEndpoint', 'aiApiKey', 'aiModel', 'aiThinkMode']);
    if (!endpoint || !apiKey) {
        throw new Error('AI endpoint or API key not configured');
    }

    const baseUrl = endpoint.replace(/\/+$/, '');
    const langName = new Intl.DisplayNames(['en'], { type: 'language' });
    const tlName = langName.of(destinationLanguage) || destinationLanguage;

    const systemPrompt = [
        'You are a skilled literary and song lyric translator.',
        'Translate the following song lyrics into ' + tlName + '.',
        songTitle ? 'Song title: "' + songTitle + '"' : '',
        artistName ? 'Artist: ' + artistName : '',
        '',
        'Guidelines:',
        '- Preserve the poetic, emotional, and rhythmic qualities of the original lyrics.',
        '- Maintain the tone, mood, and style appropriate to the song genre.',
        '- Adapt idioms, metaphors, and cultural references naturally into the target language.',
        '- Keep line breaks and verse structure — each input line must have exactly one output line.',
        '- Do NOT add explanations, notes, or commentary.',
        '- Return a JSON object with exactly one field "translations" that is an array of strings.',
        '- The array must contain exactly one translated string per input line, in the same order.',
        '- Example: {"translations": ["translated line 1", "translated line 2", ...]}',
        '',
        'Input lyrics (one string per line, translate each independently while maintaining overall coherence):'
    ].filter(Boolean).join('\n');

    const body = {
        model: model || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(lines) }
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' }
    };

    if (thinkMode === false) {
        body.reasoning_effort = 'none';
        body.thinking = { type: 'disabled' };
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const preview = await response.text().catch(() => '');
        throw new Error(`Endpoint returned ${contentType || 'unknown content'} instead of JSON. Check that the endpoint URL includes the full API path (e.g. https://api.openai.com/v1 for OpenAI). Preview: ${preview.slice(0, 200)}`);
    }

    let data;
    try {
        data = await response.json();
    } catch (e) {
        throw new Error(`Failed to parse API response as JSON. Check your endpoint URL — it should include the full path (e.g. https://api.openai.com/v1 for OpenAI). Error: ${e.message}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Empty response from AI');
    }

    const parsed = JSON.parse(content);
    const translations = Array.isArray(parsed) ? parsed
        : parsed.translations || parsed.lines || parsed.results || [];

    if (translations.length !== lines.length) {
        throw new Error(`AI returned ${translations.length} translations for ${lines.length} lines (line count mismatch)`);
    }

    return translations;
}

// Translation providers, keyed by the id in the TRANSLATE message. Each
// resolves to one translated string per input line.
const TRANSLATE_PROVIDERS = {
    google: (msg) => Promise.all(msg.lines.map(line => translateWithGoogle(line, msg.sourceLanguage, msg.destinationLanguage))),
    dlx: async (msg) => {
        // A single line keeps exact per-line semantics (no newline splitting).
        if (msg.lines.length === 1) {
            return [await translateWithDlx(msg.lines[0], msg.sourceLanguage, msg.destinationLanguage)];
        }
        // DLX preserves newlines: send the whole sheet as one request, split the result.
        const result = await translateWithDlx(msg.lines.join('\n'), msg.sourceLanguage, msg.destinationLanguage);
        const translations = (result || '').split('\n');
        if (translations.length !== msg.lines.length) {
            // The endpoint merged or dropped lines; throw rather than misalign lyrics.
            throw new Error(`DLX batch line count mismatch (got ${translations.length} for ${msg.lines.length} lines)`);
        }
        return translations;
    },
    customAI: (msg) => translateWithAI(msg),
};

// Connection tests, same keying. Resolve on success, throw on failure.
const TEST_PROVIDERS = {
    dlx: async (msg) => {
        const endpoint = (msg.endpoint || '').trim();
        if (!endpoint) throw new Error('No DLX endpoint configured.');
        const url = endpoint.replace(/\/+$/, '');
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Hello', target_lang: 'ID' })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = await res.json().catch(() => null);
        if (parseDlxResponse(data) == null) {
            throw new Error('Endpoint did not return a DLX-style response ({data} or {translations})');
        }
    },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TRANSLATE') {
        (async () => {
            try {
                const provider = TRANSLATE_PROVIDERS[msg.provider];
                if (!provider) return sendResponse({ error: `Unknown translation provider: ${msg.provider}` });
                if (!Array.isArray(msg.lines) || msg.lines.length === 0) {
                    return sendResponse({ error: 'No lines to translate' });
                }
                sendResponse({ translations: await provider(msg) });
            } catch (e) {
                console.error(`Translatify: ${msg.provider} translation failed`, e.message);
                sendResponse({ error: `${msg.provider} translation failed: ${e.message}` });
            }
        })();
        return true;
    }

    if (msg.type === 'TEST_PROVIDER') {
        (async () => {
            try {
                const test = TEST_PROVIDERS[msg.provider];
                if (!test) return sendResponse({ error: `No connection test for provider: ${msg.provider}` });
                await test(msg);
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        })();
        return true;
    }
});