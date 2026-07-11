// Erases previous translation button
function eraseButton() {
    const translationButton = document.querySelector("button[data-testid='translate-button']");
    if (translationButton) {
        translationButton.remove();
    }
    const loadingIndicator = document.querySelector("span[data-testid='translate-loading']");
    if (loadingIndicator) {
        loadingIndicator.remove();
    }
}

// Shows/hides the 3-dot loading indicator while lyrics are being translated.
// Starting a new translation also clears any previous error marker.
function setTranslatingIndicator(active) {
    const loader = document.querySelector("span[data-testid='translate-loading']");
    if (!loader) return;
    loader.classList.toggle("is-loading", !!active);
    if (active) loader.classList.remove("has-error");
}

// Shows/hides the "!" error marker on the translate button (e.g. AI endpoint failed).
function setTranslateError(active) {
    const loader = document.querySelector("span[data-testid='translate-loading']");
    if (loader) loader.classList.toggle("has-error", !!active);
}

// Toggles the rainbow-hue AI indicator class on the translate button.
function updateTranslateButtonAIState() {
    const translateButton = document.querySelector("button[data-testid='translate-button']");
    if (!translateButton || !isExtensionAlive()) return;
    chrome.storage.local.get(['translationProvider']).then(result => {
        translateButton.classList.toggle('translateButton--ai', result.translationProvider === 'customAI');
    }).catch(() => {});
}

// Wait for all the buttons to load before adding the translate button
function loadChecker() {
    var repeatButton = document.querySelector("button[data-testid='control-button-repeat']");
    var nowPlaying = document.querySelector("div[data-testid='now-playing-widget']");
    var lyricsButton = document.querySelector("button[data-testid='lyrics-button']");
    var lyricsWrapperList = document.querySelectorAll("div[data-testid='lyrics-line']");

    if (repeatButton && nowPlaying && lyricsButton && (lyricsButton.getAttribute("data-active") == "false" || lyricsWrapperList[0])) {
        addTranslateButton();
        enableTranslateButton();
        setupListening();
        updateTranslateButtonAIState();

        // Check if the translate button was enabled on previous session
        chrome.storage.local.get(["translateButton"]).then((result) => {
            if (result.translateButton) {
                toggleTranslateButton();
            }
        });

    } else {
        setTimeout(loadChecker, 100);
    }
}

// Re-entrancy guard for ensureTranslateButton(): setupListening() (called from
// within ensureTranslateButton, which is itself invoked from MutationObserver
// callbacks) disconnects all observers and creates new ones synchronously —
// that can re-trigger callbacks mid-inject and recurse. This flag breaks the
// cycle.
let ensureInFlight = false;

// Detects whether the translate button is missing from the DOM because Spotify
// re-rendered the control bar (which happens when Brave's built-in adblock
// fast-forwards/skips ads, causing a rapid DOM teardown+rebuild). When missing
// AND a valid repeat button still exists, we re-inject the button and restore
// its previously-enabled state. This self-heals the most common Brave symptom:
// "tombol translate hilang setelah lagu berikutnya, harus reload ulang."
function ensureTranslateButton() {
    if (!isExtensionAlive()) return;
    if (ensureInFlight) return; // already re-injecting this tick
    const existingButton = document.querySelector("button[data-testid='translate-button']");
    if (existingButton) return; // still present, nothing to do

    const repeatButton = document.querySelector("button[data-testid='control-button-repeat']");
    const lyricsButton = document.querySelector("button[data-testid='lyrics-button']");
    if (!repeatButton || !lyricsButton) return; // bar not ready yet

    console.log("Translatify: Translate button missing, re-injecting (likely Brave ad-skip re-render)");
    ensureInFlight = true;
    try {
        eraseButton(); // safety: clear any stale leftover loader
        addTranslateButton();
        enableTranslateButton();
        setupListening();
        updateTranslateButtonAIState();

        // Re-apply the enabled state from the previous session so the user isn't
        // forced to click the button again after a silent re-inject.
        chrome.storage.local.get(["translateButton"]).then((result) => {
            if (result.translateButton) {
                toggleTranslateButton();
            }
        }).catch(() => {});
    } finally {
        ensureInFlight = false;
    }
}

// Active observers are tracked here so re-renders don't stack duplicates.
const translateButtonObservers = new Set();

// Always-disconnected on cleanup, so re-calling setupListening() during a
// Brave-triggered re-render doesn't leak duplicate observers.
function disconnectTranslateButtonObservers() {
    translateButtonObservers.forEach(obs => {
        try { obs.disconnect(); } catch {}
    });
    translateButtonObservers.clear();
}

