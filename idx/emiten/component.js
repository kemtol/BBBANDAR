// Header Logic for SSSAHAM Emiten Pages

const THEME_STORAGE_KEY = 'ui:theme';
let themeKeyListenerAttached = false;

function applyTheme(theme, persist = true) {
    const root = document.documentElement;
    if (!root || !theme) return;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
    if (persist) {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (error) {
            // ignore persistence errors
        }
    }
}

function getCurrentTheme() {
    const root = document.documentElement;
    return root ? root.getAttribute('data-theme') : 'dark';
}

function toggleTheme() {
    const current = getCurrentTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
}

function initThemeControls() {
    const root = document.documentElement;
    const stored = (() => {
        try {
            return localStorage.getItem(THEME_STORAGE_KEY);
        } catch (error) {
            return null;
        }
    })();
    const initialTheme = root?.getAttribute('data-theme') || stored || 'dark';
    applyTheme(initialTheme, false);

    const toggleIcon = document.getElementById('theme-toggle-icon');
    if (toggleIcon) {
        toggleIcon.setAttribute('role', 'button');
        toggleIcon.setAttribute('tabindex', '0');
        toggleIcon.addEventListener('click', toggleTheme);
        toggleIcon.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleTheme();
            }
        });
    }

    if (!themeKeyListenerAttached) {
        document.addEventListener('keydown', (event) => {
            if (event.shiftKey && event.key && event.key.toLowerCase() === 'd') {
                event.preventDefault();
                toggleTheme();
            }
        });
        themeKeyListenerAttached = true;
    }

    window.SSSAHAMTheme = {
        toggle: toggleTheme,
        set: (theme) => applyTheme(theme, true),
        get: () => getCurrentTheme(),
    };
}

$(document).ready(function () {
    initThemeControls();
    // Smart Sticky Header
    let lastScrollY = window.scrollY;
    const navbar = document.querySelector('.navbar');

    if (navbar) {
        window.addEventListener('scroll', () => {
            const currentScrollY = window.scrollY;
            const docHeight = document.documentElement.scrollHeight;
            const showThreshold = docHeight * 0.25; // Top 25% area

            if (currentScrollY > 100) {
                if (currentScrollY > lastScrollY) {
                    // Scrolling Down -> Hide
                    navbar.classList.add('hidden');
                } else {
                    // Scrolling Up
                    if (currentScrollY < showThreshold) {
                        // Only show if we are in the top 25% of the page
                        navbar.classList.remove('hidden');
                    } else {
                        // Keep hidden if we are deep down (below 25%)
                        if (!navbar.classList.contains('hidden')) {
                            navbar.classList.add('hidden');
                        }
                    }
                }
            } else {
                // At very top -> Always show
                navbar.classList.remove('hidden');
            }
            lastScrollY = currentScrollY;
        });
    }
    // Initialize Search
    initSearch();

    // Close Search Panel when clicking outside
    $(document).on('click', function (e) {
        const panel = $('#search-panel');
        // If panel is open and click is not on panel and not on magnifying glass trigger
        if (panel.hasClass('open')) {
            if (!$(e.target).closest('#search-panel').length && !$(e.target).closest('.fa-magnifying-glass').length) {
                toggleSearch();
            }
        }
    });
});

// =========================================
// SEARCH FUNCTIONALITY
// =========================================
function toggleSearch() {
    const panel = document.getElementById('search-panel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        setTimeout(() => document.getElementById('search-input').focus(), 100);
        loadSearchHistory();
    }
}

function initSearch() {
    const input = document.getElementById('search-input');
    if (!input) return;

    input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            const symbol = this.value.toUpperCase().trim();
            if (symbol) {
                saveSearchHistory(symbol);
                // Preserve current start/end/nett params if they exist, or just go to kode
                // But simplified: just update kode, default others.
                if (window.location.pathname.includes('/emiten/')) {
                    window.location.href = `?kode=${symbol}`;
                } else {
                    window.location.href = `emiten/broker-summary.html?kode=${symbol}`;
                }
            }
        }
    });
}

function saveSearchHistory(symbol) {
    let history = JSON.parse(localStorage.getItem('search_history') || '[]');
    history = history.filter(h => h !== symbol);
    history.unshift(symbol);
    if (history.length > 10) history.pop();
    localStorage.setItem('search_history', JSON.stringify(history));
}

function loadSearchHistory() {
    const history = JSON.parse(localStorage.getItem('search_history') || '[]');
    const list = document.getElementById('search-history-list');
    if (!list) return;

    list.innerHTML = '';
    if (history.length === 0) {
        list.innerHTML = '<p class="small opacity-50">Belum ada riwayat.</p>';
        return;
    }
    history.forEach(sym => {
        const div = document.createElement('div');
        div.className = 'search-history-item';
        div.innerHTML = `<span class="fw-bold">${sym}</span><i class="fa-solid fa-chevron-right small opacity-50"></i>`;
        div.onclick = () => {
            saveSearchHistory(sym);
            if (window.location.pathname.includes('/emiten/')) {
                window.location.href = `?kode=${sym}`;
            } else {
                window.location.href = `emiten/broker-summary.html?kode=${sym}`;
            }
        };
        list.appendChild(div);
    });
}
