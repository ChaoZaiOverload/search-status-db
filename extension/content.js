(() => {
  'use strict';

  const CACHE_KEY = 'douban_feed_cache';
  const FETCH_DELAY_MS = 1500;

  // Status selectors — matches old script's known structure with fallbacks
  const STATUS_SELECTOR = [
    'div.stream-items div.new-status.status-wrapper',
    'div.stream-items div.status-wrapper',
    'div.new-status',
  ];

  const SIDEBAR_SELECTOR = [
    'body div#wrapper div#content div.clearfix div.aside',
    'div#content div.aside',
    'div.aside',
  ];

  let stopSignal = false;
  let searchInProgress = false;

  // ── UI injection ──────────────────────────────────────────────────────────

  function findFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'dss-panel';
    panel.innerHTML = `
      <div id="dss-title">搜索广播</div>
      <div class="dss-row">
        <label>关键字</label>
        <input id="dss-keyword" type="text" placeholder="输入关键词…" />
      </div>
      <div class="dss-row">
        <label>最大页数</label>
        <input id="dss-maxpage" type="number" value="10" min="1" max="200" />
      </div>
      <div class="dss-buttons">
        <button id="dss-search">搜索</button>
        <button id="dss-stop" disabled>停止</button>
        <button id="dss-clear-cache">清缓存</button>
      </div>
      <div id="dss-status"></div>
      <div id="dss-results"></div>
    `;
    return panel;
  }

  function injectPanel() {
    if (document.getElementById('dss-panel')) return;

    const sidebar = findFirst(SIDEBAR_SELECTOR);
    if (!sidebar) {
      console.warn('[DSS] sidebar not found, retrying in 1s');
      setTimeout(injectPanel, 1000);
      return;
    }

    const panel = buildPanel();
    sidebar.prepend(panel);

    document.getElementById('dss-search').addEventListener('click', onSearch);
    document.getElementById('dss-stop').addEventListener('click', onStop);
    document.getElementById('dss-clear-cache').addEventListener('click', onClearCache);

    document.getElementById('dss-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onSearch();
    });
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  function loadCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CACHE_KEY, (data) => {
        resolve(data[CACHE_KEY] || {});
      });
    });
  }

  function saveCache(cache) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [CACHE_KEY]: cache }, resolve);
    });
  }

  // ── Page fetching & parsing ───────────────────────────────────────────────

  async function fetchPage(pageNum) {
    const url = pageNum === 1 ? 'https://www.douban.com/' : `https://www.douban.com/?p=${pageNum}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  }

  function parseStatuses(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    for (const sel of STATUS_SELECTOR) {
      const nodes = doc.querySelectorAll(sel);
      if (nodes.length > 0) return Array.from(nodes);
    }
    return [];
  }

  function getStatusId(node) {
    return node.getAttribute('data-sid') || node.getAttribute('data-id') || null;
  }

  function normalizeTimestamp(node) {
    // Replace "X分钟前" style relative times with the absolute title value
    const timeSpan = node.querySelector('span.created_at');
    if (timeSpan) {
      const anchor = timeSpan.querySelector('a');
      const absolute = timeSpan.getAttribute('title');
      if (anchor && absolute) anchor.textContent = absolute;
    }
  }

  // ── Search orchestration ──────────────────────────────────────────────────

  async function onSearch() {
    if (searchInProgress) return;

    const keyword = document.getElementById('dss-keyword').value.trim();
    if (!keyword) {
      setStatus('请输入关键字');
      return;
    }

    const maxPage = parseInt(document.getElementById('dss-maxpage').value, 10) || 10;
    const pattern = new RegExp(keyword, 'i');

    setStatus('加载缓存…');
    const cache = await loadCache();
    // cache structure: { sid: outerHTML }
    const cachedSids = new Set(Object.keys(cache));

    document.getElementById('dss-results').innerHTML = '';
    document.getElementById('dss-search').disabled = true;
    document.getElementById('dss-stop').disabled = false;
    stopSignal = false;
    searchInProgress = true;

    const newEntries = {};   // sid → outerHTML for newly fetched statuses
    let hitCacheAt = false;

    try {
      for (let page = 1; page <= maxPage; page++) {
        if (stopSignal) break;

        setStatus(`正在搜索第 ${page} 页…`);

        let nodes;
        try {
          const html = await fetchPage(page);
          nodes = parseStatuses(html);
        } catch (err) {
          setStatus(`第 ${page} 页请求失败：${err.message}`);
          break;
        }

        if (nodes.length === 0) {
          setStatus(`第 ${page} 页无内容，结束`);
          break;
        }

        let reachedCache = false;
        for (const node of nodes) {
          const sid = getStatusId(node);

          if (sid && cachedSids.has(sid)) {
            // Hit a cached status — show all remaining cached matches then stop fetching
            reachedCache = true;
            hitCacheAt = true;
            break;
          }

          normalizeTimestamp(node);
          if (sid) newEntries[sid] = node.outerHTML;

          if (pattern.test(node.innerHTML)) {
            appendResult(node);
          }
        }

        if (reachedCache) {
          setStatus('命中缓存，正在从缓存中搜索…');
          for (const [, html] of Object.entries(cache)) {
            if (pattern.test(html)) {
              const parser = new DOMParser();
              const cachedNode = parser.parseFromString(html, 'text/html').body.firstChild;
              if (cachedNode) appendResult(cachedNode);
            }
          }
          break;
        }

        if (page < maxPage && !stopSignal) {
          await delay(FETCH_DELAY_MS);
        }
      }
    } finally {
      // Merge new entries into cache and persist
      const merged = { ...newEntries, ...cache };
      await saveCache(merged);

      searchInProgress = false;
      document.getElementById('dss-search').disabled = false;
      document.getElementById('dss-stop').disabled = true;

      const resultCount = document.getElementById('dss-results').children.length;
      setStatus(`搜索完成，找到 ${resultCount} 条结果${hitCacheAt ? '（含缓存）' : ''}`);
    }
  }

  function onStop() {
    stopSignal = true;
    setStatus('正在停止…');
  }

  async function onClearCache() {
    await saveCache({});
    setStatus('缓存已清除');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setStatus(msg) {
    const el = document.getElementById('dss-status');
    if (el) el.textContent = msg;
  }

  function appendResult(node) {
    const results = document.getElementById('dss-results');
    const wrapper = document.createElement('div');
    wrapper.className = 'dss-result-item';
    wrapper.appendChild(node.cloneNode ? node.cloneNode(true) : node);
    results.appendChild(wrapper);
  }

  function delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  injectPanel();
})();
