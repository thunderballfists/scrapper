// ==UserScript==
// @name         SSO Friendly Site Crawler
// @namespace    https://example.com/
// @version      1.0.0
// @description  Crawl same-origin pages after manual SSO login with optional exporting via POST or downloads.
// @author       OpenAI
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// ==/UserScript==

(function () {
    'use strict';

    /**
     * =============================
     * Configuration
     * =============================
     * maxDepth: Maximum link depth (0 = only the current page, 1 = follow links from current page, ...)
     * maxPages: Maximum number of pages to visit (including the starting page)
     * delayMs: Delay between page visits to avoid hammering the server
     * domainAllowlist: Hostnames or regex strings limiting crawling (default: current host). Strings wrapped with `/` are treated as regular expressions.
     * postEndpoint: Optional HTTPS endpoint accepting POST requests with JSON payload `{ url, timestamp, html, screenshot }`. The endpoint must allow CORS from the current origin or you can enable Tampermonkey's `GM_xmlhttpRequest` mode. Leave empty to trigger downloads instead.
     * screenshotWidth / screenshotHeight: Optional override dimensions for the off-screen iframe used for screenshots. Defaults to document dimensions.
     */
    const CONFIG = {
        maxDepth: 2,
        maxPages: 50,
        delayMs: 1500,
        domainAllowlist: [window.location.host],
        postEndpoint: '',
        screenshotWidth: null,
        screenshotHeight: null,
    };

    /**
     * Utility logging helper.
     */
    const log = (...args) => console.log('[Crawler]', ...args);

    /**
     * State container for crawler lifecycle.
     */
    const state = {
        isRunning: false,
        isPaused: false,
        isStopping: false,
        startTime: null,
        pagesVisited: 0,
        visitLimit: CONFIG.maxPages,
        queue: [],
        visited: new Set(),
        allowlist: new Set(CONFIG.domainAllowlist || [window.location.host]),
        iframe: null,
        idleTrackers: new WeakMap(),
        dynamicAllowlist: new Set(),
        controls: {},
    };

    const ROBOTS_WARNING = '⚠️ This tool does not enforce robots.txt. Ensure you have permission to crawl this site.';

    /**
     * UI creation
     */
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'crawler-control-panel';
        panel.style.position = 'fixed';
        panel.style.top = '10px';
        panel.style.right = '10px';
        panel.style.zIndex = '999999';
        panel.style.background = 'rgba(20, 20, 20, 0.9)';
        panel.style.color = '#fff';
        panel.style.padding = '16px';
        panel.style.width = '320px';
        panel.style.fontFamily = 'system-ui, sans-serif';
        panel.style.borderRadius = '8px';
        panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        panel.style.backdropFilter = 'blur(4px)';

        const title = document.createElement('h2');
        title.textContent = 'Manual Crawl Controller';
        title.style.margin = '0 0 8px';
        title.style.fontSize = '16px';

        const warning = document.createElement('div');
        warning.textContent = ROBOTS_WARNING;
        warning.style.fontSize = '12px';
        warning.style.marginBottom = '8px';
        warning.style.color = '#ffcc00';

        const status = document.createElement('div');
        status.id = 'crawler-status';
        status.style.fontSize = '12px';
        status.style.lineHeight = '1.4';
        status.style.marginBottom = '10px';
        status.textContent = 'Waiting for login…';

        const buttonRow = document.createElement('div');
        buttonRow.style.display = 'flex';
        buttonRow.style.gap = '8px';
        buttonRow.style.marginBottom = '10px';

        const startBtn = document.createElement('button');
        startBtn.textContent = 'Start Crawl';
        startBtn.style.flex = '1';
        startBtn.style.background = '#28a745';
        startBtn.style.border = 'none';
        startBtn.style.color = '#fff';
        startBtn.style.padding = '8px';
        startBtn.style.cursor = 'pointer';
        startBtn.style.borderRadius = '4px';
        startBtn.style.fontWeight = 'bold';
        startBtn.onclick = () => startCrawl();

        const pauseBtn = document.createElement('button');
        pauseBtn.id = 'crawler-pause-btn';
        pauseBtn.textContent = 'Pause';
        pauseBtn.style.flex = '1';
        pauseBtn.style.background = '#ffc107';
        pauseBtn.style.border = 'none';
        pauseBtn.style.color = '#000';
        pauseBtn.style.padding = '8px';
        pauseBtn.style.cursor = 'pointer';
        pauseBtn.style.borderRadius = '4px';
        pauseBtn.onclick = () => togglePause();

        const stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop';
        stopBtn.style.flex = '1';
        stopBtn.style.background = '#dc3545';
        stopBtn.style.border = 'none';
        stopBtn.style.color = '#fff';
        stopBtn.style.padding = '8px';
        stopBtn.style.cursor = 'pointer';
        stopBtn.style.borderRadius = '4px';
        stopBtn.onclick = () => stopCrawl();

        buttonRow.append(startBtn, pauseBtn, stopBtn);

        const allowlistContainer = document.createElement('div');
        allowlistContainer.style.marginBottom = '10px';

        const allowlistTitle = document.createElement('div');
        allowlistTitle.textContent = 'Domain / Regex Allowlist';
        allowlistTitle.style.fontSize = '12px';
        allowlistTitle.style.marginBottom = '4px';

        const allowlistList = document.createElement('ul');
        allowlistList.id = 'crawler-allowlist';
        allowlistList.style.listStyle = 'none';
        allowlistList.style.padding = '0';
        allowlistList.style.maxHeight = '120px';
        allowlistList.style.overflowY = 'auto';
        allowlistList.style.margin = '0 0 8px';

        const allowInputRow = document.createElement('div');
        allowInputRow.style.display = 'flex';
        allowInputRow.style.gap = '4px';

        const allowInput = document.createElement('input');
        allowInput.type = 'text';
        allowInput.placeholder = 'example.com or /regex/';
        allowInput.style.flex = '1';
        allowInput.style.padding = '6px';
        allowInput.style.borderRadius = '4px';
        allowInput.style.border = '1px solid #555';
        allowInput.style.background = '#111';
        allowInput.style.color = '#fff';

        const addAllowBtn = document.createElement('button');
        addAllowBtn.textContent = 'Add';
        addAllowBtn.style.padding = '6px 10px';
        addAllowBtn.style.background = '#17a2b8';
        addAllowBtn.style.border = 'none';
        addAllowBtn.style.color = '#fff';
        addAllowBtn.style.cursor = 'pointer';
        addAllowBtn.style.borderRadius = '4px';
        addAllowBtn.onclick = () => {
            const value = allowInput.value.trim();
            if (!value) return;
            state.allowlist.add(value);
            state.dynamicAllowlist.add(value);
            allowInput.value = '';
            renderAllowlist();
        };

        allowInputRow.append(allowInput, addAllowBtn);

        allowlistContainer.append(allowlistTitle, allowlistList, allowInputRow);

        panel.append(title, warning, status, buttonRow, allowlistContainer);
        document.body.appendChild(panel);

        state.controls = state.controls || {};
        state.controls.pauseBtn = pauseBtn;

        renderAllowlist();
        updateStatus();
    }

    function renderAllowlist() {
        const list = document.getElementById('crawler-allowlist');
        if (!list) return;
        list.innerHTML = '';
        [...state.allowlist].forEach((item) => {
            const li = document.createElement('li');
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            li.style.justifyContent = 'space-between';
            li.style.marginBottom = '4px';
            const span = document.createElement('span');
            span.textContent = item;
            span.style.fontSize = '11px';
            span.style.paddingRight = '6px';
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.background = '#444';
            removeBtn.style.color = '#fff';
            removeBtn.style.border = 'none';
            removeBtn.style.cursor = 'pointer';
            removeBtn.style.borderRadius = '50%';
            removeBtn.style.width = '20px';
            removeBtn.style.height = '20px';
            removeBtn.onclick = () => {
                state.allowlist.delete(item);
                state.dynamicAllowlist.delete(item);
                renderAllowlist();
            };
            li.append(span, removeBtn);
            list.appendChild(li);
        });
    }

    function updateStatus(currentUrl = '') {
        const status = document.getElementById('crawler-status');
        if (!status) return;
        const elapsed = state.startTime ? ((Date.now() - state.startTime) / 1000).toFixed(1) : '0.0';
        const queueSize = state.queue.length;
        status.innerHTML = `State: ${state.isRunning ? (state.isPaused ? 'Paused' : 'Running') : 'Idle'}<br>` +
            `Visited: ${state.pagesVisited} / ${CONFIG.maxPages}<br>` +
            `Queue: ${queueSize}<br>` +
            `Current: ${currentUrl ? truncate(currentUrl, 60) : '—'}<br>` +
            `Depth limit: ${CONFIG.maxDepth}<br>` +
            `Elapsed: ${elapsed}s`;
    }

    function truncate(str, length) {
        return str.length > length ? `${str.slice(0, length - 3)}…` : str;
    }

    function togglePause() {
        if (!state.isRunning) return;
        state.isPaused = !state.isPaused;
        if (state.controls && state.controls.pauseBtn) {
            state.controls.pauseBtn.textContent = state.isPaused ? 'Resume' : 'Pause';
        }
        if (!state.isPaused) {
            runQueue().catch((err) => log('Error resuming crawl', err));
        }
        updateStatus();
    }

    function stopCrawl() {
        state.isStopping = true;
        state.queue.length = 0;
        state.isRunning = false;
        state.isPaused = false;
        if (state.iframe) {
            try {
                state.iframe.src = 'about:blank';
            } catch (err) {
                log('Failed to reset iframe during stop', err);
            }
        }
        updateStatus();
    }

    async function startCrawl() {
        if (state.isRunning) {
            log('Crawl already in progress');
            return;
        }
        state.isRunning = true;
        state.isPaused = false;
        state.isStopping = false;
        state.startTime = Date.now();
        state.pagesVisited = 0;
        state.queue = [];
        state.visited.clear();
        state.allowlist = new Set([...CONFIG.domainAllowlist, ...state.dynamicAllowlist, window.location.host].filter(Boolean));
        state.queue.push({ url: normalizeUrl(window.location.href), depth: 0 });
        updateStatus(window.location.href);
        await crawlCurrentPage();
        if (!state.isStopping) {
            runQueue().catch((err) => log('Crawl terminated with error', err));
        }
    }

    async function crawlCurrentPage() {
        try {
            const currentUrl = normalizeUrl(window.location.href);
            if (state.visited.has(currentUrl)) {
                log('Current page already processed');
                return;
            }
            await waitForSettled(window);
            const payload = await capturePage(window, document);
            await handleOutput(payload);
            state.visited.add(currentUrl);
            state.pagesVisited += 1;
            enqueueLinks(document, currentUrl, 0);
            await delay(CONFIG.delayMs);
        } catch (error) {
            log('Error capturing current page', error);
        }
    }

    async function runQueue() {
        if (!state.isRunning || state.isPaused || state.isStopping) return;
        while (state.queue.length > 0 && state.pagesVisited < CONFIG.maxPages) {
            if (state.isPaused || state.isStopping) break;
            const { url, depth } = state.queue.shift();
            if (state.visited.has(url)) {
                continue;
            }
            if (depth > CONFIG.maxDepth) {
                continue;
            }
            try {
                updateStatus(url);
                const pageData = await visitInIframe(url);
                if (!pageData) {
                    continue;
                }
                await handleOutput(pageData.payload);
                enqueueLinks(pageData.document, url, depth);
                state.visited.add(url);
                state.pagesVisited += 1;
                updateStatus(url);
            } catch (err) {
                log('Error visiting', url, err);
            }
            if (state.pagesVisited >= CONFIG.maxPages) {
                log('Reached max pages');
                break;
            }
            await delay(CONFIG.delayMs);
        }
        state.isRunning = state.queue.length > 0 && state.pagesVisited < CONFIG.maxPages;
        if (state.isRunning && !state.isPaused && !state.isStopping) {
            setTimeout(() => runQueue().catch((err) => log('Error continuing crawl', err)), 0);
        } else {
            updateStatus();
            log('Crawl completed or stopped');
        }
    }

    function normalizeUrl(input) {
        try {
            const url = new URL(input, window.location.origin);
            url.hash = '';
            return url.href;
        } catch (err) {
            return input;
        }
    }

    function isAllowedUrl(url) {
        try {
            const target = new URL(url, window.location.href);
            if (target.origin !== window.location.origin) {
                return false;
            }
            return [...state.allowlist].some((item) => {
                if (!item) return false;
                if (item.startsWith('/') && item.endsWith('/') && item.length > 2) {
                    try {
                        const regex = new RegExp(item.slice(1, -1));
                        return regex.test(target.hostname);
                    } catch (err) {
                        log('Invalid regex in allowlist', item, err);
                        return false;
                    }
                }
                return target.hostname === item;
            });
        } catch (err) {
            return false;
        }
    }

    function enqueueLinks(doc, baseUrl, currentDepth) {
        if (currentDepth + 1 > CONFIG.maxDepth) return;
        const anchors = doc.querySelectorAll('a[href]');
        anchors.forEach((anchor) => {
            try {
                const href = anchor.getAttribute('href');
                if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
                const absoluteUrl = normalizeUrl(new URL(href, baseUrl).href);
                if (!isAllowedUrl(absoluteUrl)) return;
                if (state.visited.has(absoluteUrl)) return;
                if (state.queue.some((item) => item.url === absoluteUrl)) return;
                if (state.queue.length + state.pagesVisited >= CONFIG.maxPages) return;
                state.queue.push({ url: absoluteUrl, depth: currentDepth + 1 });
            } catch (err) {
                log('Failed to enqueue link', err);
            }
        });
        updateStatus();
    }

    async function visitInIframe(url) {
        if (!state.iframe) {
            state.iframe = document.createElement('iframe');
            state.iframe.style.position = 'fixed';
            state.iframe.style.width = `${CONFIG.screenshotWidth || window.innerWidth}px`;
            state.iframe.style.height = `${CONFIG.screenshotHeight || window.innerHeight}px`;
            state.iframe.style.left = '-99999px';
            state.iframe.style.top = '-99999px';
            state.iframe.style.visibility = 'hidden';
            state.iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups');
            document.body.appendChild(state.iframe);
        }
        const iframe = state.iframe;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                log('Iframe load timeout for', url);
                resolve(null);
            }, 60000);

            iframe.onload = async () => {
                clearTimeout(timeout);
                try {
                    const win = iframe.contentWindow;
                    const doc = win.document;
                    await waitForSettled(win);
                    const payload = await capturePage(win, doc);
                    resolve({ payload, document: doc });
                } catch (err) {
                    log('Error capturing iframe page', err);
                    resolve(null);
                } finally {
                    iframe.onload = null;
                }
            };

            try {
                iframe.src = url;
            } catch (err) {
                clearTimeout(timeout);
                log('Failed to set iframe src', err);
                resolve(null);
            }
        });
    }

    async function capturePage(win, doc) {
        await ensureHtml2Canvas(win, doc);
        const timestamp = new Date().toISOString();
        const url = win.location.href;
        const html = doc.documentElement.outerHTML;
        if (typeof win.scrollTo === 'function') {
            try {
                win.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            } catch (err) {
                win.scrollTo(0, 0);
            }
        }
        const canvas = await win.html2canvas(doc.documentElement, {
            useCORS: true,
            windowWidth: doc.documentElement.scrollWidth,
            windowHeight: doc.documentElement.scrollHeight,
            scrollX: 0,
            scrollY: 0,
            onclone: (clonedDoc) => {
                clonedDoc.documentElement.style.scrollBehavior = 'auto';
            },
        });
        const screenshot = canvas.toDataURL('image/png');
        return { url, timestamp, html, screenshot };
    }

    async function ensureHtml2Canvas(win, doc) {
        if (win.html2canvas) return;
        const existing = doc.querySelector('script[data-crawler-html2canvas]');
        if (existing) {
            await new Promise((resolve) => {
                if (win.html2canvas) {
                    resolve();
                } else {
                    existing.addEventListener('load', () => resolve(), { once: true });
                }
            });
            return;
        }
        await new Promise((resolve, reject) => {
            const script = doc.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            script.dataset.crawlerHtml2canvas = 'true';
            script.crossOrigin = 'anonymous';
            script.referrerPolicy = 'no-referrer';
            script.onload = () => resolve();
            script.onerror = (err) => reject(err);
            doc.head.appendChild(script);
        });
    }

    async function waitForSettled(win) {
        const tracker = getActivityTracker(win);
        await tracker.waitForIdle();
    }

    function getActivityTracker(win) {
        if (state.idleTrackers.has(win)) {
            return state.idleTrackers.get(win);
        }
        const tracker = createActivityTracker(win);
        state.idleTrackers.set(win, tracker);
        return tracker;
    }

    function createActivityTracker(win) {
        let pendingRequests = 0;
        let lastActivity = Date.now();
        let lastMutation = Date.now();
        const idleDelay = 1000;

        function markNetworkActivity(delta = 0) {
            pendingRequests = Math.max(0, pendingRequests + delta);
            lastActivity = Date.now();
        }

        function trackFetch() {
            if (!win.fetch || win.fetch.__crawlerWrapped) return;
            const originalFetch = win.fetch;
            const wrapped = function (...args) {
                markNetworkActivity(1);
                return Promise.resolve(originalFetch.apply(this, args))
                    .finally(() => {
                        markNetworkActivity(-1);
                    });
            };
            wrapped.__crawlerWrapped = true;
            win.fetch = wrapped;
        }

        function trackXHR() {
            const XHR = win.XMLHttpRequest;
            if (!XHR || XHR.prototype.__crawlerWrapped) return;
            const send = XHR.prototype.send;
            const open = XHR.prototype.open;
            XHR.prototype.__crawlerWrapped = true;
            XHR.prototype.open = function (...args) {
                this.__crawlerTracked = true;
                return open.apply(this, args);
            };
            XHR.prototype.send = function (...args) {
                if (this.__crawlerTracked) {
                    markNetworkActivity(1);
                    this.addEventListener('loadend', () => markNetworkActivity(-1));
                }
                return send.apply(this, args);
            };
        }

        function trackMutations() {
            const observer = new win.MutationObserver(() => {
                lastMutation = Date.now();
            });
            observer.observe(win.document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });
        }

        trackFetch();
        trackXHR();
        trackMutations();

        async function waitForIdle() {
            let attempts = 0;
            return new Promise((resolve) => {
                const check = () => {
                    attempts += 1;
                    const now = Date.now();
                    const networkIdle = pendingRequests <= 0 && now - lastActivity > idleDelay;
                    const domIdle = now - lastMutation > idleDelay / 2;
                    if (networkIdle && domIdle) {
                        resolve();
                    } else if (attempts > 120) {
                        log('Idle wait timeout');
                        resolve();
                    } else {
                        setTimeout(check, 250);
                    }
                };
                check();
            });
        }

        return { waitForIdle };
    }

    async function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function handleOutput(payload) {
        if (!payload) return;
        const index = String(state.pagesVisited + 1).padStart(4, '0');
        const htmlFilename = `page-${index}.html`;
        const pngFilename = `page-${index}.png`;
        if (CONFIG.postEndpoint) {
            const success = await postPayload(payload);
            if (success) {
                log('Posted payload for', payload.url);
                return;
            }
            log('POST failed, falling back to download');
        }
        await downloadPayload(payload, htmlFilename, pngFilename);
    }

    async function postPayload(payload) {
        const endpoint = CONFIG.postEndpoint;
        if (!endpoint) return false;
        const body = JSON.stringify(payload);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                credentials: 'include',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return true;
        } catch (err) {
            log('Fetch POST failed', err);
            try {
                return await gmPost(endpoint, body);
            } catch (gmErr) {
                log('GM_xmlhttpRequest POST failed', gmErr);
                return false;
            }
        }
    }

    function gmPost(endpoint, body) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest unavailable'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url: endpoint,
                data: body,
                headers: { 'Content-Type': 'application/json' },
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(true);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: (err) => reject(err),
            });
        });
    }

    async function downloadPayload(payload, htmlFilename, pngFilename) {
        const htmlBlob = new Blob([payload.html], { type: 'text/html;charset=utf-8' });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        try {
            await gmDownload(htmlUrl, htmlFilename);
        } finally {
            URL.revokeObjectURL(htmlUrl);
        }
        await gmDownload(payload.screenshot, pngFilename);
    }

    function gmDownload(url, name) {
        return new Promise((resolve, reject) => {
            if (typeof GM_download === 'function') {
                GM_download({ url, name, saveAs: false, ontimeout: () => reject(new Error('Download timeout')), onerror: reject, onload: resolve, onprogress: () => {} });
            } else {
                // Fallback to native download via anchor
                const link = document.createElement('a');
                link.href = url;
                link.download = name;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(resolve, 0);
            }
        });
    }

    // Initialize UI and wait for manual start.
    createControlPanel();
    log('Crawler initialized. Log in manually, then click Start Crawl.');
})();