// Sets up all the event listeners
function setupListening() {
    const buttonList = document.querySelectorAll("button");
    const translateButton = document.querySelector("button[data-testid='translate-button']");
    const lyricsButton = document.querySelector("button[data-testid='lyrics-button']");
    const nowPlaying = document.querySelector("div[data-testid='now-playing-widget']");

    buttonList.forEach((button) => {
        button.addEventListener("click", translate);
        button.addEventListener("click", enableTranslateButton);
    });
    
    translateButton.removeEventListener("change",translate);
    translateButton.removeEventListener("click",translate);
    
    // Clean up any previous observers before creating new ones. Spotify's SPA
    // re-renders (especially fast-forwarded by Brave's adblock) can call this
    // again on a fresh button bar; without cleanup we'd double-bind.
    disconnectTranslateButtonObservers();

    // Listen for changes in the now playing widget.
    // Brave's adblock fast-forwards ads, so Spotify swaps the now-playing widget
    // out and back in very quickly. Observing the whole subtree (not just
    // attributes) lets us catch child-list churn the original {attributes:true}
    // only config missed.
    if (nowPlaying) {
        const isNowPlayingStale = () => !document.body.contains(nowPlaying);

        var nowPlayingObserver = new MutationObserver(function(mutationsList, nowPlayingObserver) {
            // Self-heal: if Spotify replaced the now-playing widget, re-attach.
            if (isNowPlayingStale()) {
                nowPlayingObserver.disconnect();
                const freshNowPlaying = document.querySelector("div[data-testid='now-playing-widget']");
                if (freshNowPlaying) {
                    nowPlayingObserver.observe(freshNowPlaying, { attributes: true, subtree: true, childList: true });
                    console.log('Translatify: Re-attached now-playing observer after re-render');
                }
                ensureTranslateButton();
            }
            setTimeout(translate, 100);
            console.log('Translatify: Next music');
        });
        nowPlayingObserver.observe(nowPlaying, { attributes: true, subtree: true, childList: true });
        translateButtonObservers.add(nowPlayingObserver);
    }

    // Listen for changes in the button bar
    if (lyricsButton && lyricsButton.parentNode) {
        const rightButtonBar = lyricsButton.parentNode;
        const isRightButtonBarStale = () => !document.body.contains(rightButtonBar);

        var rightButtonBarObserver = new MutationObserver(function(mutationsList, rightButtonBarObserver) {
            console.log('Translatify: Button bar changed');

            // Self-heal: if Spotify replaced the button bar, our observed node
            // is detached (stale). Re-attach to the fresh bar and re-inject the
            // translate button if it's gone — this is the Brave ad-skip case.
            if (isRightButtonBarStale()) {
                rightButtonBarObserver.disconnect();
                const freshLyricsButton = document.querySelector("button[data-testid='lyrics-button']");
                if (freshLyricsButton && freshLyricsButton.parentNode) {
                    rightButtonBarObserver.observe(freshLyricsButton.parentNode, { subtree: true, childList: true });
                    console.log('Translatify: Re-attached button-bar observer after re-render');
                }
                ensureTranslateButton();
                return;
            }

            // The bar still exists but the translate button may have been
            // removed by Spotify's re-render — ensure it's present.
            ensureTranslateButton();
            setTimeout(enableTranslateButton, 0);
            translate();
        });
        rightButtonBarObserver.observe(rightButtonBar, { subtree: true, childList: true});
        translateButtonObservers.add(rightButtonBarObserver);
    }

    // Global safety-net observer: watches the whole main view for the button bar
    // disappearing altogether. If the now-playing / button-bar observers above
    // both got detached (e.g. cosmetic-filter re-render blown away the parents),
    // this catches it and re-runs the full setup.
    const mainView = document.querySelector("#main-view") || document.querySelector("#main") || document.body;
    if (mainView) {
        const safetyObserver = new MutationObserver(function() {
            ensureTranslateButton();
        });
        safetyObserver.observe(mainView, { subtree: true, childList: true });
        translateButtonObservers.add(safetyObserver);
    }

    // Periodic safety-net: some Brave cosmetic-filter passes mutate the DOM in
    // ways MutationObserver batches drop (synchronous attribute removal during
    // blocked-script execution). A lightweight poll recovers the button even
    // when observers miss it. Stops once the button gate inside ensureTranslateButton
    // does all the work.
    if (!window.__translatifySafetyInterval) {
        window.__translatifySafetyInterval = setInterval(() => {
            if (!isExtensionAlive()) {
                clearInterval(window.__translatifySafetyInterval);
                window.__translatifySafetyInterval = null;
                return;
            }
            ensureTranslateButton();
        }, 3000);
    }
}

