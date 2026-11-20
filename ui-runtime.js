(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.__agCsUiMain = factory;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (initialConfig) {
  const VERSION = 2;
  const CODE_HASH = initialConfig?.codeHash || '';
  if (window.__agTokenHud) {
    try {
      window.__agTokenHud.destroy();
    } catch {}
    delete window.__agTokenHud;
  }
  document
    .querySelectorAll(
      '#ag-token-hud-style, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill, .ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip'
    )
    .forEach((n) => n.remove());
  document.querySelectorAll('[data-ag-cs-rim]').forEach((el) => {
    el.removeAttribute('data-ag-cs-rim');
    el.style.removeProperty('--ag-cs-rim-pct');
    el.style.removeProperty('--ag-cs-rim-color');
  });
  document.documentElement?.removeAttribute?.('data-ag-cs-hud-compact');

  if (
    window.__agClaudeStyle &&
    window.__agClaudeStyle.version === VERSION &&
    (!CODE_HASH || window.__agClaudeStyle.codeHash === CODE_HASH)
  ) {
    window.__agClaudeStyle.refreshConfig(initialConfig);
    return;
  }
  if (Array.isArray(globalThis.__agCsCleanups)) {
    while (globalThis.__agCsCleanups.length) {
      const fn = globalThis.__agCsCleanups.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch {}
    }
  }
  if (window.__agClaudeStyle) {
    try {
      window.__agClaudeStyle.destroy();
    } catch {}
    delete window.__agClaudeStyle;
  }

  if (window.__agCsI18n && typeof window.__agCsI18n.destroy === 'function') {
    try {
      window.__agCsI18n.destroy();
    } catch {}
    delete window.__agCsI18n;
  }

  document
    .querySelectorAll('.ag-cs-crab, .ag-cs-smooth-caret, .ag-cs-home-panel-seat, .ag-cs-ripple-canvas, .ag-cs-effort-popover, .ag-cs-perf-backdrop, #ag-cs-settings-sec')
    .forEach((n) => n.remove());
  document.querySelectorAll('[data-ag-cs-crab-anchor]').forEach((el) => el.removeAttribute('data-ag-cs-crab-anchor'));

  const usageCore = globalThis.__agCsUsageCore;
  const rippleCore = globalThis.__agCsRippleCore;
  const mascotCore = globalThis.__agCsMascotCore;
  const crabAssets = globalThis.__agCsCrabAssets;
  const effortCore = globalThis.__agCsEffortCore;
  const perfAssets = globalThis.__agCsPerfAssets;
  const i18nCore = globalThis.__agCsI18nCore;
  const i18nLocales = globalThis.__agCsLocales;
  const domTranslator =
    i18nCore && i18nLocales && typeof i18nCore.createDomTranslator === 'function'
      ? i18nCore.createDomTranslator(i18nLocales.resolveLocaleBundle)
      : null;
  if (domTranslator && typeof window !== 'undefined') {
    window.__agCsI18n = domTranslator;
  }

  const STORAGE_SETTINGS_KEY = 'agClaudeStyle.settings.v1';
  const STORAGE_FILE_CFG_KEY = 'agClaudeStyle.lastFileConfig.v1';
  const STORAGE_USAGE_CACHE_KEY = 'agClaudeStyle.trajRollup.v1';

  function sanitizeRuntimeSettings(obj, base) {
    const cleanBase = { ...base };
    delete cleanBase.binding;
    delete cleanBase.pollIntervalMs;
    delete cleanBase.codeHash;
    const out = { ...cleanBase };
    if (obj && typeof obj === 'object') {
      for (const key of Object.keys(cleanBase)) {
        if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
          out[key] = obj[key];
        }
      }
    }
    return out;
  }

  function loadSettings(base, { preferBase = false } = {}) {
    try {
      const cleanBase = sanitizeRuntimeSettings(null, base);
      const baseJson = JSON.stringify(cleanBase);
      const prevBaseJson = localStorage.getItem(STORAGE_FILE_CFG_KEY);
      const hasLiveBinding = Boolean(base?.binding && typeof window[base.binding] === 'function');
      if (preferBase || hasLiveBinding || (prevBaseJson && prevBaseJson !== baseJson)) {
        localStorage.setItem(STORAGE_FILE_CFG_KEY, baseJson);
        localStorage.setItem(STORAGE_SETTINGS_KEY, baseJson);
        return { ...base, ...cleanBase };
      }
      if (!prevBaseJson) localStorage.setItem(STORAGE_FILE_CFG_KEY, baseJson);
      const savedRaw = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || '{}');
      const sanitizedSaved = sanitizeRuntimeSettings(savedRaw, cleanBase);
      if (JSON.stringify(savedRaw) !== JSON.stringify(sanitizedSaved)) {
        localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(sanitizedSaved));
      }
      return { ...base, ...sanitizedSaved };
    } catch {
      return { ...base };
    }
  }

  let cfg = loadSettings(initialConfig);
  let destroyed = false;

  function saveSetting(key, value) {
    cfg[key] = value;
    try {
      const saved = sanitizeRuntimeSettings(JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || '{}'), cfg);
      saved[key] = value;
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(saved));
    } catch {}
    let sentToHost = false;
    try {
      const send = window[cfg.binding];
      if (typeof send === 'function') {
        send(JSON.stringify({ key, value }));
        sentToHost = true;
      }
    } catch {}
    if (sentToHost) {
      try {
        const fileCfg = sanitizeRuntimeSettings(JSON.parse(localStorage.getItem(STORAGE_FILE_CFG_KEY) || '{}'), cfg);
        fileCfg[key] = value;
        localStorage.setItem(STORAGE_FILE_CFG_KEY, JSON.stringify(fileCfg));
      } catch {}
    }
    applyRootAttrs();
    scheduleSync();
  }

  function getLang() {
    const raw = cfg.language || initialConfig?.language || 'zh-CN';
    if (i18nCore && typeof i18nCore.normalizeLanguage === 'function') {
      return i18nCore.normalizeLanguage(raw);
    }
    return raw === 'zh-TW' || raw === 'yue' || raw === 'en' || raw === 'ja' ? raw : 'zh-CN';
  }

  function uiText(lang = getLang()) {
    if (i18nLocales && typeof i18nLocales.getUiStrings === 'function') {
      return i18nLocales.getUiStrings(lang);
    }
    return {};
  }

  function isZh() {
    const lang = getLang();
    return lang === 'zh-CN' || lang === 'zh-TW' || lang === 'yue';
  }

  function isDarkTheme() {
    const b = document.body?.classList;
    const h = document.documentElement?.classList;
    if (b?.contains('theme-light') || b?.contains('light-theme') || b?.contains('light')) return false;
    if (b?.contains('theme-dark') || b?.contains('dark') || b?.contains('dark-theme')) return true;
    if (h?.contains('theme-light') || h?.contains('light-theme') || h?.contains('light')) return false;
    if (h?.contains('theme-dark') || h?.contains('dark') || h?.contains('dark-theme')) return true;
    return true;
  }

  let lastThemeKey = '';
  let lastAppliedLang = '';

  function refreshOpenUiForLanguage() {
    const inHero = Boolean(document.querySelector('.agy-home [data-testid="home-greeting"]'));
    syncGreeting(inHero);
    if (inHero && cfg.homeLayout === 'studio') renderHomePanel(true);
    refreshOpenEffortPopover();
    syncComposers();
    ensureSettingsSection();
  }

  function applyRootAttrs() {
    const html = document.documentElement;
    if (!html) return;
    const palette = cfg.palette === 'claude' ? 'claude' : cfg.palette === 'host' ? 'host' : 'obsidian';
    const lang = getLang();
    html.setAttribute('data-ag-cs-style', '1');
    html.setAttribute('data-ag-cs-palette', palette);
    html.setAttribute('data-ag-cs-home', cfg.homeLayout === 'classic' ? 'classic' : cfg.homeLayout === 'off' ? 'off' : 'studio');
    html.setAttribute('data-ag-cs-composer', cfg.composerRestyle === false ? 'off' : 'on');
    html.setAttribute('data-ag-cs-logo-ink', cfg.logoInk === 'foreground' ? 'foreground' : 'accent');
    html.setAttribute('data-ag-cs-sidebar', cfg.sidebarRestyle === false ? 'off' : 'on');
    html.setAttribute('data-ag-cs-sidebar-compact', cfg.sidebarCompact === true ? 'on' : 'off');
    html.removeAttribute('data-ag-cs-hud-compact');
    html.setAttribute('data-ag-cs-effort-accent', cfg.effortAccent === false ? 'off' : 'on');
    html.setAttribute('data-ag-cs-lang', lang);
    const isCjk = i18nCore && typeof i18nCore.isCjkLanguage === 'function' ? i18nCore.isCjkLanguage(lang) : isZh();
    if (isCjk) html.setAttribute('data-ag-cs-cjk', '1');
    else html.removeAttribute('data-ag-cs-cjk');

    const prevLang = lastAppliedLang;
    if (lang !== prevLang) {
      lastAppliedLang = lang;
      if (typeof window !== 'undefined' && window.__agI18n && typeof window.__agI18n.revert === 'function') {
        try {
          window.__agI18n.revert();
        } catch {}
      }
      if (domTranslator && typeof domTranslator.setLanguage === 'function') {
        domTranslator.setLanguage(lang, document);
      }
      if (prevLang !== '') {
        refreshOpenUiForLanguage();
      }
    }

    const perfBd = cfg.performanceBackdrop === 'page' || cfg.performanceBackdrop === 'off' ? cfg.performanceBackdrop : 'card';
    html.setAttribute('data-ag-cs-perf-backdrop', perfBd);
    if (perfBd !== 'page' || effortCore.normalizeEffortStyle(cfg.effortSliderStyle) !== 'liangwufeng') {
      unmountPerfBackdrop();
    }
    const dark = isDarkTheme();
    const themeKey = `${palette}|${dark ? 'd' : 'l'}`;
    if (themeKey !== lastThemeKey) {
      lastThemeKey = themeKey;
      if (rippleMount && typeof rippleMount.refreshTheme === 'function') {
        rippleMount.refreshTheme();
      }
      refreshOpenEffortPopover();
    }
  }

  // ── Antigravity React Fiber & Store Bridge ─────────────────────────────
  let cachedSvc = null;
  let cachedStore = null;
  let storeUnsub = null;
  let storeDebounce = null;

  function ensureHooks(allowPartial = false) {
    if (cachedSvc && cachedStore) return { svc: cachedSvc, store: cachedStore };
    const anchors = document.querySelectorAll(
      '[data-testid="conversation-view"], [data-testid="agent-input-box"], [data-testid="conversation-row-sidebar"], [data-testid="new-conversation-button"], [data-testid="home-greeting"]'
    );
    for (const el of anchors) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key]; f && !(cachedSvc && cachedStore); f = f.return) {
        const p = f.memoizedProps;
        if (!cachedStore && p && p.store && typeof p.store.getState === 'function') {
          cachedStore = p.store;
        }
        for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
          const v = d.memoizedValue;
          if (!v || typeof v !== 'object') continue;
          if (!cachedSvc && typeof v.getCascadeTrajectory === 'function') cachedSvc = v;
          if (!cachedStore && v.store && typeof v.store.getState === 'function') cachedStore = v.store;
        }
      }
      if (cachedSvc && cachedStore) break;
    }
    if (cachedStore && !storeUnsub) {
      storeUnsub = cachedStore.subscribe(() => {
        if (destroyed || storeDebounce) return;
        storeDebounce = setTimeout(() => {
          storeDebounce = null;
          if (!destroyed) onStoreChanged();
        }, 400);
      });
    }
    if (cachedSvc && cachedStore) return { svc: cachedSvc, store: cachedStore };
    if (allowPartial && (cachedSvc || cachedStore)) return { svc: cachedSvc, store: cachedStore };
    return null;
  }

  function getDisplayName() {
    const h = ensureHooks(true);
    const raw = String(h?.store?.getState()?.userStatus?.name || '').trim();
    if (!raw) return '';
    return raw.split(/\s+/)[0] || raw;
  }

  function resolveCascadeId(inputBox) {
    const cv = inputBox ? inputBox.closest('[data-testid="conversation-view"]') : document.querySelector('[data-testid="conversation-view"]');
    if (inputBox && !cv && inputBox.closest('.agy-home')) {
      return '';
    }
    if (cv) {
      const attrId = cv.getAttribute('data-cascade-id');
      if (attrId && attrId !== 'conversation') return attrId;
    }
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (m) return m[1];
    const readCascadeFromFiber = (el, maxDepth) => {
      if (!el) return '';
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key], d = 0; f && d < maxDepth; f = f.return, d++) {
        const p = f.memoizedProps || f.pendingProps;
        if (p && typeof p.cascadeId === 'string' && p.cascadeId) return p.cascadeId;
      }
      return '';
    };
    const fromInputFiber = readCascadeFromFiber(inputBox, 60);
    if (fromInputFiber) return fromInputFiber;
    const fromCvFiber = readCascadeFromFiber(cv, 35);
    if (fromCvFiber) return fromCvFiber;
    if (cv && !inputBox?.closest?.('[data-testid="subagent-tab-conversation"]')) {
      const h = ensureHooks(true);
      const convoState = h?.store?.getState?.()?.conversation?.convoState;
      if (convoState?.type === 'active' && typeof convoState.cascadeId === 'string' && convoState.cascadeId) {
        return convoState.cascadeId;
      }
    }
    return '';
  }

  // ── Usage Rollup Store (Incremental localStorage cache + live refresh) ──
  const usageRecords = new Map(); // cascadeId -> record
  let usageLoading = false;
  let usageHasData = false;
  let lastUsageFetchAt = 0;
  let bookPick = 0.07; // picks Alice / classic benchmark stably per home mount, refreshed on return
  let activeTab = 'overview';
  let activeRange = 'all';
  let modelsExpanded = false;
  let lastPanelRenderKey = '';

  function loadUsageCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_USAGE_CACHE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const [id, rec] of Object.entries(raw)) {
          if (rec && rec.days) usageRecords.set(id, rec);
        }
        if (usageRecords.size > 0) usageHasData = true;
      }
    } catch {}
  }

  function saveUsageCache() {
    try {
      const obj = {};
      for (const [id, rec] of usageRecords.entries()) obj[id] = rec;
      localStorage.setItem(STORAGE_USAGE_CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }

  loadUsageCache();

  async function refreshUsageRollup(force = false) {
    if (destroyed || usageLoading) return;
    const h = ensureHooks();
    if (!h) return;
    const now = Date.now();
    if (!force && usageHasData && now - lastUsageFetchAt < 15000) return;
    const sums = h.store.getState().trajectorySummaries?.summaries || {};
    const entries = Object.entries(sums).filter(([, s]) => !!s);
    if (entries.length === 0) {
      usageHasData = true;
      renderHomePanel();
      return;
    }

    const staleIds = [];
    const presentIds = new Set();
    for (const [id, sum] of entries) {
      presentIds.add(id);
      const stepCount = Number(sum.stepCount || 0);
      const lastModSec = Number(sum.lastModifiedTime?.seconds || 0);
      const cached = usageRecords.get(id);
      if (!cached || cached.stepCount !== stepCount || cached.lastModifiedSec !== lastModSec) {
        staleIds.push([id, sum]);
      }
    }
    for (const oldId of Array.from(usageRecords.keys())) {
      if (!presentIds.has(oldId)) usageRecords.delete(oldId);
    }

    if (staleIds.length === 0) {
      usageHasData = true;
      lastUsageFetchAt = now;
      renderHomePanel();
      return;
    }

    usageLoading = true;
    renderHomePanel();
    try {
      const CONCURRENCY = 6;
      for (let i = 0; i < staleIds.length && !destroyed; i += CONCURRENCY) {
        const batch = staleIds.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async ([id, sum]) => {
            try {
              const res = await h.svc.getCascadeTrajectory({ cascadeId: id });
              const rec = usageCore.analyzeTrajectoryForUsage(res, sum, id);
              usageRecords.set(id, rec);
            } catch {}
          })
        );
      }
      if (!destroyed) {
        usageHasData = true;
        lastUsageFetchAt = Date.now();
        saveUsageCache();
      }
    } finally {
      usageLoading = false;
      if (!destroyed) renderHomePanel();
    }
  }

  // ── Home Greeting Copy Manager (reversible) ────────────────────────────
  const replacedGreetings = new Map();
  let wasHero = false;

  function syncGreeting(inHero) {
    if (inHero && !wasHero) {
      bookPick = Math.random();
      if (cfg.homeLayout === 'studio') refreshUsageRollup(false);
    }
    wasHero = inHero;

    const h1 = document.querySelector('[data-testid="home-greeting"] h1');
    if (!h1) return;

    if (cfg.homeLayout !== 'studio') {
      h1.removeAttribute('data-ag-no-i18n');
      const orig = replacedGreetings.get(h1);
      if (orig !== undefined) {
        if (h1.textContent !== orig.host) {
          h1.textContent = orig.host;
        }
        replacedGreetings.delete(h1);
      }
      if (domTranslator && typeof domTranslator.translateNode === 'function') {
        domTranslator.translateNode(h1);
      }
      return;
    }

    const name = getDisplayName();
    const target = name ? `What's up next, ${name}?` : "What's up next?";
    h1.setAttribute('data-ag-no-i18n', '');
    if (h1.textContent !== target) {
      if (domTranslator && typeof domTranslator.revertNode === 'function') {
        domTranslator.revertNode(h1);
      }
      const prev = replacedGreetings.get(h1);
      const hostText = prev && h1.textContent === prev.written ? prev.host : h1.textContent || '';
      h1.textContent = target;
      replacedGreetings.set(h1, { host: hostText, written: target });
    }
  }

  function restoreGreetings() {
    for (const [el, rec] of replacedGreetings.entries()) {
      el.removeAttribute('data-ag-no-i18n');
      if (el.isConnected && el.textContent === rec.written) {
        el.textContent = rec.host;
      }
    }
    replacedGreetings.clear();
  }

  // ── Home Dashboard Card Renderer ───────────────────────────────────────
  let panelSeat = null;
  let panelEl = null;
  let heatTipEl = null;
  let modelColours = usageCore.createHomeModelColours();

  function ensurePanelSeat() {
    const home = document.querySelector('.agy-home');
    if (!home || cfg.homeLayout !== 'studio') {
      unmountPanelSeat();
      return null;
    }
    const greeting = home.querySelector('[data-testid="home-greeting"]');
    if (!greeting || !greeting.parentElement) return null;

    if (!panelSeat || !panelSeat.isConnected || panelSeat.parentElement !== greeting.parentElement) {
      unmountPanelSeat();
      panelSeat = document.createElement('div');
      panelSeat.className = 'ag-cs-home-panel-seat';
      panelSeat.setAttribute('data-ag-no-i18n', '');
      panelEl = document.createElement('section');
      panelEl.className = 'ag-cs-home-panel';
      panelSeat.appendChild(panelEl);
      greeting.parentElement.insertBefore(panelSeat, greeting.nextSibling);
    }
    return panelEl;
  }

  function unmountPanelSeat() {
    if (panelSeat && panelSeat.parentElement) panelSeat.parentElement.removeChild(panelSeat);
    panelSeat = null;
    panelEl = null;
    heatTipEl = null;
    lastPanelRenderKey = '';
  }

  function showHeatTip(cell, grid) {
    const tipText = cell.getAttribute('data-tip');
    if (!tipText || !heatTipEl) return;
    heatTipEl.textContent = tipText;
    heatTipEl.setAttribute('data-shown', 'true');
    const gBox = grid.getBoundingClientRect();
    const cBox = cell.getBoundingClientRect();
    const tBox = heatTipEl.getBoundingClientRect();
    const centred = cBox.left + cBox.width / 2 - tBox.width / 2;
    const left = Math.min(Math.max(centred, gBox.left), gBox.right - tBox.width) - gBox.left;
    const above = cBox.top - gBox.top;
    const below = gBox.bottom - cBox.bottom;
    const sideBelow = below > above && below >= tBox.height + 6;
    const top = (sideBelow ? cBox.bottom + 6 : cBox.top - 6 - tBox.height) - gBox.top;
    heatTipEl.style.left = Math.round(left) + 'px';
    heatTipEl.style.top = Math.round(top) + 'px';
  }

  function hideHeatTip() {
    if (heatTipEl) heatTipEl.removeAttribute('data-shown');
  }

  function renderHomePanel(force = false) {
    const panel = ensurePanelSeat();
    if (!panel) return;
    const lang = getLang();
    const ui = uiText(lang);
    const skeleton = !usageHasData && usageLoading;
    const data = usageCore.aggregateUsageRollup(Array.from(usageRecords.values()), activeRange, bookPick, lang);
    const renderKey = [
      lang,
      activeTab,
      activeRange,
      modelsExpanded ? '1' : '0',
      skeleton ? 'skel' : 'ready',
      usageRecords.size,
      data.sessions,
      data.calls,
      data.tokens,
      data.activeDays,
      data.peakHour || '',
      data.model || '',
    ].join('|');
    if (!force && renderKey === lastPanelRenderKey && panel.childElementCount > 0) return;
    lastPanelRenderKey = renderKey;

    panel.innerHTML = '';

    // Header: Tabs + Range Pills
    const head = document.createElement('div');
    head.className = 'ag-cs-home-panel-head';

    const tabs = document.createElement('div');
    tabs.className = 'ag-cs-home-tabs';
    for (const [id, label] of [
      ['overview', ui.tabOverview || 'Overview'],
      ['models', ui.tabModels || 'Models'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-cs-home-tab';
      btn.setAttribute('data-tab', id);
      btn.textContent = label;
      if (activeTab === id) btn.setAttribute('data-active', '');
      btn.addEventListener('click', () => {
        activeTab = id;
        renderHomePanel();
      });
      tabs.appendChild(btn);
    }

    const ranges = document.createElement('div');
    ranges.className = 'ag-cs-home-ranges';
    for (const r of usageCore.HOME_RANGES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-cs-home-range';
      btn.setAttribute('data-range', r.id);
      btn.textContent = typeof usageCore.homeRangeLabel === 'function' ? usageCore.homeRangeLabel(r, lang) : r.labelEn;
      if (activeRange === r.id) btn.setAttribute('data-active', '');
      btn.addEventListener('click', () => {
        activeRange = r.id;
        renderHomePanel();
      });
      ranges.appendChild(btn);
    }

    head.appendChild(tabs);
    head.appendChild(ranges);
    panel.appendChild(head);

    if (activeTab === 'overview') {
      // 3x2 KPI grid
      const stats = document.createElement('div');
      stats.className = 'ag-cs-home-stats';
      const items = [
        ['sessions', ui.kpiSessions || 'Sessions', usageCore.formatHomeCount(data.sessions), String(data.sessions)],
        ['calls', ui.kpiCalls || 'Messages', usageCore.formatHomeCount(data.calls), String(data.calls)],
        ['tokens', ui.kpiTokens || 'Total tokens', usageCore.formatCompactTokens(data.tokens), usageCore.formatHomeCount(data.tokens) + ' tokens'],
        ['days', ui.kpiDays || 'Active days', usageCore.formatHomeCount(data.activeDays), String(data.activeDays)],
        ['peak', ui.kpiPeak || 'Peak hour', data.peakHour || '—', data.peakHour || '—'],
        ['model', ui.kpiFavModel || 'Favorite model', data.model || '—', data.model || '—'],
      ];
      for (const [k, label, valText, titleText] of items) {
        const cell = document.createElement('div');
        cell.className = 'ag-cs-home-stat';
        cell.setAttribute('data-stat', k);
        if (skeleton) cell.setAttribute('data-skeleton', '');
        const lbl = document.createElement('span');
        lbl.className = 'ag-cs-home-stat-label';
        lbl.textContent = label;
        const val = document.createElement('span');
        val.className = 'ag-cs-home-stat-value';
        val.textContent = skeleton ? '' : valText;
        if (!skeleton) val.title = titleText;
        cell.appendChild(lbl);
        cell.appendChild(val);
        stats.appendChild(cell);
      }
      panel.appendChild(stats);

      // 26x7 Heatmap grid
      const heat = document.createElement('div');
      heat.className = 'ag-cs-home-heat';
      if (skeleton) heat.setAttribute('data-skeleton', '');
      const fmt = usageCore.homeShortDateFormat(lang);
      for (const c of data.grid.cells) {
        const sq = document.createElement('span');
        sq.className = 'ag-cs-home-heat-cell';
        sq.setAttribute('data-level', String(c.level));
        if (!skeleton) {
          const tip = `${usageCore.homeShortDate(fmt, c.date)} — ${usageCore.formatCompactTokens(c.tokens)} ${ui.tokenUnit || 'tokens'}`;
          sq.setAttribute('data-tip', tip);
          sq.setAttribute('aria-label', tip);
        }
        heat.appendChild(sq);
      }
      heatTipEl = document.createElement('span');
      heatTipEl.className = 'ag-cs-home-heat-hint';
      heatTipEl.setAttribute('aria-hidden', 'true');
      heat.appendChild(heatTipEl);

      heat.addEventListener('mouseover', (ev) => {
        const target = ev.target && ev.target.closest ? ev.target.closest('.ag-cs-home-heat-cell') : null;
        if (target) showHeatTip(target, heat);
      });
      heat.addEventListener('mouseleave', hideHeatTip);
      panel.appendChild(heat);

      if (data.funBook) {
        const fun = document.createElement('span');
        fun.className = 'ag-cs-home-fun';
        fun.textContent = data.funBook;
        panel.appendChild(fun);
      }
    } else {
      // Models Tab: 30d/7d stacked bar chart + ranked list
      const models = data.models || [];
      if (models.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ag-cs-home-models-empty';
        empty.textContent = ui.noModelUsage || 'No model usage data yet';
        panel.appendChild(empty);
        return;
      }

      const ids = models.map((m) => m.id);
      for (const col of data.modelDays || []) {
        for (const id of Object.keys(col.models || {})) ids.push(id);
      }
      const colours = modelColours(ids);
      const columns = data.modelDays || [];
      const fmt = usageCore.homeShortDateFormat(lang);

      if (columns.length > 0) {
        let peak = 0;
        for (const col of columns) {
          let sum = 0;
          for (const t of Object.values(col.models)) sum += t;
          if (sum > peak) peak = sum;
        }
        const top = usageCore.axisMax(peak);
        const chart = document.createElement('div');
        chart.className = 'ag-cs-home-chart';

        const plot = document.createElement('div');
        plot.className = 'ag-cs-home-chart-plot';
        for (const at of [1, 0.75, 0.5, 0.25, 0]) {
          const tick = document.createElement('span');
          tick.className = 'ag-cs-home-chart-tick';
          tick.style.bottom = `${at * 100}%`;
          tick.textContent = top > 0 ? usageCore.formatCompactTokens(top * at) : '';
          plot.appendChild(tick);
        }

        const bars = document.createElement('div');
        bars.className = 'ag-cs-home-chart-bars';
        for (const col of columns) {
          let dayTotal = 0;
          const stack = [];
          for (const [mId, tok] of Object.entries(col.models)) {
            dayTotal += tok;
            stack.push({ id: mId, tokens: tok });
          }
          stack.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
          const colEl = document.createElement('span');
          colEl.className = 'ag-cs-home-chart-col';
          colEl.title = `${usageCore.homeShortDate(fmt, col.date)} · ${usageCore.formatCompactTokens(dayTotal)}`;
          colEl.style.height = `${top > 0 ? (dayTotal / top) * 100 : 0}%`;
          for (const slice of stack) {
            const seg = document.createElement('span');
            seg.className = 'ag-cs-home-chart-seg';
            seg.setAttribute('data-color', String(colours[slice.id] ?? 0));
            seg.style.height = `${dayTotal > 0 ? (slice.tokens / dayTotal) * 100 : 0}%`;
            colEl.appendChild(seg);
          }
          bars.appendChild(colEl);
        }
        plot.appendChild(bars);
        chart.appendChild(plot);

        const axis = document.createElement('div');
        axis.className = 'ag-cs-home-chart-axis';
        chart.appendChild(axis);
        panel.appendChild(chart);

        // Compute non-overlapping X ticks after layout
        requestAnimationFrame(() => {
          if (!axis.isConnected) return;
          const labels = columns.map((c) => usageCore.homeShortDate(fmt, c.date));
          const widths = labels.map((l) => Math.max(32, l.length * 6.5));
          const ticks = usageCore.homeChartTicks(widths, plot.clientWidth || 420);
          axis.innerHTML = '';
          for (const tk of ticks) {
            const sp = document.createElement('span');
            sp.className = 'ag-cs-home-chart-label';
            sp.style.left = `${tk.left}px`;
            sp.textContent = labels[tk.index];
            axis.appendChild(sp);
          }
        });
      }

      // Ranked model rows
      let totalAll = 0;
      for (const m of models) totalAll += m.tokens;
      const shown = modelsExpanded ? models : models.slice(0, usageCore.HOME_MODEL_ROWS);
      const listEl = document.createElement('div');
      listEl.className = 'ag-cs-home-models';
      for (const m of shown) {
        const row = document.createElement('div');
        row.className = 'ag-cs-home-model';
        row.title = `${m.id} · ${m.sessions} ${ui.sessionsUnit || 'sessions'}`;
        const sw = document.createElement('span');
        sw.className = 'ag-cs-home-model-swatch';
        sw.setAttribute('data-color', String(colours[m.id] ?? 0));
        const nm = document.createElement('span');
        nm.className = 'ag-cs-home-model-name';
        nm.textContent = m.id;
        const inp = (m.input || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
        const outTok = m.output || 0;
        const sp = document.createElement('span');
        sp.className = 'ag-cs-home-model-split';
        sp.textContent = `${usageCore.formatCompactTokens(inp)} in · ${usageCore.formatCompactTokens(outTok)} out`;
        const sh = document.createElement('span');
        sh.className = 'ag-cs-home-model-share';
        sh.textContent = totalAll > 0 ? ((Math.round((m.tokens / totalAll) * 1000) / 10).toFixed(1) + '%') : '—';
        row.appendChild(sw);
        row.appendChild(nm);
        row.appendChild(sp);
        row.appendChild(sh);
        listEl.appendChild(row);
      }
      if (models.length > usageCore.HOME_MODEL_ROWS) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'ag-cs-home-models-more';
        const hiddenCount = models.length - shown.length;
        more.textContent = modelsExpanded
          ? ui.showLess || 'Show less'
          : typeof ui.showMoreN === 'function'
          ? ui.showMoreN(hiddenCount)
          : `Show ${hiddenCount} more`;
        more.addEventListener('click', () => {
          modelsExpanded = !modelsExpanded;
          renderHomePanel();
        });
        listEl.appendChild(more);
      }
      panel.appendChild(listEl);
    }
  }

  // ── Home Interactive ASCII Matrix & Ripple Field ───────────────────────
  let rippleMount = null;

  function motionReduced() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function readRipplePalette(canvas) {
    const cs = getComputedStyle(canvas);
    const ink = rippleCore.parseCssColorToRgb(cs.getPropertyValue('--ag-cs-ripple-ink')) || [136, 146, 159];
    const wave = rippleCore.parseCssColorToRgb(cs.getPropertyValue('--ag-cs-ripple-wave')) || [127, 166, 255];
    const dark = isDarkTheme();
    const fontFamily = cs.getPropertyValue('--font-mono').trim() || 'ui-monospace, Consolas, monospace';
    return { ink, wave, dark, fontFamily };
  }

  function unmountRipple() {
    if (!rippleMount) return;
    clearTimeout(rippleMount.timer);
    if (rippleMount.rafId) cancelAnimationFrame(rippleMount.rafId);
    if (rippleMount.ro) rippleMount.ro.disconnect();
    rippleMount.root.removeEventListener('pointerdown', rippleMount.onPress);
    document.removeEventListener('visibilitychange', rippleMount.onVis);
    rippleMount.field.dispose();
    rippleMount.host.remove();
    rippleMount = null;
  }

  function syncRipple() {
    const home = cfg.homeRipple !== false && cfg.homeLayout !== 'off' ? document.querySelector('.agy-home') : null;
    if (rippleMount && (rippleMount.root !== home || !rippleMount.canvas.isConnected)) {
      unmountRipple();
    }
    if (!home || rippleMount) return;

    const host = document.createElement('div');
    host.className = 'ag-cs-ripple-host';
    host.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.className = 'ag-cs-ripple-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    home.insertBefore(host, home.firstChild);

    const state = {
      root: home,
      host,
      canvas,
      width: -1,
      height: -1,
      dpr: 0,
      waves: rippleCore.createWaveField(0, 0),
      field: rippleCore.createGlyphField(canvas, 0, 0, rippleCore.createWaveField(0, 0)),
      timer: 0,
      rafId: 0,
      ro: null,
      onPress: null,
      onVis: null,
    };
    let previous = performance.now();
    let frameWanted = false;
    let drawnOnce = false;

    function layout() {
      const w = home.clientWidth;
      const h = home.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w === state.width && h === state.height && dpr === state.dpr) return;
      const cols = Math.ceil(w / rippleCore.RIPPLE.cellWidth);
      const rows = Math.ceil(h / rippleCore.RIPPLE.cellHeight);
      state.width = w;
      state.height = h;
      state.dpr = dpr;
      canvas.width = Math.round(cols * rippleCore.RIPPLE.cellWidth * dpr);
      canvas.height = Math.round(rows * rippleCore.RIPPLE.cellHeight * dpr);
      canvas.style.width = `${cols * rippleCore.RIPPLE.cellWidth}px`;
      canvas.style.height = `${rows * rippleCore.RIPPLE.cellHeight}px`;
      state.field.dispose();
      state.waves = rippleCore.createWaveField(cols, rows);
      state.field = rippleCore.createGlyphField(canvas, cols, rows, state.waves);
      drawnOnce = false;
    }

    function wake() {
      clearTimeout(state.timer);
      state.timer = 0;
      if (destroyed || frameWanted) return;
      if (document.hidden) {
        if (!drawnOnce && canvas.width > 0) drawFrame(performance.now());
        return;
      }
      frameWanted = true;
      state.rafId = requestAnimationFrame(drawFrame);
    }

    function sleep(now) {
      if (destroyed || document.hidden) return;
      const period = 1000 / rippleCore.RIPPLE.changeRate;
      state.timer = setTimeout(wake, period - (now % period) + 1);
    }

    function drawFrame(now) {
      state.rafId = 0;
      frameWanted = false;
      if (destroyed) return;
      const still = motionReduced();
      state.waves.advance(still ? 0 : (now - previous) / 1000);
      previous = now;
      if (canvas.width > 0 && state.field.needsDraw(now, still)) {
        const pal = readRipplePalette(canvas);
        state.field.draw(now, pal, still);
        drawnOnce = true;
      }
      if (state.field.busy() && !still) wake();
      else sleep(now);
    }

    state.onPress = (ev) => {
      if (ev.button !== 0 || motionReduced()) return;
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((ev.clientX - rect.left) / rippleCore.RIPPLE.cellWidth);
      const row = Math.floor((ev.clientY - rect.top) / rippleCore.RIPPLE.cellHeight);
      previous = performance.now();
      state.waves.disturb(col, row);
      wake();
    };
    home.addEventListener('pointerdown', state.onPress, { passive: true });

    state.onVis = () => {
      if (!document.hidden) {
        previous = performance.now();
        wake();
      } else {
        clearTimeout(state.timer);
        state.timer = 0;
        if (state.rafId) cancelAnimationFrame(state.rafId);
        state.rafId = 0;
        frameWanted = false;
      }
    };
    document.addEventListener('visibilitychange', state.onVis);

    if (typeof ResizeObserver === 'function') {
      state.ro = new ResizeObserver(() => {
        layout();
        wake();
      });
      state.ro.observe(home);
    }
    layout();
    state.refreshTheme = () => {
      state.field.invalidate();
      if (document.hidden && canvas.width > 0) drawFrame(performance.now());
      else wake();
    };
    wake();
    rippleMount = state;
  }

  // ── Composer Helpers, Effort Slider, Smooth Caret & Crab Activity Probe ─
  const crabStatusCache = new Map(); // cascadeId -> { fetching, lastStep, lastMod, lastRunning, lastAt, status }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getCurrentModelLabel(card) {
    const scope = card || document;
    const btn = scope.querySelector('[data-testid="model-selector-trigger"]');
    if (btn) {
      const aria = btn.getAttribute('aria-label') || '';
      const jaMatch = aria.match(/（現在[：:]\s*(.+)）$/);
      if (jaMatch && jaMatch[1]) return jaMatch[1].trim();
      const m = aria.match(/(?:当前|目前|而家|现在|現在|Current)[：:]\s*(.+)$/i);
      if (m && m[1]) return m[1].trim();
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) return txt;
    }
    return '';
  }

  function readStoreSummaryMeta(store, cascadeId) {
    const st = store?.getState?.();
    const allSummaries = st?.trajectorySummaries?.summaries || st?.cascadeTrajectorySummaries || {};
    const sumEntry = allSummaries[cascadeId];
    const sum = sumEntry?.summary || sumEntry || {};
    return {
      stepCount: Number(sum?.stepCount || 0),
      lastMod: Number(sum?.lastModifiedTime?.seconds || 0),
      running: !!(sum?.notFullyIdle || sum?.hasActivity || sum?.status === 2 || sum?.hasRunningSubagents),
    };
  }

  async function fetchCrabActivity(cascadeId, force = false) {
    if (!cascadeId || cfg.mascot !== 'crab') return null;
    const h = ensureHooks();
    if (!h || typeof h.svc?.getCascadeTrajectory !== 'function') return null;
    const meta = readStoreSummaryMeta(h.store, cascadeId);
    let entry = crabStatusCache.get(cascadeId);
    if (!entry) {
      entry = { fetching: false, lastStep: -1, lastMod: -1, lastRunning: false, lastAt: 0, status: null };
      crabStatusCache.set(cascadeId, entry);
    }
    if (entry.fetching) return entry.status;
    const now = Date.now();
    const minMs = meta.running ? 1200 : !entry.status ? 1500 : 3500;
    const summaryChanged =
      !entry.status ||
      entry.lastStep !== meta.stepCount ||
      entry.lastMod !== meta.lastMod ||
      entry.lastRunning !== meta.running;
    if (!force) {
      if (!summaryChanged && !meta.running && !entry.status.isRunning) {
        return entry.status;
      }
      if (!summaryChanged && now - entry.lastAt < minMs) return entry.status;
    }
    entry.fetching = true;
    try {
      const res = await h.svc.getCascadeTrajectory({ cascadeId });
      const nextStatus =
        usageCore && typeof usageCore.inspectTrajectoryActivity === 'function'
          ? usageCore.inspectTrajectoryActivity(res)
          : { isRunning: false, isThinking: false, hasError: false };
      entry.status = nextStatus;
      entry.lastStep = meta.stepCount;
      entry.lastMod = meta.lastMod;
      entry.lastRunning = meta.running;
      entry.lastAt = Date.now();
    } catch {} finally {
      entry.fetching = false;
    }
    return entry.status;
  }

  // ── Pixel Crab Mascot Player ───────────────────────────────────────────
  let crabState = {
    root: null,
    sprite: null,
    strip: null,
    stage: mascotCore.freshStage(Date.now()),
    wasRunning: false,
    anchor: null,
  };

  function playCrabAnimation(strip, key, mode) {
    if (crabState.stage.animation) {
      crabState.stage.animation.cancel();
      crabState.stage.animation = null;
    }
    const sheet = crabAssets.CRAB_SHEETS[key];
    if (!sheet) return;
    if (motionReduced() && !crabState.stage.reaction) {
      strip.style.transform = mascotCore.frameOffset(sheet, sheet.still, crabAssets.CRAB_GUTTER);
      return;
    }
    strip.style.transform = '';
    const keyframes = [];
    const duration = sheet.frames * crabAssets.CRAB_FRAME_MS;
    for (let f = 0; f < sheet.frames; f++) {
      keyframes.push({
        offset: f / sheet.frames,
        transform: mascotCore.frameOffset(sheet, f, crabAssets.CRAB_GUTTER),
        easing: 'steps(1)',
      });
    }
    keyframes.push({
      offset: 1,
      transform: mascotCore.frameOffset(sheet, mode === 'loop' ? 0 : sheet.frames - 1, crabAssets.CRAB_GUTTER),
    });
    const anim = strip.animate(keyframes, {
      duration,
      iterations: mode === 'loop' ? Infinity : 1,
      fill: 'forwards',
    });
    crabState.stage.animation = anim;
    if (mode === 'once') {
      anim.finished.then(
        () => {
          if (crabState.stage.animation !== anim || !crabState.stage.current || crabState.stage.current.key !== key || crabState.stage.current.done) return;
          crabState.stage.current.done = true;
          mascotCore.finishStage(crabState.stage, key, Date.now(), Math.random);
          stepCrab();
        },
        () => {}
      );
    }
  }

  function showCrabSheet(next, now) {
    const sheet = crabAssets.CRAB_SHEETS[next.key];
    const urls = crabAssets.CRAB_SHEET_URLS[next.key];
    if (!sheet || !urls || !crabState.root || !crabState.strip) return;
    const [cw, ch] = mascotCore.cellSize(sheet, crabAssets.CRAB_GUTTER);
    crabState.stage.current = { key: next.key, mode: next.mode, priority: next.priority, start: now };
    if (crabState.stage.reaction && crabState.stage.reaction.key === next.key) {
      crabState.stage.reaction.fresh = false;
    }
    const st = crabState.root.style;
    st.setProperty('--ag-cs-mascot-sheet', `url("${urls.body}")`);
    st.setProperty('--ag-cs-crab-ink', `url("${urls.ink}")`);
    st.setProperty('--ag-cs-mascot-x', String(sheet.box[0]));
    st.setProperty('--ag-cs-mascot-y', String(sheet.box[1]));
    st.setProperty('--ag-cs-mascot-w', String(sheet.box[2]));
    st.setProperty('--ag-cs-mascot-h', String(sheet.box[3]));
    st.setProperty('--ag-cs-mascot-cell-w', String(cw));
    st.setProperty('--ag-cs-mascot-columns', '8');
    st.setProperty('--ag-cs-mascot-strip-h', String(ch * Math.ceil(sheet.frames / 8)));
    crabState.root.setAttribute('data-animation', next.key);
    playCrabAnimation(crabState.strip, next.key, next.mode);
    if (!crabState.root.hasAttribute('data-ready')) crabState.root.setAttribute('data-ready', '');
  }

  function stepCrab() {
    if (destroyed || !crabState.root || !crabState.strip) return;
    const now = Date.now();
    if (
      crabState.stage.current &&
      crabState.stage.current.mode === 'once' &&
      !crabState.stage.current.done &&
      now - crabState.stage.current.start >= (crabAssets.CRAB_SHEETS[crabState.stage.current.key]?.frames || 1) * crabAssets.CRAB_FRAME_MS
    ) {
      crabState.stage.current.done = true;
      mascotCore.finishStage(crabState.stage, crabState.stage.current.key, now, Math.random);
    }
    const next = mascotCore.decideStage(crabState.stage, now, crabState.stage.level, {
      extras: mascotCore.CRAB_EXTRAS,
      extrasAllowed: !motionReduced() && !document.hidden,
      random: Math.random,
    });
    const switching =
      !crabState.stage.current ||
      next.key !== crabState.stage.current.key ||
      (crabState.stage.reaction && crabState.stage.reaction.fresh);
    const settled = mascotCore.switchSettles(crabState.stage, next, now);
    if (switching && settled) {
      showCrabSheet(next, now);
    }
    if (crabState.stage.timer) clearTimeout(crabState.stage.timer);
    crabState.stage.timer = null;
    const at = mascotCore.nextDecisionAt(
      crabState.stage,
      now,
      switching && !settled,
      (k) => (crabAssets.CRAB_SHEETS[k]?.frames || 1) * crabAssets.CRAB_FRAME_MS
    );
    if (at !== Infinity) {
      crabState.stage.timer = setTimeout(() => {
        crabState.stage.timer = null;
        stepCrab();
      }, Math.max(0, at - now));
    }
  }

  function buildCrabNode() {
    const root = document.createElement('span');
    root.className = 'ag-cs-crab';
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-ag-no-i18n', '');
    const sprite = document.createElement('span');
    sprite.className = 'ag-cs-crab-sprite';
    const strip = document.createElement('span');
    strip.className = 'ag-cs-crab-strip';
    sprite.appendChild(strip);
    root.appendChild(sprite);

    const hit = document.createElement('span');
    hit.className = 'ag-cs-crab-hit';
    hit.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      crabState.stage.quietSince = Date.now();
      crabState.stage.press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, lifted: false };
      try {
        hit.setPointerCapture(ev.pointerId);
      } catch {}
    });
    hit.addEventListener('pointermove', (ev) => {
      const p = crabState.stage.press;
      if (!p || p.lifted || ev.pointerId !== p.id) return;
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 4) return;
      p.lifted = true;
      crabState.stage.clicks = [];
      crabState.stage.reaction = { key: 'drag', mode: 'loop', fresh: true };
      stepCrab();
    });
    const endPress = (ev, allowPoke) => {
      const p = crabState.stage.press;
      if (!p || ev.pointerId !== p.id) return;
      const lifted = p.lifted;
      crabState.stage.press = null;
      if (lifted) {
        crabState.stage.reaction = null;
        stepCrab();
        return;
      }
      if (!allowPoke) return;
      const now = Date.now();
      if (crabState.stage.clicks.length > 0 && now - crabState.stage.clicks[crabState.stage.clicks.length - 1] > 450) {
        crabState.stage.clicks = [];
      }
      crabState.stage.clicks.push(now);
      if (crabState.stage.clicks.length >= 4) {
        crabState.stage.clicks = [];
        crabState.stage.reaction = { key: 'tickle', mode: 'once', fresh: true };
        stepCrab();
        return;
      }
      const box = hit.getBoundingClientRect();
      const key = ev.clientX - box.left < box.width / 2 ? 'poke-left' : 'poke-right';
      crabState.stage.reaction = { key, mode: 'once', fresh: true };
      stepCrab();
    };
    hit.addEventListener('pointerup', (ev) => endPress(ev, true));
    hit.addEventListener('pointercancel', (ev) => endPress(ev, false));
    hit.addEventListener('click', (ev) => ev.stopPropagation());
    root.appendChild(hit);
    return { root, sprite, strip };
  }

  function unmountCrab() {
    if (crabState.stage.timer) clearTimeout(crabState.stage.timer);
    if (crabState.stage.animation) crabState.stage.animation.cancel();
    if (crabState.root && crabState.root.parentElement) crabState.root.parentElement.removeChild(crabState.root);
    if (crabState.anchor) crabState.anchor.removeAttribute('data-ag-cs-crab-anchor');
    document.querySelectorAll('.ag-cs-crab').forEach((n) => n.remove());
    document.querySelectorAll('[data-ag-cs-crab-anchor]').forEach((el) => el.removeAttribute('data-ag-cs-crab-anchor'));
    crabState.root = null;
    crabState.sprite = null;
    crabState.strip = null;
    crabState.anchor = null;
    crabState.stage = mascotCore.freshStage(Date.now());
  }

  function syncCrab(activeCard, activeInfo) {
    if (cfg.mascot !== 'crab' || !activeCard) {
      unmountCrab();
      return;
    }
    let needsStep = false;
    if (!crabState.root) {
      const built = buildCrabNode();
      crabState.root = built.root;
      crabState.sprite = built.sprite;
      crabState.strip = built.strip;
      needsStep = true;
    }
    if (crabState.root.parentElement !== activeCard) {
      if (crabState.anchor) crabState.anchor.removeAttribute('data-ag-cs-crab-anchor');
      activeCard.setAttribute('data-ag-cs-crab-anchor', 'composer');
      activeCard.appendChild(crabState.root);
      crabState.anchor = activeCard;
      needsStep = true;
    }
    document.querySelectorAll('.ag-cs-crab').forEach((n) => {
      if (n !== crabState.root) n.remove();
    });
    document.querySelectorAll('[data-ag-cs-crab-anchor]').forEach((el) => {
      if (el !== activeCard) el.removeAttribute('data-ag-cs-crab-anchor');
    });
    const now = Date.now();
    const isRunning = Boolean(activeInfo?.isRunning);
    if (crabState.wasRunning && !isRunning) {
      mascotCore.takeMoment(crabState.stage, activeInfo?.hasError ? 'error' : 'attention', now);
      needsStep = true;
    }
    crabState.wasRunning = isRunning;
    const nextLevel = mascotCore.levelFromActiveInfo(activeInfo);
    if (!crabState.stage.level || crabState.stage.level.state !== nextLevel.state) {
      crabState.stage.level = nextLevel;
      needsStep = true;
    }
    if (needsStep || !crabState.stage.current) stepCrab();
  }

  // ── Interactive Thinking Effort Slider Popover (Claude Code & ChatGPT Performance) ──
  let openEffortPop = null;
  let openEffortAnchor = null;
  let openEffortModelBtn = null;
  let openEffortBadgeEl = null;
  let perfBackdropEl = null;
  let effortMatrixRaf = 0;
  let codexMotionRaf = 0;

  function cancelCodexMotionRaf() {
    if (codexMotionRaf) {
      cancelAnimationFrame(codexMotionRaf);
      codexMotionRaf = 0;
    }
  }

  function unmountPerfBackdrop() {
    if (perfBackdropEl && perfBackdropEl.parentElement) {
      perfBackdropEl.parentElement.removeChild(perfBackdropEl);
    }
    perfBackdropEl = null;
  }

  function syncPerfBackdrop(frameUrl, rgb, dark) {
    if (effortCore.normalizeEffortStyle(cfg.effortSliderStyle) !== 'liangwufeng' || cfg.performanceBackdrop !== 'page' || !openEffortPop || !openEffortPop.isConnected) {
      unmountPerfBackdrop();
      return;
    }
    let imgEl = perfBackdropEl?.querySelector?.('.ag-cs-perf-backdrop-img') || null;
    if (!perfBackdropEl || !perfBackdropEl.isConnected) {
      perfBackdropEl = document.createElement('div');
      perfBackdropEl.className = 'ag-cs-perf-backdrop';
      perfBackdropEl.setAttribute('aria-hidden', 'true');
      perfBackdropEl.setAttribute('data-ag-no-i18n', '');
      imgEl = document.createElement('div');
      imgEl.className = 'ag-cs-perf-backdrop-img';
      perfBackdropEl.appendChild(imgEl);
      document.body.appendChild(perfBackdropEl);
    }
    perfBackdropEl.setAttribute('data-perf-theme', dark ? 'dark' : 'light');
    const [r, g, b] = Array.isArray(rgb) ? rgb : [245, 165, 36];
    perfBackdropEl.style.backgroundImage = dark
      ? `radial-gradient(640px 380px at 82% 8%, rgba(${r},${g},${b},0.28), transparent 64%), radial-gradient(560px 360px at 14% 94%, rgba(${r},${g},${b},0.18), transparent 58%), linear-gradient(180deg, rgba(7,9,14,0.34), rgba(7,9,14,0.52))`
      : `radial-gradient(640px 380px at 82% 8%, rgba(${r},${g},${b},0.22), transparent 64%), radial-gradient(560px 360px at 14% 94%, rgba(${r},${g},${b},0.16), transparent 58%), linear-gradient(180deg, rgba(248,250,252,0.38), rgba(241,245,249,0.54))`;
    if (imgEl) {
      imgEl.style.backgroundImage = frameUrl ? `url("${frameUrl}")` : 'none';
    }
  }

  function closeEffortPopover() {
    if (effortMatrixRaf) {
      cancelAnimationFrame(effortMatrixRaf);
      effortMatrixRaf = 0;
    }
    cancelCodexMotionRaf();
    unmountPerfBackdrop();
    if (openEffortPop && openEffortPop.parentElement) {
      openEffortPop.parentElement.removeChild(openEffortPop);
    }
    openEffortPop = null;
    openEffortAnchor = null;
    openEffortModelBtn = null;
    openEffortBadgeEl = null;
  }

  function refreshOpenEffortPopover() {
    if (!openEffortPop || !openEffortPop.isConnected) return;
    renderEffortPopoverContent(openEffortPop, openEffortModelBtn, openEffortBadgeEl);
    positionEffortPopover(openEffortPop, openEffortAnchor || openEffortModelBtn);
    if (typeof openEffortPop._syncEffortKnob === 'function') {
      openEffortPop._syncEffortKnob(true);
    }
  }

  function resolveModelEffortContext(modelBtn, badgeEl) {
    const readLiveBadgeEffort = (el) => {
      if (!el) return '';
      const rawTxt = (el.textContent || '').trim().toLowerCase();
      const m = rawTxt.match(/\b(extra|xhigh|high|med(?:ium)?|low|max)\b/);
      if (m) return m[1].startsWith('med') ? 'medium' : m[1];
      return (el.getAttribute('data-ag-cs-effort') || rawTxt).trim().toLowerCase();
    };
    let badgeEffort = readLiveBadgeEffort(badgeEl);
    if (!badgeEffort && modelBtn) {
      const foundBadge = modelBtn.querySelector('.ag-cs-effort-badge, [data-ag-cs-effort]');
      if (foundBadge) {
        badgeEffort = readLiveBadgeEffort(foundBadge);
      } else {
        const spans = modelBtn.querySelectorAll('span');
        const sub = spans.length >= 2 ? spans[spans.length - 1] : null;
        if (sub && sub.childElementCount === 0) {
          badgeEffort = readLiveBadgeEffort(sub);
        }
      }
    }
    let fiberProps = null;
    if (modelBtn) {
      const fk = Object.keys(modelBtn).find((k) => k.startsWith('__reactFiber$'));
      for (let cur = fk && modelBtn[fk], d = 0; cur && d < 30; cur = cur.return, d++) {
        const mp = cur.memoizedProps;
        if (mp && Array.isArray(mp.modelOptions) && typeof mp.setSelectedModel === 'function') {
          fiberProps = mp;
          break;
        }
        if (mp && mp.value && Array.isArray(mp.value.modelOptions) && typeof mp.value.setSelectedModel === 'function') {
          fiberProps = mp.value;
          break;
        }
      }
    }

    const selectedLabel = fiberProps?.selectedModel?.label || getCurrentModelLabel(modelBtn?.closest?.('.surface-composer-card')) || '';
    const resolved = effortCore.resolveClaudeEffortSteps(fiberProps?.modelOptions, selectedLabel, badgeEffort);

    const commitSelection = (opt, effortId, effortDisplay, fullLabel, onHostResolved) => {
      const hasRealModelSetter = Boolean(opt && fiberProps && typeof fiberProps.setSelectedModel === 'function');
      if (hasRealModelSetter) {
        try {
          fiberProps.setSelectedModel(opt);
        } catch {}
      }
      const syncBadgeDom = () => {
        let targetBadge = badgeEl && badgeEl.isConnected ? badgeEl : null;
        if (!targetBadge && modelBtn) {
          targetBadge = modelBtn.querySelector('.ag-cs-effort-badge, [data-ag-cs-effort]');
          if (!targetBadge) {
            const spans = modelBtn.querySelectorAll('span');
            const sub = spans.length >= 2 ? spans[spans.length - 1] : null;
            if (sub && sub.childElementCount === 0) targetBadge = sub;
          }
        }
        let resolvedDisplay = effortDisplay;
        if (targetBadge) {
          if (!hasRealModelSetter) {
            targetBadge.textContent = ' ' + effortDisplay;
          } else if (effortId === 'xhigh' && /\bextra\b/i.test(targetBadge.textContent || '')) {
            resolvedDisplay = 'Extra';
          }
          const badgeLevel = String(resolvedDisplay || '').trim().toLowerCase() === 'extra' ? 'extra' : effortId;
          targetBadge.setAttribute('data-ag-cs-effort', badgeLevel);
          targetBadge.classList.add('ag-cs-effort-badge');
          openEffortAnchor = targetBadge;
          openEffortBadgeEl = targetBadge;
        }
        if (resolvedDisplay !== effortDisplay && typeof onHostResolved === 'function') {
          onHostResolved(resolvedDisplay);
        }
        if (modelBtn && !hasRealModelSetter) {
          const aria = modelBtn.getAttribute('aria-label') || '';
          if (aria) {
            modelBtn.setAttribute('aria-label', fullLabel || aria.replace(/\b(Low|Medium|High|XHigh|Max)\)?$/i, effortDisplay));
          }
        }
      };
      syncBadgeDom();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          syncBadgeDom();
          scheduleSync();
        });
      }
    };

    return {
      fiberProps,
      selectedLabel,
      badgeEffort,
      baseName: resolved.baseName,
      steps: resolved.steps,
      selectedIdx: resolved.selectedIdx,
      selectStep(step, onHostResolved) {
        if (!step) return;
        commitSelection(step.option, step.id, step.display, step.option?.label, onHostResolved);
      },
      selectPreset(preset, onHostResolved) {
        if (!preset) return;
        commitSelection(preset.option, preset.effort, preset.effortDisplay, preset.fullLabel, onHostResolved);
      },
    };
  }

  function paintEffortMatrixCanvas(canvas, activeStep, isApex, startTime, matrixState) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cssW = Math.max(180, Math.round(canvas.clientWidth || canvas.getBoundingClientRect().width || 232));
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const wDev = Math.round(cssW * dpr);
    const hDev = Math.round(effortCore.BAND_H * dpr);

    if (canvas.width !== wDev || canvas.height !== hDev) {
      canvas.width = wDev;
      canvas.height = hDev;
    }

    ctx.clearRect(0, 0, wDev, hDev);
    if (!isApex) return;

    if (!matrixState.field || matrixState.field.widthDev !== wDev || matrixState.field.dpr !== dpr) {
      matrixState.field = effortCore.solveField(wDev, dpr);
    }

    const blocks = matrixState.field.blocks;
    const dark = isDarkTheme();
    const accent =
      cfg.effortAccent === false
        ? dark
          ? [200, 200, 208]
          : [71, 85, 105]
        : dark
          ? activeStep?.rgb || [163, 89, 255]
          : [124, 58, 237];
    const flash =
      cfg.effortAccent === false
        ? dark
          ? [255, 255, 255]
          : [15, 23, 42]
        : dark
          ? [242, 232, 255]
          : [196, 181, 253];
    const reduced = motionReduced();
    const t = reduced ? 10 : Math.max(0, (performance.now() - startTime) / 1000);
    const rgb = [0, 0, 0];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.fade <= 0.004) continue;
      const phase = reduced ? 1 : effortCore.arrivalPhase(t, block.entrance);
      const rise = reduced ? 1 : effortCore.arrivalRise(phase);
      if (rise <= 0.004) continue;
      const glow = reduced ? 0 : effortCore.arrivalGlow(phase);
      const flashShare = effortCore.flashAt(block, t);
      const flow = effortCore.flowAt(block, t);
      effortCore.composeBlockColour(accent, flash, flashShare, glow, flow, rgb);
      const boost = Math.max(flashShare, flow, glow);
      const alpha = Math.max(0, Math.min(0.96, block.fade * rise * (0.3 + 0.64 * boost)));
      if (alpha <= 0.01) continue;
      ctx.fillStyle = `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha.toFixed(3)})`;
      ctx.fillRect(block.x, block.y, block.size, block.size);
    }
  }

  /**
   * Render the ChatGPT Codex effort slider popover (Microqian2th/dsh-codex-effort-slider style).
   */
  function renderCodexEffortPopover(pop, ctx, lang) {
    unmountPerfBackdrop();
    const ui = uiText(lang);
    const steps = ctx.steps || [];
    const count = steps.length;
    if (count <= 0) return;

    let currentIdx = Math.max(0, Math.min(count - 1, ctx.selectedIdx || 0));
    const initPct = effortCore.codexPctFromIndex(currentIdx, count);
    const motion = { x: initPct, v: 0, a: 0, target: initPct };
    let dragging = false;
    let pointerActive = false;
    let downClientX = 0;
    let snapTargetIdx = currentIdx;
    let shownIdx = currentIdx;
    let lastAt = performance.now();
    let starAnimCache = null;

    const particles = effortCore.CODEX_PARTICLES;
    const ticksHtml = steps
      .map(
        (s, idx) =>
          `<span class="ag-cs-codex-tick" data-tick-idx="${idx}" data-on="${idx <= currentIdx ? '1' : '0'}" style="left:${effortCore.codexKnobOffsetOf(effortCore.codexPctFromIndex(idx, count))}" title="${escapeHtml(s.display)}"></span>`
      )
      .join('');

    const starsHtml = particles
      .map((p, idx) => {
        const dur = effortCore.codexStarDurationFor(idx);
        const delay = effortCore.codexStarDelayFor(idx, dur, particles);
        const bright = effortCore.codexStarBrightnessFor(idx);
        return `<span class="ag-cs-codex-star" style="top:${p.y.toFixed(3)}%;animation-duration:${dur.toFixed(3)}s;animation-delay:${delay.toFixed(3)}s"><span class="ag-cs-codex-star-dot" style="--ag-cs-codex-b:${bright.toFixed(3)};opacity:0"></span></span>`;
      })
      .join('');

    const initStep = steps[currentIdx] || steps[0];
    const effortTitle = escapeHtml(ui.effortTitle || 'Reasoning effort');
    pop.innerHTML = `
      <div class="ag-cs-codex-head">
        <span class="ag-cs-codex-title">${effortTitle}</span>
        <span class="ag-cs-codex-value">${escapeHtml(initStep.display)}</span>
      </div>
      <div class="ag-cs-codex-track" role="slider" tabindex="0" aria-label="${effortTitle}" aria-valuemin="0" aria-valuemax="${Math.max(0, count - 1)}" aria-valuenow="${currentIdx}" aria-valuetext="${escapeHtml(initStep.display)}">
        <div class="ag-cs-codex-fill"></div>
        <div class="ag-cs-codex-energy"><div class="ag-cs-codex-sweep"></div></div>
        <div class="ag-cs-codex-stars">${starsHtml}</div>
        ${ticksHtml}
        <div class="ag-cs-codex-knob"></div>
      </div>
    `;

    const valEl = pop.querySelector('.ag-cs-codex-value');
    const track = pop.querySelector('.ag-cs-codex-track');
    const fillEl = pop.querySelector('.ag-cs-codex-fill');
    const energyEl = pop.querySelector('.ag-cs-codex-energy');
    const starsEl = pop.querySelector('.ag-cs-codex-stars');
    const knobEl = pop.querySelector('.ag-cs-codex-knob');
    const tickEls = Array.from(pop.querySelectorAll('.ag-cs-codex-tick'));
    const starTrackEls = Array.from(pop.querySelectorAll('.ag-cs-codex-star'));
    const starDotEls = Array.from(pop.querySelectorAll('.ag-cs-codex-star-dot'));

    const updateStarRates = (pct) => {
      const rate = motionReduced()
        ? Math.max(0.25, effortCore.codexSpeedFor(pct) / 2.6)
        : effortCore.codexSpeedFor(pct);
      if (!starAnimCache) {
        starAnimCache = starTrackEls.map((el) => {
          try {
            const list = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
            return list && list.length > 0 ? list : null;
          } catch {
            return null;
          }
        });
      }
      for (let i = 0; i < starAnimCache.length; i += 1) {
        const anims = starAnimCache[i];
        if (!anims) continue;
        for (let a = 0; a < anims.length; a += 1) {
          try {
            anims[a].playbackRate = rate;
          } catch {}
        }
      }
    };

    const resolveKnobOffset = (pct) => {
      const trackW = track ? track.clientWidth || 0 : 0;
      if (trackW > effortCore.CODEX_KNOB_SIZE) {
        const px = effortCore.CODEX_KNOB_RADIUS + effortCore.codexClamp01(pct) * (trackW - effortCore.CODEX_KNOB_SIZE);
        return `${px.toFixed(2)}px`;
      }
      return effortCore.codexKnobOffsetOf(pct);
    };

    const applyShown = (shownPct, displayIdx) => {
      const clampedPct = effortCore.codexClamp01(shownPct);
      const safeIdx = Math.max(0, Math.min(count - 1, displayIdx));
      const st = steps[safeIdx] || steps[0];
      const energy = effortCore.codexEnergyFor(clampedPct);
      const knobOffset = resolveKnobOffset(clampedPct);

      pop.setAttribute('data-energy', energy > 0 ? '1' : '0');
      pop.style.setProperty('--ag-cs-codex-energy', String(energy));

      if (fillEl) {
        fillEl.style.width = knobOffset;
        fillEl.style.background = effortCore.codexFillBackgroundFor(clampedPct);
      }
      if (energyEl) {
        energyEl.style.width = knobOffset;
      }
      if (starsEl) {
        starsEl.style.width = knobOffset;
        starsEl.style.opacity = effortCore.codexStarLayerOpacityFor(clampedPct).toFixed(3);
      }
      if (knobEl) {
        knobEl.style.left = knobOffset;
      }

      const progress = effortCore.codexStarProgressFor(clampedPct, count);
      const glow = 0.45 + 0.55 * progress;
      for (let s = 0; s < starDotEls.length; s += 1) {
        const dot = starDotEls[s];
        const reveal = effortCore.codexParticleReveal(s, progress, starDotEls.length);
        const bright = effortCore.codexStarBrightnessFor(s) * glow;
        dot.style.setProperty('--ag-cs-codex-b', bright.toFixed(3));
        dot.style.opacity = reveal.toFixed(3);
      }
      updateStarRates(clampedPct);

      for (let t = 0; t < tickEls.length; t += 1) {
        tickEls[t].setAttribute('data-on', t <= safeIdx ? '1' : '0');
      }
      if (valEl && st) {
        if (valEl.textContent !== st.display) valEl.textContent = st.display;
        valEl.style.color = effortCore.codexValueColorFor(clampedPct, st);
      }
      if (track && st) {
        track.setAttribute('aria-valuenow', String(safeIdx));
        track.setAttribute('aria-valuetext', st.display);
      }
    };

    const runMotionLoop = () => {
      cancelCodexMotionRaf();
      const tick = (now) => {
        if (!pop.isConnected || openEffortPop !== pop) {
          codexMotionRaf = 0;
          return;
        }
        const dt = Math.min(0.05, Math.max(0.001, (now - lastAt) / 1000));
        lastAt = now;
        effortCore.codexMotionStep(motion, dt);
        shownIdx = dragging ? effortCore.codexIndexFromPct(motion.x, count) : snapTargetIdx;
        applyShown(motion.x, shownIdx);
        if (!effortCore.codexMotionSettled(motion) && !motionReduced()) {
          codexMotionRaf = requestAnimationFrame(tick);
        } else {
          motion.x = motion.target;
          motion.v = 0;
          motion.a = 0;
          shownIdx = snapTargetIdx;
          applyShown(motion.target, snapTargetIdx);
          codexMotionRaf = 0;
        }
      };
      lastAt = performance.now();
      codexMotionRaf = requestAnimationFrame(tick);
    };

    const setTarget = (targetPct, nextIdx, commit) => {
      const clampedTarget = effortCore.codexClamp01(targetPct);
      const boundedIdx = Math.max(0, Math.min(count - 1, nextIdx));
      snapTargetIdx = boundedIdx;
      motion.target = clampedTarget;

      if (commit) {
        currentIdx = boundedIdx;
        const st = steps[boundedIdx];
        if (st) {
          ctx.selectStep(st, (resolvedDisplay) => {
            if (!pop.isConnected || openEffortPop !== pop) return;
            if (resolvedDisplay && valEl && resolvedDisplay !== valEl.textContent) {
              valEl.textContent = resolvedDisplay;
            }
          });
        }
      }

      const trackW = track ? track.clientWidth || 0 : 0;
      if (motionReduced() || trackW <= 0 || typeof requestAnimationFrame !== 'function') {
        cancelCodexMotionRaf();
        motion.x = clampedTarget;
        motion.v = 0;
        motion.a = 0;
        shownIdx = boundedIdx;
        applyShown(clampedTarget, boundedIdx);
      } else {
        shownIdx = boundedIdx;
        applyShown(motion.x, boundedIdx);
        runMotionLoop();
      }
    };

    pop._syncEffortKnob = () => applyShown(motion.x, shownIdx);
    applyShown(initPct, currentIdx);

    if (track) {
      const pctFromClientX = (clientX) => {
        const r = track.getBoundingClientRect();
        const trackW = track.clientWidth || r.width || 1;
        const zoomScale = trackW > 0 && r.width > 0 ? r.width / trackW : 1;
        const localX = (clientX - r.left) / (zoomScale || 1);
        const usable = Math.max(1, trackW - effortCore.CODEX_KNOB_SIZE);
        return effortCore.codexClamp01((localX - effortCore.CODEX_KNOB_RADIUS) / usable);
      };

      track.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        pointerActive = true;
        dragging = false;
        downClientX = ev.clientX;
        try {
          track.setPointerCapture(ev.pointerId);
        } catch {}
        const pct = pctFromClientX(ev.clientX);
        const idx = effortCore.codexIndexFromPct(pct, count);
        setTarget(pct, idx, false);
      });

      track.addEventListener('pointermove', (ev) => {
        if (!pointerActive) return;
        if (!dragging && Math.abs(ev.clientX - downClientX) >= effortCore.DRAG_THRESHOLD_PX) {
          dragging = true;
          track.classList.add('is-dragging');
        }
        if (!dragging) return;
        const pct = pctFromClientX(ev.clientX);
        const idx = effortCore.codexIndexFromPct(pct, count);
        setTarget(pct, idx, false);
      });

      const finishPointer = (ev) => {
        if (!pointerActive) return;
        pointerActive = false;
        dragging = false;
        track.classList.remove('is-dragging');
        const pct = pctFromClientX(ev.clientX);
        const idx = effortCore.codexIndexFromPct(pct, count);
        setTarget(effortCore.codexPctFromIndex(idx, count), idx, true);
      };

      track.addEventListener('pointerup', finishPointer);
      track.addEventListener('pointercancel', finishPointer);
      track.addEventListener('keydown', (ev) => {
        let next = -1;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = Math.min(count - 1, currentIdx + 1);
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = Math.max(0, currentIdx - 1);
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = count - 1;
        if (next >= 0) {
          ev.preventDefault();
          setTarget(effortCore.codexPctFromIndex(next, count), next, true);
        }
      });
    }
  }

  function renderEffortPopoverContent(pop, modelBtn, badgeEl) {
    if (effortMatrixRaf) {
      cancelAnimationFrame(effortMatrixRaf);
      effortMatrixRaf = 0;
    }
    cancelCodexMotionRaf();
    const lang = getLang();
    const ui = uiText(lang);
    const dark = isDarkTheme();
    const styleMode = effortCore.normalizeEffortStyle(cfg.effortSliderStyle);
    const ctx = resolveModelEffortContext(modelBtn, badgeEl);
    pop.setAttribute('data-effort-style', styleMode);
    pop.setAttribute('data-effort-theme', dark ? 'dark' : 'light');
    pop.setAttribute('data-perf-theme', dark ? 'dark' : 'light');
    pop._syncEffortKnob = null;

    if (styleMode === 'claude') {
      unmountPerfBackdrop();
      let currentIdx = ctx.selectedIdx;
      const count = ctx.steps.length;
      const maxIdx = Math.max(1, count - 1);
      let currentProgress = currentIdx / maxIdx;
      let matrixStartTime = performance.now();
      const matrixState = { field: null };
      let swapClearTimer = null;

      const step = ctx.steps[currentIdx] || ctx.steps[0];
      const isApex = currentIdx === count - 1;
      const pct = effortCore.computeEffortTintPercent(count, currentIdx);
      pop.style.setProperty('--ag-cs-effort-pct', (pct ?? 67) + '%');
      pop.style.setProperty('--ag-cs-effort-step-tint', step.tint);
      pop.style.setProperty('--ag-cs-effort-progress', currentProgress.toFixed(4));
      if (isApex) pop.setAttribute('data-effort-apex', '1');
      else pop.removeAttribute('data-effort-apex');

      const effortTitle = escapeHtml(ui.effortTitle || 'Reasoning effort');
      pop.innerHTML = `
        <div class="ag-cs-effort-head">
          <span class="ag-cs-effort-title">${effortTitle}</span>
          <span class="ag-cs-effort-value-slot">
            <span class="ag-cs-effort-value">${escapeHtml(step.display)}</span>
            <span class="ag-cs-effort-value-preview" aria-hidden="true"></span>
          </span>
        </div>
        <div class="ag-cs-effort-ends">
          <span>${escapeHtml(ui.effortFaster || 'Faster')}</span>
          <span>${escapeHtml(ui.effortSmarter || 'Smarter')}</span>
        </div>
        <div class="ag-cs-effort-track" role="slider" tabindex="0" aria-label="${effortTitle}" aria-valuemin="0" aria-valuemax="${maxIdx}" aria-valuenow="${currentIdx}" aria-valuetext="${escapeHtml(step.display)}">
          <div class="ag-cs-effort-groove">
            <div class="ag-cs-effort-fill"></div>
            <canvas class="ag-cs-effort-matrix"></canvas>
            <div class="ag-cs-effort-ticks">
              ${ctx.steps
                .map(
                  (s, idx) =>
                    `<span class="ag-cs-effort-tick${idx <= currentIdx ? ' is-reached' : ''}" style="left:calc(8px + ${(idx / maxIdx).toFixed(4)} * (100% - 16px))" data-tick-idx="${idx}" data-effort-id="${escapeHtml(s.id)}" title="${escapeHtml(s.display)}"></span>`
                )
                .join('')}
            </div>
          </div>
          <div class="ag-cs-effort-knob"></div>
        </div>
      `;

      const track = pop.querySelector('.ag-cs-effort-track');
      const slotEl = pop.querySelector('.ag-cs-effort-value-slot');
      const valEl = pop.querySelector('.ag-cs-effort-value');
      const previewEl = pop.querySelector('.ag-cs-effort-value-preview');
      const knobEl = pop.querySelector('.ag-cs-effort-knob');
      const canvas = pop.querySelector('.ag-cs-effort-matrix');
      const tickEls = Array.from(pop.querySelectorAll('.ag-cs-effort-tick'));

      const positionKnob = (prog, instant = false) => {
        if (!knobEl) return;
        const applyCoords = () => {
          const trackW = track ? (track.clientWidth || 0) : 0;
          const span = trackW > 16 ? trackW - 16 : 0;
          if (span > 0) {
            knobEl.style.left = '';
            knobEl.style.setProperty('--ag-cs-knob-x', `${(prog * span).toFixed(2)}px`);
          } else {
            knobEl.style.setProperty('--ag-cs-knob-x', '0px');
            knobEl.style.left = `calc(${prog.toFixed(4)} * (100% - 16px))`;
          }
        };
        if (instant) {
          knobEl.style.transition = 'none';
          applyCoords();
          if (knobEl.isConnected) void knobEl.offsetWidth;
          knobEl.style.transition = '';
        } else {
          applyCoords();
        }
      };
      pop._syncEffortKnob = (instant = false) => positionKnob(currentProgress, instant);

      const animateValueSwap = (prevIdx, nextIdx, nextText) => {
        if (!valEl) return;
        const prevText = valEl.textContent || '';
        if (prevText === nextText) return;
        if (slotEl && previewEl && !motionReduced() && prevIdx !== nextIdx) {
          previewEl.textContent = prevText;
          valEl.textContent = nextText;
          slotEl.removeAttribute('data-swap-dir');
          void slotEl.offsetWidth;
          slotEl.setAttribute('data-swap-dir', nextIdx > prevIdx ? 'up' : 'down');
          if (swapClearTimer) clearTimeout(swapClearTimer);
          swapClearTimer = setTimeout(() => {
            if (slotEl.isConnected) slotEl.removeAttribute('data-swap-dir');
          }, 170);
        } else {
          valEl.textContent = nextText;
        }
      };

      const stepLoop = () => {
        if (!pop.isConnected || openEffortPop !== pop) {
          effortMatrixRaf = 0;
          return;
        }
        const st = ctx.steps[currentIdx];
        const apex = currentIdx === count - 1;
        paintEffortMatrixCanvas(canvas, st, apex, matrixStartTime, matrixState);
        if (apex && !motionReduced()) {
          effortMatrixRaf = requestAnimationFrame(stepLoop);
        } else {
          effortMatrixRaf = 0;
        }
      };

      const updateVisual = (prog, idx, commit) => {
        const prevIdx = currentIdx;
        const wasApex = prevIdx === count - 1;
        currentProgress = Math.max(0, Math.min(1, prog));
        currentIdx = Math.max(0, Math.min(count - 1, idx));
        const st = ctx.steps[currentIdx];
        const apex = currentIdx === count - 1;
        const nextPct = effortCore.computeEffortTintPercent(count, currentIdx);
        pop.style.setProperty('--ag-cs-effort-pct', (nextPct ?? 67) + '%');
        pop.style.setProperty('--ag-cs-effort-step-tint', st.tint);
        pop.style.setProperty('--ag-cs-effort-progress', currentProgress.toFixed(4));
        if (apex) pop.setAttribute('data-effort-apex', '1');
        else pop.removeAttribute('data-effort-apex');
        animateValueSwap(prevIdx, currentIdx, st.display);
        positionKnob(currentProgress);
        if (track) {
          track.setAttribute('aria-valuenow', String(currentIdx));
          track.setAttribute('aria-valuetext', st.display);
        }
        tickEls.forEach((tk, i) => {
          if (i <= currentIdx) tk.classList.add('is-reached');
          else tk.classList.remove('is-reached');
        });
        if (apex && !wasApex) {
          matrixStartTime = performance.now();
        }
        paintEffortMatrixCanvas(canvas, st, apex, matrixStartTime, matrixState);
        if (apex && !effortMatrixRaf && !motionReduced()) {
          effortMatrixRaf = requestAnimationFrame(stepLoop);
        } else if (!apex && effortMatrixRaf) {
          cancelAnimationFrame(effortMatrixRaf);
          effortMatrixRaf = 0;
        }
        if (commit) {
          ctx.selectStep(st, (resolvedDisplay) => {
            if (!resolvedDisplay || ctx.steps[currentIdx] !== st) return;
            st.display = resolvedDisplay;
            if (valEl && valEl.isConnected) valEl.textContent = resolvedDisplay;
            if (track && track.isConnected) track.setAttribute('aria-valuetext', resolvedDisplay);
            if (tickEls[currentIdx]) tickEls[currentIdx].setAttribute('title', resolvedDisplay);
          });
        }
      };

      positionKnob(currentProgress, true);
      paintEffortMatrixCanvas(canvas, step, isApex, matrixStartTime, matrixState);
      if (isApex && !motionReduced()) {
        effortMatrixRaf = requestAnimationFrame(stepLoop);
      }

      let lastPointerCommitAt = 0;

      tickEls.forEach((tk) => {
        tk.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (ev.detail > 0 && performance.now() - lastPointerCommitAt < 300) return;
          const idx = Number(tk.getAttribute('data-tick-idx') || 0);
          updateVisual(idx / maxIdx, idx, true);
        });
      });

      if (track) {
        let pointerActive = false;
        let dragging = false;
        let downClientX = 0;
        let lastIdx = currentIdx;

        const resolvePointer = (clientX, applyDamping) => {
          const r = track.getBoundingClientRect();
          const span = Math.max(1, r.width - 16);
          const rawX = Math.max(0, Math.min(span, clientX - r.left - 8));
          const visualX = applyDamping ? effortCore.dampTravel(rawX, span, count) : rawX;
          const prog = visualX / span;
          const nearest = effortCore.nearestStepIndex(rawX, span, count);
          return { prog, nearest };
        };

        track.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          pointerActive = true;
          dragging = false;
          downClientX = ev.clientX;
          lastIdx = currentIdx;
          try {
            track.setPointerCapture(ev.pointerId);
          } catch {}
          const { prog, nearest } = resolvePointer(ev.clientX, true);
          lastIdx = nearest;
          updateVisual(prog, nearest, false);
        });
        track.addEventListener('pointermove', (ev) => {
          if (!pointerActive) return;
          if (!dragging && Math.abs(ev.clientX - downClientX) >= effortCore.DRAG_THRESHOLD_PX) {
            dragging = true;
            track.classList.add('is-dragging');
            knobEl?.setAttribute('data-dragging', '1');
          }
          if (!dragging) return;
          const { prog, nearest } = resolvePointer(ev.clientX, true);
          lastIdx = nearest;
          updateVisual(prog, nearest, false);
        });
        const finishDrag = (ev) => {
          if (!pointerActive) return;
          pointerActive = false;
          const wasDragging = dragging;
          dragging = false;
          track.classList.remove('is-dragging');
          knobEl?.removeAttribute('data-dragging');
          const { nearest } = resolvePointer(ev.clientX, false);
          const finalIdx = wasDragging ? lastIdx : nearest;
          lastPointerCommitAt = performance.now();
          updateVisual(finalIdx / maxIdx, finalIdx, true);
        };
        track.addEventListener('pointerup', finishDrag);
        track.addEventListener('pointercancel', finishDrag);
        track.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const next = Math.min(count - 1, currentIdx + 1);
            updateVisual(next / maxIdx, next, true);
          } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            const next = Math.max(0, currentIdx - 1);
            updateVisual(next / maxIdx, next, true);
          } else if (ev.key === 'Home') {
            ev.preventDefault();
            updateVisual(0, 0, true);
          } else if (ev.key === 'End') {
            ev.preventDefault();
            updateVisual(1, count - 1, true);
          }
        });
      }
    } else if (styleMode === 'chatgpt') {
      renderCodexEffortPopover(pop, ctx, lang);
    } else {
      // Liang Wufeng / Performance Slider style (mobius/dsh-performance-slider)
      const perfCtx = effortCore.resolvePerformancePresets(ctx.fiberProps?.modelOptions, ctx.selectedLabel, ctx.badgeEffort, lang);
      const presets = perfCtx.presets;
      const totalPresets = presets.length;
      const maxFrame = effortCore.PERF_FRAME_COUNT - 1;
      let currentIdx = perfCtx.activeIdx;
      let currentFrame = effortCore.frameForLevel(currentIdx, totalPresets);
      let isDragging = false;

      const activePreset = presets[currentIdx] || presets[0];
      const gridCols =
        totalPresets >= 2
          ? '0.5fr ' + (totalPresets > 2 ? '1fr '.repeat(totalPresets - 2) : '') + '0.5fr'
          : '1fr';

      pop.style.setProperty('--ag-cs-perf-color', activePreset.color);

      const composeCardBackdropCss = (frameUrl, aura, isDark) => {
        if (cfg.performanceBackdrop === 'card' && frameUrl) {
          return isDark
            ? `linear-gradient(180deg, rgba(7,9,14,0.68) 0%, rgba(7,9,14,0.20) 24%, rgba(7,9,14,0.24) 46%, rgba(7,9,14,0.62) 60%, rgba(7,9,14,0.82) 76%, rgba(7,9,14,0.92) 100%), url("${frameUrl}"), ${aura}`
            : `linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.26) 24%, rgba(248,250,252,0.32) 46%, rgba(248,250,252,0.68) 60%, rgba(241,245,249,0.86) 76%, rgba(241,245,249,0.95) 100%), url("${frameUrl}"), ${aura}`;
        }
        if (cfg.performanceBackdrop === 'page') {
          const auraStr = String(aura || '');
          const lgIdx = auraStr.lastIndexOf(', linear-gradient(');
          const softAura = lgIdx >= 0 ? auraStr.slice(0, lgIdx) : auraStr;
          return isDark
            ? `linear-gradient(180deg, rgba(14,17,24,0.24), rgba(14,17,24,0.42))${softAura ? ', ' + softAura : ''}`
            : `linear-gradient(180deg, rgba(255,255,255,0.38), rgba(241,245,249,0.52))${softAura ? ', ' + softAura : ''}`;
        }
        return isDark ? `${effortCore.PERF_SCRIM}, ${aura}` : `linear-gradient(180deg, rgba(255,255,255,0.48), rgba(241,245,249,0.68)), ${aura}`;
      };

      pop.innerHTML = `
        <div class="ag-cs-perf-card-bg" aria-hidden="true"></div>
        <div class="ag-cs-perf-head">
          <span class="ag-cs-perf-kicker">${escapeHtml(ui.perfKicker || 'PERFORMANCE')}</span>
          <span class="ag-cs-perf-meta">${escapeHtml(activePreset.modelShort)} · ${escapeHtml(activePreset.effortDisplay || activePreset.effort)} · frame ${String(currentFrame).padStart(2, '0')}</span>
        </div>
        <div class="ag-cs-perf-bar ag-cs-chatgpt-rail" role="slider" tabindex="0" aria-label="${escapeHtml(ui.perfSliderAria || 'Performance slider')}" aria-valuemin="0" aria-valuemax="${maxFrame}" aria-valuenow="${currentFrame}" aria-valuetext="${escapeHtml(activePreset.fullLabel)}">
          <div class="ag-cs-perf-thumb" style="left:calc(15px + ${(currentFrame / maxFrame).toFixed(4)} * (100% - 30px))"></div>
        </div>
        <div class="ag-cs-perf-ticks" style="grid-template-columns:${gridCols}">
          ${presets
            .map(
              (p, idx) => `
            <button type="button" class="ag-cs-perf-tick${idx === currentIdx ? ' is-active' : ''}" data-step-idx="${idx}" data-effort-id="${escapeHtml(p.effort)}" title="${escapeHtml(p.fullLabel)}">
              <span class="ag-cs-perf-tick-model">${escapeHtml(p.modelShort)}</span>
              <span class="ag-cs-perf-tick-effort">${escapeHtml(p.effortSubtitle)}</span>
            </button>`
            )
            .join('')}
        </div>
      `;

      const bgEl = pop.querySelector('.ag-cs-perf-card-bg');
      const metaEl = pop.querySelector('.ag-cs-perf-meta');
      const bar = pop.querySelector('.ag-cs-perf-bar');
      const thumb = pop.querySelector('.ag-cs-perf-thumb');
      const tickBtns = Array.from(pop.querySelectorAll('.ag-cs-perf-tick'));
      let hasCommittedStatus = false;
      let committedStatusText = '';

      const setPerfStatus = (txt) => {
        let statusEl = pop.querySelector('.ag-cs-perf-status');
        if (!txt) {
          if (statusEl) statusEl.remove();
          return;
        }
        if (!statusEl) {
          statusEl = document.createElement('div');
          statusEl.className = 'ag-cs-perf-status';
          pop.appendChild(statusEl);
        }
        statusEl.textContent = txt;
      };

      const applyVisual = (rawFrameFloat, idx, commit, draggingNow, showStatus = true) => {
        const clampedFloat = Math.max(0, Math.min(maxFrame, rawFrameFloat));
        const frameInt = Math.round(clampedFloat);
        currentFrame = frameInt;
        currentIdx = Math.max(0, Math.min(totalPresets - 1, idx));
        const preset = presets[currentIdx] || presets[0];
        const curDark = isDarkTheme();
        const color = draggingNow ? effortCore.interpolatePerfColor(clampedFloat) : preset.color;
        const aura = curDark ? preset.auraDark : preset.auraLight;
        const frameUrl = perfAssets?.frames?.[frameInt] || '';
        const cardBgCss = composeCardBackdropCss(frameUrl, aura, curDark);

        pop.setAttribute('data-effort-theme', curDark ? 'dark' : 'light');
        pop.setAttribute('data-perf-theme', curDark ? 'dark' : 'light');
        pop.style.setProperty('--ag-cs-perf-color', color);
        if (bgEl) bgEl.style.backgroundImage = cardBgCss;
        syncPerfBackdrop(frameUrl, preset.rgb, curDark);

        if (metaEl) {
          metaEl.textContent = `${preset.modelShort} · ${preset.effortDisplay || preset.effort} · frame ${String(frameInt).padStart(2, '0')}`;
        }
        if (thumb) {
          const prog = clampedFloat / maxFrame;
          thumb.style.left = `calc(15px + ${prog.toFixed(4)} * (100% - 30px))`;
        }
        if (bar) {
          bar.setAttribute('aria-valuenow', String(frameInt));
          bar.setAttribute('aria-valuetext', preset.fullLabel);
        }
        tickBtns.forEach((tb, i) => {
          tb.classList.toggle('is-active', i === currentIdx);
        });
        if (showStatus) {
          const frameStr = String(frameInt).padStart(2, '0');
          const txt = draggingNow
            ? typeof ui.perfPreviewStatus === 'function'
              ? ui.perfPreviewStatus(frameStr, preset.modelShort, preset.effortSubtitle, preset.fullLabel)
              : `Frame ${frameStr} · Release to select ${preset.fullLabel}`
            : typeof ui.perfCommittedStatus === 'function'
              ? ui.perfCommittedStatus(currentIdx + 1, preset.fullLabel)
              : `Preset ${currentIdx + 1}: ${preset.fullLabel}`;
          if (!draggingNow) {
            hasCommittedStatus = true;
            committedStatusText = txt;
          }
          setPerfStatus(txt);
        } else {
          setPerfStatus('');
        }
        if (commit) {
          ctx.selectPreset(preset, (resolvedDisplay) => {
            if (!resolvedDisplay || presets[currentIdx] !== preset) return;
            preset.effortDisplay = resolvedDisplay;
            if (metaEl && metaEl.isConnected) {
              metaEl.textContent = `${preset.modelShort} · ${resolvedDisplay} · frame ${String(frameInt).padStart(2, '0')}`;
            }
          });
        }
      };

      applyVisual(currentFrame, currentIdx, false, false, false);

      tickBtns.forEach((btn) => {
        const showHoverStatus = () => {
          if (isDragging) return;
          const idx = Number(btn.getAttribute('data-step-idx') || 0);
          const p = presets[idx];
          if (!p) return;
          const msg =
            typeof ui.perfHoverStatus === 'function'
              ? ui.perfHoverStatus(idx + 1, p.fullLabel)
              : `Select preset ${idx + 1}: ${p.fullLabel}`;
          setPerfStatus(msg);
        };
        const clearHoverStatus = () => {
          if (isDragging) return;
          setPerfStatus(hasCommittedStatus ? committedStatusText : '');
        };
        btn.addEventListener('pointerenter', showHoverStatus);
        btn.addEventListener('mouseenter', showHoverStatus);
        btn.addEventListener('focus', showHoverStatus);
        btn.addEventListener('pointerleave', clearHoverStatus);
        btn.addEventListener('mouseleave', clearHoverStatus);
        btn.addEventListener('blur', clearHoverStatus);
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const idx = Number(btn.getAttribute('data-step-idx') || 0);
          const f = effortCore.frameForLevel(idx, totalPresets);
          applyVisual(f, idx, true, false, true);
        });
      });

      if (bar) {
        const resolveFrameFromClientX = (clientX) => {
          const r = bar.getBoundingClientRect();
          const span = Math.max(1, r.width - 30);
          const rel = Math.max(0, Math.min(1, (clientX - r.left - 15) / span));
          const fFloat = rel * maxFrame;
          const idx = effortCore.levelForFrame(Math.round(fFloat), totalPresets);
          return { fFloat, idx };
        };

        bar.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          isDragging = true;
          bar.classList.add('is-dragging');
          try {
            bar.setPointerCapture(ev.pointerId);
          } catch {}
          const { fFloat, idx } = resolveFrameFromClientX(ev.clientX);
          applyVisual(fFloat, idx, false, true, true);
        });
        bar.addEventListener('pointermove', (ev) => {
          if (!isDragging) return;
          const { fFloat, idx } = resolveFrameFromClientX(ev.clientX);
          applyVisual(fFloat, idx, false, true, true);
        });
        const finishPerfDrag = (ev) => {
          if (!isDragging) return;
          isDragging = false;
          bar.classList.remove('is-dragging');
          const { idx } = resolveFrameFromClientX(ev.clientX);
          const snapF = effortCore.frameForLevel(idx, totalPresets);
          applyVisual(snapF, idx, true, false, true);
        };
        bar.addEventListener('pointerup', finishPerfDrag);
        bar.addEventListener('pointercancel', finishPerfDrag);
        bar.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const next = Math.min(totalPresets - 1, currentIdx + 1);
            applyVisual(effortCore.frameForLevel(next, totalPresets), next, true, false, true);
          } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            const next = Math.max(0, currentIdx - 1);
            applyVisual(effortCore.frameForLevel(next, totalPresets), next, true, false, true);
          } else if (ev.key === 'Home') {
            ev.preventDefault();
            applyVisual(0, 0, true, false, true);
          } else if (ev.key === 'End') {
            ev.preventDefault();
            applyVisual(maxFrame, totalPresets - 1, true, false, true);
          }
        });
      }
    }
  }

  function positionEffortPopover(pop, anchor) {
    if (!pop) return;
    let target = anchor && anchor.isConnected ? anchor : null;
    if (!target) {
      target = document.querySelector('[data-testid="model-selector-trigger"] .ag-cs-effort-badge, [data-testid="model-selector-trigger"]');
    }
    if (!target) return;
    const aRect = target.getBoundingClientRect();
    const pRect = pop.getBoundingClientRect();
    const vw = window.innerWidth || 900;
    const left = Math.max(8, Math.min(vw - pRect.width - 8, aRect.left + aRect.width / 2 - pRect.width / 2));
    let top = aRect.top - pRect.height - 10;
    if (top < 8) top = aRect.bottom + 10;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function openEffortPopover(badgeEl, modelBtn) {
    const anchor = badgeEl || modelBtn;
    if (!anchor) return;
    if (openEffortPop && (openEffortAnchor === anchor || (modelBtn && modelBtn.contains(openEffortAnchor)))) {
      closeEffortPopover();
      return;
    }
    closeEffortPopover();

    const pop = document.createElement('div');
    pop.className = 'ag-cs-effort-popover';
    pop.setAttribute('data-ag-no-i18n', '');
    openEffortPop = pop;
    openEffortAnchor = anchor;
    openEffortModelBtn = modelBtn || anchor?.closest?.('[data-testid="model-selector-trigger"]') || null;
    openEffortBadgeEl = badgeEl || null;
    document.body.appendChild(pop);
    renderEffortPopoverContent(pop, openEffortModelBtn, openEffortBadgeEl);
    positionEffortPopover(pop, anchor);
    if (typeof pop._syncEffortKnob === 'function') {
      pop._syncEffortKnob(true);
    }
  }

  // ── Smooth Typing Cursor Gliding Animation (.ag-cs-smooth-caret) ───────
  let caretTypingTimer = null;
  let caretRaf = 0;
  let pendingCaretTyping = false;
  const emptyCaretProbeCache = new WeakMap();
  const caretPrevState = new WeakMap();

  function teardownSmoothCarets() {
    if (caretTypingTimer) {
      clearTimeout(caretTypingTimer);
      caretTypingTimer = null;
    }
    if (caretRaf) {
      cancelAnimationFrame(caretRaf);
      caretRaf = 0;
    }
    pendingCaretTyping = false;
    document.querySelectorAll('.ag-cs-smooth-caret').forEach((n) => n.remove());
    document.querySelectorAll('[data-ag-cs-smooth-caret]').forEach((n) => n.removeAttribute('data-ag-cs-smooth-caret'));
    document.querySelectorAll('[data-ag-cs-caret-host]').forEach((n) => n.removeAttribute('data-ag-cs-caret-host'));
  }

  function measureEditorCaretBox(ed) {
    if (!ed) return null;
    const edRect = ed.getBoundingClientRect();
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(ed) : null;
    const padL = parseFloat(cs?.paddingLeft || '8') || 8;
    const padT = parseFloat(cs?.paddingTop || '8') || 8;
    const fontSize = parseFloat(cs?.fontSize || '14') || 14;
    const lineH = parseFloat(cs?.lineHeight || '22') || fontSize * 1.5 || 22;
    const estGlyphH = Math.max(16, Math.min(24, Math.round(fontSize * 1.28)));
    const defaultH = Math.max(16, Math.min(28, lineH));
    const estEmptyTopOffset = padT + Math.max(0, Math.round((defaultH - estGlyphH) / 2));

    const checkScrollBounds = (box) => {
      if (!box || !box.collapsed) return box;
      if ((ed.scrollHeight || 0) > (ed.clientHeight || 0) + 2 && edRect.height > 0) {
        if (box.top < edRect.top - 4 || box.top + box.height > edRect.bottom + 6) {
          return { collapsed: false };
        }
      }
      return box;
    };

    const cacheEmptyProbe = (boxRect) => {
      if (boxRect && boxRect.height > 0 && boxRect.height < 36 && edRect.height > 0) {
        emptyCaretProbeCache.set(ed, {
          dx: boxRect.left - edRect.left,
          dy: boxRect.top - edRect.top,
          height: boxRect.height,
        });
      }
    };

    if (typeof document.getSelection === 'function') {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        if (!sel.isCollapsed) return { collapsed: false };
        const range = sel.getRangeAt(0);
        if (ed.contains && ed.contains(range.startContainer)) {
          const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
          const r0 = rects && rects.length > 0 ? rects[rects.length - 1] : typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
          if (r0 && r0.height > 0 && (r0.left > 0 || r0.top > 0)) {
            return checkScrollBounds({ collapsed: true, left: r0.left, top: r0.top, height: r0.height });
          }

          // Measure empty line / <br> at the exact selection container & offset (never ed.querySelector('br'))
          const sc = range.startContainer;
          const so = range.startOffset;
          if (sc?.nodeName === 'BR' && typeof sc.getBoundingClientRect === 'function') {
            const brRect = sc.getBoundingClientRect();
            if (brRect && brRect.height > 0 && (brRect.left > 0 || brRect.top > 0)) {
              if (!ed.textContent) cacheEmptyProbe(brRect);
              return checkScrollBounds({ collapsed: true, left: brRect.left, top: brRect.top, height: brRect.height });
            }
          }
          if (sc && sc.nodeType === 1) {
            const childAt = sc.childNodes?.[so];
            if (childAt?.nodeName === 'BR' && typeof childAt.getBoundingClientRect === 'function') {
              const brRect = childAt.getBoundingClientRect();
              if (brRect && brRect.height > 0 && (brRect.left > 0 || brRect.top > 0)) {
                if (sc.childNodes.length <= 1 && !ed.textContent) cacheEmptyProbe(brRect);
                return checkScrollBounds({ collapsed: true, left: brRect.left, top: brRect.top, height: brRect.height });
              }
            }
            const childPrev = so > 0 ? sc.childNodes?.[so - 1] : null;
            if (childPrev?.nodeName === 'BR' && typeof childPrev.getBoundingClientRect === 'function') {
              const brRect = childPrev.getBoundingClientRect();
              if (brRect && brRect.height > 0 && (brRect.left > 0 || brRect.top > 0)) {
                const isManagedEmptyLine =
                  (typeof childPrev.hasAttribute === 'function' && childPrev.hasAttribute('data-lexical-managed-linebreak')) ||
                  sc.childNodes.length === 1;
                const scRect = typeof sc.getBoundingClientRect === 'function' ? sc.getBoundingClientRect() : null;
                const lineLeft = scRect && scRect.left > 0 ? scRect.left : brRect.left;
                const lineTop = isManagedEmptyLine ? brRect.top : brRect.bottom;
                const box = { collapsed: true, left: lineLeft, top: lineTop, height: brRect.height };
                if (isManagedEmptyLine && sc.childNodes.length <= 1 && !ed.textContent) cacheEmptyProbe(box);
                return checkScrollBounds(box);
              }
            }
            if (typeof sc.getBoundingClientRect === 'function' && sc !== ed) {
              const scRect = sc.getBoundingClientRect();
              if (scRect && (scRect.left > 0 || scRect.top > 0)) {
                return checkScrollBounds({
                  collapsed: true,
                  left: scRect.left,
                  top: scRect.top,
                  height: Math.min(estGlyphH, scRect.height || estGlyphH),
                });
              }
            }
          }
        }
      }
    }

    const cached = emptyCaretProbeCache.get(ed);
    if (cached) {
      return checkScrollBounds({
        collapsed: true,
        left: edRect.left + cached.dx,
        top: edRect.top + cached.dy,
        height: cached.height,
      });
    }

    return checkScrollBounds({
      collapsed: true,
      left: edRect.left + padL,
      top: edRect.top + estEmptyTopOffset,
      height: estGlyphH,
    });
  }

  function syncSmoothCaret(isTypingEvent = false) {
    if (destroyed || cfg.smoothCaret === false) {
      teardownSmoothCarets();
      return;
    }

    const editors = Array.from(document.querySelectorAll('[data-testid="agent-input-box"] [contenteditable="true"]'));
    const activeEl = document.activeElement;

    for (const ed of editors) {
      const host = ed.parentElement;
      if (!host) continue;
      host.setAttribute('data-ag-cs-caret-host', '1');
      let caret = host.querySelector('.ag-cs-smooth-caret');
      if (!caret) {
        caret = document.createElement('div');
        caret.className = 'ag-cs-smooth-caret';
        caret.setAttribute('aria-hidden', 'true');
        caret.setAttribute('data-ag-no-i18n', '');
        host.appendChild(caret);
      }

      const isFocused = activeEl === ed || (activeEl && ed.contains && ed.contains(activeEl));
      const measured = measureEditorCaretBox(ed);
      if (!measured || !measured.collapsed) {
        caret.removeAttribute('data-ag-cs-caret-visible');
        ed.removeAttribute('data-ag-cs-smooth-caret');
        continue;
      }

      const hostRect = host.getBoundingClientRect();
      const x = Math.round(measured.left - hostRect.left - (host.clientLeft || 0) + (host.scrollLeft || 0));
      const y = Math.round(measured.top - hostRect.top - (host.clientTop || 0) + (host.scrollTop || 0));
      const h = Math.max(15, Math.round(measured.height || 18));
      const wasVisible = caret.getAttribute('data-ag-cs-caret-visible') === '1';
      const cleanText = (ed.textContent || '').replace(/\u200b/g, '');
      const isNowEmpty = cleanText.length === 0 && ed.querySelectorAll('p, div').length <= 1;
      const prev = caretPrevState.get(caret);
      const clearedToEmpty = Boolean(prev && prev.empty === false && isNowEmpty);

      if ((isFocused && !wasVisible) || clearedToEmpty) {
        caret.style.transition = 'none';
        caret.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        caret.style.height = `${h}px`;
        void caret.offsetWidth;
        caret.style.transition = '';
      } else {
        caret.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        caret.style.height = `${h}px`;
      }
      caretPrevState.set(caret, { x, y, h, empty: isNowEmpty });

      if (isFocused) {
        caret.setAttribute('data-ag-cs-caret-visible', '1');
        ed.setAttribute('data-ag-cs-smooth-caret', '1');
        if (isTypingEvent) {
          caret.setAttribute('data-ag-cs-caret-typing', '1');
          if (caretTypingTimer) clearTimeout(caretTypingTimer);
          caretTypingTimer = setTimeout(() => {
            caretTypingTimer = null;
            if (caret.isConnected) caret.removeAttribute('data-ag-cs-caret-typing');
          }, 420);
        } else if (prev && (prev.x !== x || prev.y !== y) && typeof caret.getAnimations === 'function') {
          for (const anim of caret.getAnimations()) {
            if (anim && anim.animationName === 'ag-cs-caret-blink') anim.currentTime = 0;
          }
        }
      } else {
        caret.removeAttribute('data-ag-cs-caret-visible');
        ed.removeAttribute('data-ag-cs-smooth-caret');
      }
    }
  }

  function queueSmoothCaret(isTyping = false, immediate = false) {
    if (destroyed || cfg.smoothCaret === false) return;
    if (isTyping) pendingCaretTyping = true;
    if (immediate) {
      const typingNow = pendingCaretTyping || isTyping;
      pendingCaretTyping = false;
      syncSmoothCaret(typingNow);
    }
    if (caretRaf) cancelAnimationFrame(caretRaf);
    if (typeof requestAnimationFrame === 'function') {
      caretRaf = requestAnimationFrame(() => {
        caretRaf = 0;
        const typingNow = pendingCaretTyping;
        pendingCaretTyping = false;
        syncSmoothCaret(typingNow);
      });
    }
  }

  // ── Composer Footer Widgets (Placeholder, Effort Tag, Inline Stats, Ring, Crab Clearance) ──
  function setCrabClearanceAttr(el, attrName, active) {
    if (!el) return;
    if (active) {
      if (el.getAttribute(attrName) !== '1') el.setAttribute(attrName, '1');
      if (el.style.getPropertyValue('margin-bottom') !== '46px') {
        el.style.setProperty('margin-bottom', '46px', 'important');
      }
    } else if (el.hasAttribute(attrName)) {
      el.removeAttribute(attrName);
      el.style.removeProperty('margin-bottom');
    }
  }

  function syncCrabClearance(card, inputBox, active) {
    if (!inputBox) return;
    const composerShell = card.closest('#antigravity\\.agentSidePanelInputBox') || card.parentElement;
    let hasLowerClearance = false;

    // 0a. Active running-items-panel directly above composer card inside composerShell
    if (composerShell) {
      for (const ch of Array.from(composerShell.children)) {
        if (ch === card) break;
        const panel =
          ch.getAttribute?.('data-testid') === 'running-items-panel'
            ? ch
            : ch.querySelector?.('[data-testid="running-items-panel"]');
        const isActivePanel = Boolean(panel && String(panel.className || '').includes('grid-rows-[1fr]'));
        const shouldClear = active && isActivePanel && !hasLowerClearance;
        setCrabClearanceAttr(ch, 'data-ag-cs-queued', shouldClear);
        if (shouldClear) hasLowerClearance = true;
      }
    }

    // 0b. Queued-Message ("待发消息 / 排队中的消息") & floating banners inside [data-testid="agent-input-box"]
    const ibChildren = Array.from(inputBox.children);
    const shellIdx = ibChildren.indexOf(composerShell);
    const beforeShell = shellIdx >= 0 ? ibChildren.slice(0, shellIdx) : ibChildren;
    for (let i = beforeShell.length - 1; i >= 0; i--) {
      const ch = beforeShell[i];
      if (ch.classList && (ch.classList.contains('ag-cs-hud-top-bar') || ch.classList.contains('ag-cs-hud-bottom-bar'))) {
        continue;
      }
      const hasQueued = ch.childElementCount > 0 || (ch.textContent || '').trim().length > 0;
      const shouldClear = active && hasQueued && !hasLowerClearance;
      setCrabClearanceAttr(ch, 'data-ag-cs-queued', shouldClear);
      if (shouldClear) hasLowerClearance = true;
    }

    // 0c. Takeover Q&A / Permission Card & Side-Question Panel rendered above agent-input-box
    const inputSlot =
      inputBox.parentElement &&
      inputBox.parentElement.classList &&
      inputBox.parentElement.classList.contains('contents')
        ? inputBox.parentElement
        : inputBox;
    const hostWrap = inputSlot.parentElement;
    if (hostWrap) {
      const siblings = Array.from(hostWrap.children);
      const slotIdx = siblings.indexOf(inputSlot);
      for (let i = slotIdx - 1; i >= 0; i--) {
        const sib = siblings[i];
        const isTakeoverOrSideQ =
          sib.getAttribute?.('data-testid') === 'interaction-takeover-card' ||
          sib.getAttribute?.('data-testid') === 'side-question-panel' ||
          Boolean(sib.querySelector?.('[data-testid="interaction-takeover-card"], [data-testid="side-question-panel"]'));
        if (!isTakeoverOrSideQ) {
          if (sib.hasAttribute?.('data-ag-cs-takeover')) {
            setCrabClearanceAttr(sib, 'data-ag-cs-takeover', false);
          }
          continue;
        }
        const shouldClear = active && !hasLowerClearance;
        setCrabClearanceAttr(sib, 'data-ag-cs-takeover', shouldClear);
        if (shouldClear) hasLowerClearance = true;
      }
    }
  }

  function syncComposers() {
    const cards = Array.from(document.querySelectorAll('[data-testid="agent-input-box"] .surface-composer-card'));
    const lang = getLang();
    const ui = uiText(lang);

    // Pick primary card (home card or main conversation card, skipping subagent side panel if main exists)
    let primaryCard = null;
    for (const c of cards) {
      if (!c.closest('[data-testid="subagent-tab-conversation"]')) {
        primaryCard = c;
        break;
      }
    }
    if (!primaryCard && cards.length > 0) primaryCard = cards[0];

    let activeInfoForCrab = null;

    for (const card of cards) {
      const inputBox = card.closest('[data-testid="agent-input-box"]');

      // 0. Fix Queued-Message, Takeover Q&A Card, Side-Question, and Running-Tasks overlap with Clawd Mascot
      syncCrabClearance(card, inputBox, cfg.mascot === 'crab' && card === primaryCard);

      // 1. Studio placeholder override via attribute + ::before
      const p = card.querySelector('div.relative.w-full p.pointer-events-none');
      if (p) {
        if (cfg.composerRestyle !== false && cfg.placeholderStyle === 'studio') {
          const text = ui.studioPlaceholder || 'How can I help you today?';
          if (p.getAttribute('data-ag-cs-placeholder') !== text) {
            p.setAttribute('data-ag-cs-placeholder', text);
          }
        } else {
          p.removeAttribute('data-ag-cs-placeholder');
        }
      }

      // 2. Effort level accent badge inside [data-testid="model-selector-trigger"]
      const modelBtn = card.querySelector('[data-testid="model-selector-trigger"]');
      if (modelBtn) {
        const spans = modelBtn.querySelectorAll('span');
        const sub = spans.length >= 2 ? spans[spans.length - 1] : null;
        if (sub && sub.childElementCount === 0) {
          const txt = (sub.textContent || '').trim().toLowerCase();
          let level = '';
          if (/\bmax\b/.test(txt)) level = 'max';
          else if (/\bxhigh\b/.test(txt)) level = 'xhigh';
          else if (/\bhigh\b/.test(txt)) level = 'high';
          else if (/\bmed(?:ium)?\b/.test(txt)) level = 'medium';
          else if (/\blow\b/.test(txt)) level = 'low';
          else if (/\bextra\b/.test(txt)) level = 'extra';
          if (level) {
            if (sub.getAttribute('data-ag-cs-effort') !== level) sub.setAttribute('data-ag-cs-effort', level);
            sub.classList.add('ag-cs-effort-badge');
          } else {
            if (sub.hasAttribute('data-ag-cs-effort')) sub.removeAttribute('data-ag-cs-effort');
            sub.classList.remove('ag-cs-effort-badge');
          }
        }
      }

      // 3. Remove any residual HUD badges and feed lightweight Clawd activity probe when enabled
      card
        .querySelectorAll('.ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip')
        .forEach((n) => n.remove());
      const composerShell = card.closest?.('#antigravity\\.agentSidePanelInputBox') || card.parentElement;
      if (composerShell && composerShell.hasAttribute('data-ag-cs-rim')) {
        composerShell.removeAttribute('data-ag-cs-rim');
        composerShell.style.removeProperty('--ag-cs-rim-pct');
        composerShell.style.removeProperty('--ag-cs-rim-color');
      }

      if (cfg.mascot === 'crab' && card === primaryCard) {
        const inConvo = Boolean(card.closest('[data-testid="conversation-view"]'));
        const cascadeId = inConvo ? resolveCascadeId(inputBox) : '';
        if (inConvo && cascadeId) {
          const cached = crabStatusCache.get(cascadeId)?.status || null;
          const h = ensureHooks(true);
          const meta = h?.store ? readStoreSummaryMeta(h.store, cascadeId) : null;
          activeInfoForCrab =
            cached ||
            (meta && meta.running ? { isRunning: true, isThinking: false, hasError: false } : null);
          fetchCrabActivity(cascadeId).then((fresh) => {
            if (!destroyed && fresh && card.isConnected) {
              syncCrab(primaryCard, fresh);
            }
          });
        }
      }
    }

    document.querySelectorAll('.ag-cs-turn-bar, .ag-cs-ctx-popover').forEach((n) => n.remove());
    syncCrab(primaryCard, activeInfoForCrab);
    syncSmoothCaret(false);
  }

  // ── Settings Panel Integration ─────────────────────────────────────────
  const SETTINGS_SEC_ID = 'ag-cs-settings-sec';

  function ensureSettingsSection() {
    const lang = getLang();
    const ui = uiText(lang);
    const targetTitles = ['Appearance', '外观', '外觀', '外観'];
    let panel = null;
    for (const h2 of document.querySelectorAll('[role="dialog"] h2')) {
      if (targetTitles.includes((h2.textContent || '').trim())) {
        panel = h2.closest('div.p-6') || h2.parentElement?.parentElement;
        if (panel) break;
      }
    }
    if (!panel) return;
    const syncCondDims = (root) => {
      const curStyle = effortCore.normalizeEffortStyle(cfg.effortSliderStyle);
      root.querySelectorAll('[data-ag-cs-cond]').forEach((row) => {
        const req = row.getAttribute('data-ag-cs-cond');
        if (req && req !== curStyle) row.setAttribute('data-ag-cs-dim', '1');
        else row.removeAttribute('data-ag-cs-dim');
      });
    };
    const existing = document.getElementById(SETTINGS_SEC_ID);
    if (existing) {
      if (panel.querySelector('#' + SETTINGS_SEC_ID) === existing && existing.getAttribute('data-ag-cs-lang') === lang) {
        existing.querySelectorAll('button[data-ag-cs-key]').forEach((btn) => {
          const k = btn.getAttribute('data-ag-cs-key');
          const v = btn.getAttribute('data-ag-cs-val');
          const curVal = k === 'language' ? lang : cfg[k];
          const on = JSON.stringify(curVal) === v;
          if (btn.getAttribute('aria-pressed') !== String(on)) {
            btn.setAttribute('aria-pressed', String(on));
            btn.toggleAttribute('data-pressed', on);
          }
        });
        syncCondDims(existing);
        return;
      }
      existing.remove();
    }
    const sections = Array.from(panel.querySelectorAll('div.space-y-2')).filter(
      (s) => !s.id.startsWith('ag-cs-') && !(s.parentElement && s.parentElement.closest('div.space-y-2'))
    );
    const anchor = sections[sections.length - 1];
    if (!anchor || !anchor.parentElement) return;

    const BTN =
      'inline-flex items-center justify-center transition-colors text-secondary-foreground outline-none cursor-pointer border-none shrink-0 select-none h-full hover:text-foreground data-[pressed]:bg-secondary data-[pressed]:text-foreground text-sm px-2 rounded-md gap-1.5';

    const sec = document.createElement('div');
    sec.id = SETTINGS_SEC_ID;
    sec.className = 'space-y-2';
    sec.setAttribute('data-ag-no-i18n', '');
    sec.setAttribute('data-ag-cs-lang', lang);

    const langOpts = (
      i18nCore?.LANG_OPTIONS || [
        { id: 'zh-CN', label: '简体中文' },
        { id: 'zh-TW', label: '繁體中文' },
        { id: 'yue', label: '粵語' },
        { id: 'en', label: 'English' },
        { id: 'ja', label: '日本語' },
      ]
    ).map((o) => [o.id, o.label]);

    const rowDefs = {
      language: {
        key: 'language',
        title: ui.setLanguageTitle || 'Interface Language',
        desc: ui.setLanguageDesc || 'Switch display language for the entire Antigravity UI and plugin panels.',
        opts: langOpts,
      },
      homeLayout: {
        key: 'homeLayout',
        title: ui.setHomeLayoutTitle || 'Home Layout',
        desc: ui.setHomeLayoutDesc || 'Switch new-conversation home layout.',
        opts: [
          ['studio', ui.optStudio || 'Studio'],
          ['classic', ui.optClassic || 'Classic'],
          ['off', ui.optNativeOff || 'Off'],
        ],
      },
      palette: {
        key: 'palette',
        title: ui.setPaletteTitle || 'Color Palette',
        desc: ui.setPaletteDesc || 'Pick Studio palette or follow host.',
        opts: [
          ['obsidian', ui.optObsidian || 'Obsidian'],
          ['claude', 'Claude'],
          ['host', ui.optHost || 'Host'],
        ],
      },
      logoInk: {
        key: 'logoInk',
        title: ui.setLogoInkTitle || 'Logo Color',
        desc: ui.setLogoInkDesc || 'Tint of the Antigravity greeting mark.',
        opts: [
          ['accent', ui.optAccent || 'Accent'],
          ['foreground', ui.optForeground || 'Ink'],
        ],
      },
      sidebarRestyle: {
        key: 'sidebarRestyle',
        title: ui.setSidebarTitle || 'Sidebar Restyle',
        desc: ui.setSidebarDesc || 'Apply Claude-style row height and hover plates to sidebar.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
      sidebarCompact: {
        key: 'sidebarCompact',
        title: ui.setSidebarCompactTitle || 'Compact Sidebar',
        desc: ui.setSidebarCompactDesc || 'Tighten sidebar row height and spacing to fit more items.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
      composerRestyle: {
        key: 'composerRestyle',
        title: ui.setComposerTitle || 'Composer Restyle',
        desc: ui.setComposerDesc || 'Minimalist rounded input box + canvas footer.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
      placeholderStyle: {
        key: 'placeholderStyle',
        title: ui.setPlaceholderStyleTitle || 'Composer Placeholder',
        desc: ui.setPlaceholderStyleDesc || 'Show Studio placeholder prompt or keep native host copy.',
        opts: [
          ['studio', ui.optPlaceholderStudio || 'Studio'],
          ['host', ui.optPlaceholderHost || 'Host'],
        ],
      },
      effortSliderStyle: {
        key: 'effortSliderStyle',
        title: ui.setEffortStyleTitle || 'Thinking Effort Slider Style',
        desc: ui.setEffortStyleDesc || 'Style of the interactive effort slider popover (Claude Code, ChatGPT Codex, or Liang Wufeng portrait).',
        opts: [
          ['claude', 'Claude Code'],
          ['chatgpt', 'ChatGPT Codex'],
          ['liangwufeng', ui.optLiangWufeng || 'Liang Wufeng'],
        ],
      },
      effortAccent: {
        key: 'effortAccent',
        subRow: true,
        condStyle: 'claude',
        badge: ui.badgeClaude || 'Claude Code',
        title: ui.setEffortAccentTitle || 'Claude Effort Color Accent',
        desc: ui.setEffortAccentDesc || 'Use blue-violet effort tint ramp on Claude slider & pixel matrix.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
      performanceBackdrop: {
        key: 'performanceBackdrop',
        subRow: true,
        condStyle: 'liangwufeng',
        badge: ui.badgeLwf || 'Liang Wufeng',
        title: ui.setPerfBackdropTitle || 'Liang Wufeng Portrait Backdrop',
        desc: ui.setPerfBackdropDesc || 'Where the 31-frame cutout portrait renders in Liang Wufeng mode.',
        opts: [
          ['card', ui.optBackdropCard || 'Card'],
          ['page', ui.optBackdropPage || 'Window'],
          ['off', ui.offLabel || 'Off'],
        ],
      },
      smoothCaret: {
        key: 'smoothCaret',
        title: ui.setSmoothCaretTitle || 'Smooth Typing Caret',
        desc: ui.setSmoothCaretDesc || 'Enable smooth gliding caret interpolation in composer input.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
      mascot: {
        key: 'mascot',
        title: ui.setMascotTitle || 'Pixel Crab Mascot',
        desc: ui.setMascotDesc || 'Show interactive Clawd pixel crab on composer.',
        opts: [
          ['crab', ui.onLabel || 'On'],
          ['off', ui.offLabel || 'Off'],
        ],
      },
      homeRipple: {
        key: 'homeRipple',
        title: ui.setRippleTitle || 'Home Matrix Ripple',
        desc: ui.setRippleDesc || 'Interactive character matrix ripple field on home view.',
        opts: [
          [true, ui.onLabel || 'On'],
          [false, ui.offLabel || 'Off'],
        ],
      },
    };

    const groups = [
      {
        id: 'appearance',
        title: ui.grpAppearance || 'Appearance & Layout',
        keys: ['language', 'homeLayout', 'palette', 'logoInk', 'sidebarRestyle', 'sidebarCompact', 'composerRestyle', 'placeholderStyle'],
      },
      {
        id: 'interaction',
        title: ui.grpInteraction || 'Slider, Caret & Mascot',
        keys: ['effortSliderStyle', 'effortAccent', 'performanceBackdrop', 'smoothCaret', 'mascot', 'homeRipple'],
      },
    ];

    const mkEl = (tag, cls) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      return el;
    };

    const buildRow = (r) => {
      const row = mkEl('div', 'w-full');
      row.setAttribute('data-ag-cs-row', r.key);
      if (r.subRow) row.setAttribute('data-ag-cs-subrow', '1');
      if (r.condStyle) {
        row.setAttribute('data-ag-cs-cond', r.condStyle);
        const curStyle = effortCore.normalizeEffortStyle(cfg.effortSliderStyle);
        if (curStyle !== r.condStyle) row.setAttribute('data-ag-cs-dim', '1');
      }
      const inner = mkEl('div', 'py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center');
      const textCol = mkEl('div', 'flex-1 flex flex-col gap-0.5');
      const titleLine = mkEl('div', 'ag-cs-settings-title-line');
      const tSpan = mkEl('span', 'text-sm');
      tSpan.setAttribute('data-k', 't');
      tSpan.textContent = r.title;
      titleLine.appendChild(tSpan);
      if (r.badge) {
        const badgeSpan = mkEl('span', 'ag-cs-settings-hint-pill');
        badgeSpan.textContent = r.badge;
        titleLine.appendChild(badgeSpan);
      }
      const dSpan = mkEl('span', 'text-xs text-muted-foreground whitespace-pre-wrap');
      dSpan.setAttribute('data-k', 'd');
      dSpan.textContent = r.desc;
      textCol.appendChild(titleLine);
      textCol.appendChild(dSpan);

      const ctlWrap = mkEl('div', 'shrink-0');
      const group = mkEl('div', 'inline-flex items-center rounded-lg border border-border bg-secondary/20 p-0.5 gap-0.5 select-none min-h-8');
      group.setAttribute('role', 'group');
      const curVal = r.key === 'language' ? lang : cfg[r.key];
      for (const [val, lbl] of r.opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = BTN;
        b.textContent = lbl;
        b.setAttribute('data-ag-cs-key', r.key);
        b.setAttribute('data-ag-cs-val', JSON.stringify(val));
        const on = curVal === val;
        b.setAttribute('aria-pressed', String(on));
        if (on) b.setAttribute('data-pressed', '');
        b.addEventListener('click', () => {
          for (const sib of group.children) {
            sib.setAttribute('aria-pressed', String(sib === b));
            sib.toggleAttribute('data-pressed', sib === b);
          }
          saveSetting(r.key, val);
          syncCondDims(sec);
          if (r.key === 'effortSliderStyle' || r.key === 'effortAccent' || r.key === 'performanceBackdrop') {
            refreshOpenEffortPopover();
          }
        });
        group.appendChild(b);
      }
      ctlWrap.appendChild(group);
      inner.appendChild(textCol);
      inner.appendChild(ctlWrap);
      row.appendChild(inner);
      return row;
    };

    const headWrap = mkEl('div', 'flex flex-col gap-1');
    const headRow = mkEl('div', 'flex items-center justify-between');
    const headTitleWrap = mkEl('div', 'flex items-center gap-1.5');
    const h3 = mkEl('h3', 'm-0 text-sm font-medium');
    h3.textContent = 'AGY Claude Style (agy-claude-style)';
    headTitleWrap.appendChild(h3);
    headRow.appendChild(headTitleWrap);
    headWrap.appendChild(headRow);
    sec.appendChild(headWrap);

    const groupsWrap = mkEl('div', 'ag-cs-settings-groups');
    for (const grp of groups) {
      const grpEl = mkEl('div', 'ag-cs-settings-group');
      grpEl.setAttribute('data-ag-cs-group', grp.id);
      const subHead = mkEl('div', 'ag-cs-settings-subhead');
      subHead.textContent = grp.title;
      grpEl.appendChild(subHead);

      const list = mkEl('div', 'bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border');
      for (const k of grp.keys) {
        if (rowDefs[k]) list.appendChild(buildRow(rowDefs[k]));
      }
      grpEl.appendChild(list);
      groupsWrap.appendChild(grpEl);
    }
    sec.appendChild(groupsWrap);
    anchor.parentElement.appendChild(sec);
  }

  // ── Main Synchronization Loop & Global Event Handlers ──────────────────
  let syncQueued = false;
  let syncTimer = null;
  let syncIsRaf = false;

  function cancelScheduledSync() {
    if (syncTimer === null) return;
    try {
      if (syncIsRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(syncTimer);
      } else {
        clearTimeout(syncTimer);
      }
    } catch {}
    syncTimer = null;
    syncQueued = false;
  }

  function isOwnPluginNode(target) {
    const el = target && target.closest ? target : target?.parentElement;
    if (!el || !el.closest) return false;
    return Boolean(
      el.closest(
        '.ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-crab, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, #ag-usage-monitor-capsule, #ag-usage-monitor-portal, #' +
          SETTINGS_SEC_ID +
          ', #ag-claude-style-css'
      )
    );
  }

  function runSync() {
    if (destroyed) return;
    if (openEffortPop && (!openEffortPop.isConnected || !openEffortAnchor || !openEffortAnchor.isConnected)) {
      closeEffortPopover();
    }
    applyRootAttrs();
    const inHero = Boolean(document.querySelector('.agy-home [data-testid="home-greeting"]'));
    syncGreeting(inHero);
    if (inHero && cfg.homeLayout === 'studio') {
      renderHomePanel();
    } else {
      unmountPanelSeat();
    }
    syncRipple();
    syncComposers();
    ensureSettingsSection();
  }

  function scheduleSync() {
    if (destroyed || syncQueued) return;
    syncQueued = true;
    if (!document.hidden && typeof requestAnimationFrame === 'function') {
      syncIsRaf = true;
      syncTimer = requestAnimationFrame(() => {
        syncTimer = null;
        syncQueued = false;
        runSync();
      });
    } else {
      syncIsRaf = false;
      syncTimer = setTimeout(() => {
        syncTimer = null;
        syncQueued = false;
        runSync();
      }, 50);
    }
  }

  function onStoreChanged() {
    const inHero = Boolean(document.querySelector('.agy-home'));
    if (inHero && cfg.homeLayout === 'studio') {
      refreshUsageRollup(false);
    }
    scheduleSync();
  }

  function findClickedEffortBadge(ev) {
    const t = ev?.target;
    if (!t || !t.closest) return null;
    return t.closest('[data-testid="model-selector-trigger"] .ag-cs-effort-badge, [data-testid="model-selector-trigger"] [data-ag-cs-effort]');
  }

  function onDocPointerDown(ev) {
    const effortBadge = findClickedEffortBadge(ev);
    if (effortBadge) {
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      ev.preventDefault();
      return;
    }
    if (openEffortPop && !openEffortPop.contains(ev.target) && (!openEffortAnchor || !openEffortAnchor.contains(ev.target))) {
      closeEffortPopover();
    }
    if (crabState.root) {
      crabState.stage.quietSince = Date.now();
      if (crabState.stage.asleep) {
        crabState.stage.asleep = false;
        crabState.stage.waking = !motionReduced();
        stepCrab();
      }
    }
    queueSmoothCaret(false);
  }

  function onDocMouseDown(ev) {
    const effortBadge = findClickedEffortBadge(ev);
    if (effortBadge) {
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }

  function onDocClick(ev) {
    const effortBadge = findClickedEffortBadge(ev);
    if (effortBadge) {
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      ev.preventDefault();
      const modelBtn = effortBadge.closest('[data-testid="model-selector-trigger"]');
      openEffortPopover(effortBadge, modelBtn);
      return;
    }
    const modelBtn = ev?.target?.closest ? ev.target.closest('[data-testid="model-selector-trigger"]') : null;
    if (modelBtn && openEffortPop) {
      closeEffortPopover();
    }
  }

  function onDocKeyDown(ev) {
    if (ev.key === 'Escape') {
      if (openEffortPop) closeEffortPopover();
    }
  }

  function onDocCaretEvent(ev) {
    const type = ev?.type || '';
    const isTyping = type === 'input' || type === 'keyup' || type === 'compositionupdate' || type === 'compositionend';
    const immediate = type === 'focusin' || type === 'mouseup' || type === 'transitionend';
    queueSmoothCaret(isTyping, immediate);
    if (type === 'input') {
      if (ev?.target?.closest && ev.target.closest('[data-testid="agent-input-box"]')) {
        scheduleSync();
      }
    }
  }

  function onDocTransitionEnd(ev) {
    if (ev?.target?.closest && ev.target.closest('[data-testid="agent-input-box"]')) {
      queueSmoothCaret(false, true);
    }
  }

  function onWindowResize() {
    if (destroyed) return;
    if (openEffortPop && openEffortPop.isConnected) {
      positionEffortPopover(openEffortPop, openEffortAnchor || openEffortModelBtn);
      if (typeof openEffortPop._syncEffortKnob === 'function') {
        openEffortPop._syncEffortKnob(true);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.length > 0 && mutations.every((m) => isOwnPluginNode(m.target))) return;
    if (
      mutations.length > 0 &&
      mutations.every((m) => m.type === 'attributes' && m.target !== document.body && m.target !== document.documentElement)
    ) {
      return;
    }
    scheduleSync();
  });

  const DOC_LISTENERS = [
    ['pointerdown', onDocPointerDown],
    ['mousedown', onDocMouseDown],
    ['click', onDocClick],
    ['keydown', onDocKeyDown],
    ['keyup', onDocCaretEvent],
    ['mouseup', onDocCaretEvent],
    ['input', onDocCaretEvent],
    ['selectionchange', onDocCaretEvent],
    ['focusin', onDocCaretEvent],
    ['focusout', onDocCaretEvent],
    ['scroll', onDocCaretEvent],
    ['compositionupdate', onDocCaretEvent],
    ['compositionend', onDocCaretEvent],
    ['transitionend', onDocTransitionEnd],
  ];

  let pollTimer = null;
  let coreTornDown = false;
  function teardownCore() {
    if (coreTornDown) return;
    coreTornDown = true;
    destroyed = true;
    cancelScheduledSync();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (storeDebounce) {
      clearTimeout(storeDebounce);
      storeDebounce = null;
    }
    if (caretRaf) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(caretRaf);
      caretRaf = 0;
    }
    if (storeUnsub) {
      try {
        storeUnsub();
      } catch {}
      storeUnsub = null;
    }
    try {
      observer.disconnect();
    } catch {}
    for (const [evName, handler] of DOC_LISTENERS) {
      try {
        document.removeEventListener(evName, handler, true);
      } catch {}
    }
    if (typeof window.removeEventListener === 'function') {
      try {
        window.removeEventListener('resize', onWindowResize);
      } catch {}
    }
    if (Array.isArray(globalThis.__agCsCleanups)) {
      const idx = globalThis.__agCsCleanups.indexOf(teardownCore);
      if (idx >= 0) globalThis.__agCsCleanups.splice(idx, 1);
    }
  }

  globalThis.__agCsCleanups = Array.isArray(globalThis.__agCsCleanups) ? globalThis.__agCsCleanups : [];
  globalThis.__agCsCleanups.push(teardownCore);

  let lifecycleStarted = false;
  function startLifecycle() {
    if (destroyed || lifecycleStarted || !document.documentElement) return;
    lifecycleStarted = true;
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    for (const [evName, handler] of DOC_LISTENERS) {
      document.addEventListener(evName, handler, true);
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', onWindowResize);
    }

    pollTimer = setInterval(() => {
      if (destroyed) return;
      applyRootAttrs();
      if (document.querySelector('.agy-home') && cfg.homeLayout === 'studio') {
        refreshUsageRollup(false);
      }
      if (document.querySelector('[data-testid="conversation-view"], [data-testid="agent-input-box"]')) {
        scheduleSync();
      }
    }, Math.max(1500, Number(cfg.pollIntervalMs) || 2500));

    ensureHooks(true);
    applyRootAttrs();
    runSync();
    if (document.querySelector('.agy-home') && cfg.homeLayout === 'studio') {
      refreshUsageRollup(false);
    }
  }

  window.__agClaudeStyle = {
    version: VERSION,
    codeHash: CODE_HASH,
    refreshConfig(next) {
      if (next && typeof next === 'object') {
        cfg = loadSettings({ ...initialConfig, ...next }, { preferBase: true });
      } else {
        try {
          const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || '{}');
          cfg = { ...initialConfig, ...cfg, ...saved };
        } catch {}
      }
      applyRootAttrs();
      refreshOpenEffortPopover();
      runSync();
      scheduleSync();
    },
    openEffortPopover(badgeEl, modelBtn) {
      const b = badgeEl || document.querySelector('[data-testid="model-selector-trigger"] .ag-cs-effort-badge, [data-testid="model-selector-trigger"] [data-ag-cs-effort]');
      const m = modelBtn || b?.closest?.('[data-testid="model-selector-trigger"]') || document.querySelector('[data-testid="model-selector-trigger"]');
      openEffortPopover(b, m);
    },
    getState() {
      return {
        cfg: { ...cfg },
        usageRecordsCount: usageRecords.size,
        hasPanel: Boolean(panelEl && panelEl.isConnected),
        hasRipple: Boolean(rippleMount && rippleMount.canvas.isConnected),
        hasCrab: Boolean(crabState.root && crabState.root.isConnected),
        hasSmoothCaret: Boolean(document.querySelector('.ag-cs-smooth-caret')),
        hasEffortPopover: Boolean(openEffortPop && openEffortPop.isConnected),
      };
    },
    destroy() {
      teardownCore();
      for (const fn of [
        closeEffortPopover,
        teardownSmoothCarets,
        unmountRipple,
        unmountPanelSeat,
        unmountCrab,
        restoreGreetings,
        () => domTranslator && typeof domTranslator.destroy === 'function' && domTranslator.destroy(),
      ]) {
        try {
          fn();
        } catch {}
      }
      document.querySelectorAll('[data-ag-cs-placeholder]').forEach((el) => el.removeAttribute('data-ag-cs-placeholder'));
      document.querySelectorAll('[data-ag-cs-effort]').forEach((el) => {
        el.removeAttribute('data-ag-cs-effort');
        el.classList.remove('ag-cs-effort-badge');
      });
      document.querySelectorAll('[data-ag-cs-queued], [data-ag-cs-takeover]').forEach((el) => {
        el.removeAttribute('data-ag-cs-queued');
        el.removeAttribute('data-ag-cs-takeover');
        el.style.removeProperty('margin-bottom');
      });
      document.querySelectorAll('[data-ag-cs-rim]').forEach((el) => {
        el.removeAttribute('data-ag-cs-rim');
        el.style.removeProperty('--ag-cs-rim-pct');
        el.style.removeProperty('--ag-cs-rim-color');
      });
      document.querySelectorAll('[data-ag-cs-crab-anchor]').forEach((el) => {
        el.removeAttribute('data-ag-cs-crab-anchor');
      });
      document
        .querySelectorAll(
          '.ag-cs-crab, .ag-cs-smooth-caret, .ag-cs-home-panel-seat, .ag-cs-ripple-canvas, .ag-cs-effort-popover, .ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, .ag-cs-perf-backdrop, #' + SETTINGS_SEC_ID
        )
        .forEach((el) => el.remove());
      const html = document.documentElement;
      if (html) {
        for (const attr of [
          'data-ag-cs-style',
          'data-ag-cs-palette',
          'data-ag-cs-home',
          'data-ag-cs-composer',
          'data-ag-cs-logo-ink',
          'data-ag-cs-sidebar',
          'data-ag-cs-sidebar-compact',
          'data-ag-cs-hud-compact',
          'data-ag-cs-effort-accent',
          'data-ag-cs-perf-backdrop',
          'data-ag-cs-lang',
          'data-ag-cs-cjk',
        ]) {
          html.removeAttribute(attr);
        }
      }
    },
  };

  if (document.documentElement) {
    startLifecycle();
  } else if (typeof document.addEventListener === 'function') {
    const onReady = () => {
      if (document.documentElement) {
        document.removeEventListener('readystatechange', onReady);
        document.removeEventListener('DOMContentLoaded', onReady);
        startLifecycle();
      }
    };
    document.addEventListener('readystatechange', onReady);
    document.addEventListener('DOMContentLoaded', onReady);
  }
});