// Translates the lyrics
function toggleTranslateButton() {
    if (!isExtensionAlive()) return;
    const translateButton = document.querySelector("button[data-testid='translate-button']");
    if (!translateButton) return;

    if (translateButton.getAttribute("aria-pressed") == "false") {
        translateButton.setAttribute("aria-pressed", "true");
        translateButton.classList.remove("encore-internal-color-text-subdued");
        translateButton.classList.add("encore-internal-color-text-brightAccent");

        try { chrome.storage.local.set({translateButton:true}).catch(() => {}); } catch {}
    } else {
        translateButton.setAttribute("aria-pressed", "false");
        translateButton.classList.remove("encore-internal-color-text-brightAccent");
        translateButton.classList.add("encore-internal-color-text-subdued");

        try { chrome.storage.local.set({translateButton:false}).catch(() => {}); } catch {}
    }

    translate();

}

function enableTranslateButton() {
    const translateButton = document.querySelector("button[data-testid='translate-button']");
    const lyricsButton = document.querySelector("button[data-testid='lyrics-button']");
    if (!translateButton || !lyricsButton) return;

    translateButton.disabled = lyricsButton.getAttribute("data-active") !== "true";
}


function addTranslateButton() {
    const repeatButton = document.querySelector("button[data-testid='control-button-repeat']");
    const buttonBar = repeatButton.parentElement;
    const translateButton = repeatButton.cloneNode(true);

    translateButton.setAttribute("data-testid", "translate-button");
    translateButton.setAttribute("aria-pressed", "false");
    translateButton.removeAttribute("aria-checked");
    translateButton.setAttribute("role", "button");
    // Keep all Encore design-system classes from the clone so Spotify's own CSS
    // handles sizing, padding, and hover states. Only add our marker class and
    // ensure the button starts in the inactive (subdued) colour state.
    translateButton.classList.add("translateButton");
    translateButton.classList.remove("encore-internal-color-text-brightAccent");
    if (!translateButton.classList.contains("encore-internal-color-text-subdued")) {
        translateButton.classList.add("encore-internal-color-text-subdued");
    }

    const svgButton = translateButton.querySelector("svg");
    svgButton.innerHTML = '<defs><linearGradient id="translatify-ai-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#16c5d6"/><stop offset="50%" stop-color="#5fd391"/><stop offset="100%" stop-color="#a4d93f"/></linearGradient></defs><path d="M12.87,15.07L10.33,12.56L10.36,12.53C12.1,10.59 13.34,8.36 14.07,6H17V4H10V2H8V4H1V6H12.17C11.5,7.92 10.44,9.75 9,11.35C8.07,10.32 7.3,9.19 6.69,8H4.69C5.42,9.63 6.42,11.17 7.67,12.56L2.58,17.58L4,19L9,14L12.11,17.11L12.87,15.07M18.5,10H16.5L12,22H14L15.12,19H19.87L21,22H23L18.5,10M15.88,17L17.5,12.67L19.12,17H15.88Z" />';
    svgButton.setAttribute("viewBox", "0 0 24 24");
    buttonBar.appendChild(translateButton);

    // Loading indicator: absolutely positioned inside the button at the top-right corner.
    const loader = document.createElement("span");
    loader.setAttribute("data-testid", "translate-loading");
    loader.className = "translatifyLoader";
    loader.setAttribute("aria-hidden", "true");
    loader.innerHTML = '<span class="translatifyDot"></span>'.repeat(3) + '<span class="translatifyError" aria-hidden="true">!</span>';
    translateButton.appendChild(loader);

    translateButton.addEventListener('click', toggleTranslateButton);
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener(msgObj => {
    if (msgObj.toggleTranslation !== undefined) {
        const translateButton = document.querySelector("button[data-testid='translate-button']");
        if (translateButton) {
            const currentState = translateButton.getAttribute("aria-pressed") === "true";
            if (currentState !== msgObj.toggleTranslation) {
                toggleTranslateButton();
            }
        }
    }
    if (msgObj.updateTranslationProvider !== undefined || msgObj.updateAiSettings !== undefined) {
        updateTranslateButtonAIState();
    }
});
