// ==UserScript==
// @name         安医大课程视频助手
// @namespace    ahmu.course.video.helper
// @version      0.1.1
// @license      AGPL-3.0-or-later
// @description  视频播放辅助、静音倍速与观看区段检查；不包含答题或收费功能
// @match        https://lms.ahmu.edu.cn/course/*
// @match        https://webvpn.ahmu.edu.cn/https/*/course/*
// @grant        unsafeWindow
// @noframes
// @run-at       document-start
// ==/UserScript==


(() => {
  'use strict';
  const courseMatch = location.pathname.match(/^(\/https\/[^/]+)?\/course\/(\d+)\//);
  if (!courseMatch) return;
  const courseBase = `${courseMatch[1] || ''}/course/${courseMatch[2]}`;
  const coursePage = name => location.pathname === `${courseBase}/${name}` || location.pathname === `${courseBase}/${name}/`;
  const courseStorageSuffix = `${courseMatch[1] || 'direct'}:${courseMatch[2]}`;
  const KEY = `ahmuVideoHelperRunning:${courseStorageSuffix}`;
  const RATE_KEY = 'ahmuVideoHelperRate';
  const RECHECK_KEY = `ahmuVideoRecheckOnce:${courseStorageSuffix}`;
  // Reserved for future separate quiz and billing modules. This version has no
  // answer, payment, account, external endpoint, or credential implementation.
  if (window.__ahmuVideoHelperLoaded) return;
  window.__ahmuVideoHelperLoaded = true;
  let running = sessionStorage.getItem(KEY) === 'yes';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const pageDocument = pageWindow.document;
  const documentPrototype = pageWindow.Document.prototype;
  const realHidden = Object.getOwnPropertyDescriptor(documentPrototype, 'hidden')?.get;
  const realHasFocus = documentPrototype.hasFocus;
  const actuallyHidden = () => realHidden ? realHidden.call(pageDocument) : false;
  const actuallyUnfocused = () => actuallyHidden() || !realHasFocus.call(pageDocument);
  // Hooks are installed in the page's document, since GM grants may isolate globals.
  for (const [property, value] of [['hidden', false], ['visibilityState', 'visible'], ['webkitHidden', false], ['webkitVisibilityState', 'visible']]) {
    const descriptor = Object.getOwnPropertyDescriptor(documentPrototype, property);
    try {
      Object.defineProperty(pageDocument, property, { configurable: true, get() { return running ? value : descriptor?.get?.call(pageDocument) ?? value; } });
    } catch (_) {}
  }
  try { pageDocument.hasFocus = () => running ? true : realHasFocus.call(pageDocument); } catch (_) {}
  for (const eventName of ['visibilitychange', 'webkitvisibilitychange']) {
    pageWindow.addEventListener(eventName, event => { if (running) event.stopImmediatePropagation(); }, true);
  }
  pageWindow.addEventListener('blur', event => { if (running && event.target === pageWindow) event.stopImmediatePropagation(); }, true);

  let video = null, handled = false, transition = false, timer = null, monitor = null;
  let manualUntil = 0, lastAttempt = 0, busy = false, waiting = null;
  let recoveryTimer = null, lastPauseAt = 0, repairJob = null;
  let iconTimer = null, iconSyncing = false, iconCandidate = null, iconSince = 0;
  const iconRearmAfter = new WeakMap(), iconLastAttempt = new WeakMap();
  const recoveryDelay = 1500;
  let selectedRate = Number(localStorage.getItem(RATE_KEY)) || 1;
  if (![1, 1.25, 1.5, 2].includes(selectedRate)) selectedRate = 1;
  let status, toggle, rate;
  const display = message => { if (status) status.textContent = message; if (toggle) toggle.textContent = running ? '停止' : '开始'; };
  function stop(message) {
    running = false; repairJob = null; sessionStorage.removeItem(KEY); sessionStorage.removeItem(RECHECK_KEY); clearTimeout(timer); clearTimeout(recoveryTimer); clearTimeout(iconTimer); iconSyncing = false; transition = false; waiting = null;
    display(message);
  }
  function isVisible(el) { return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }
  function activeVideo() { return [...document.querySelectorAll('video')].find(isVisible) || null; }
  function applySettings() {
    if (!running || !video) return;
    if (!video.muted) video.muted = true;
    if (video.playbackRate !== selectedRate) video.playbackRate = selectedRate;
  }
  function playControl(element) {
    // Site controls can be siblings of the Video.js element.
    for (let root = element; root && root !== document.body; root = root.parentElement) {
      // The site's controls may be hidden until the pointer enters the player.
      const controls = [...root.querySelectorAll('.mvp-toggle-play')];
      if (controls.length === 1) return controls[0];
      if (controls.length > 1) return null;
    }
    return null;
  }
  function unreadProgress(element) {
    const control = playControl(element);
    const holder = control?.closest('.mvp-replay-player-all-controls')?.querySelector('.mvp-progress-holder');
    if (!holder || !holder.isConnected) return null;
    const segments = [...holder.querySelectorAll('.mvp-unplayed-progress')];
    return { count: segments.length };
  }
  function activityState() {
    try {
      const controller = document.querySelector('[ng-controller="ViewOnlineVideoController"], [ng-controller="OnlineVideoFullscreenController"]');
      let scope = controller && pageWindow.angular?.element(controller).scope();
      let activityId = null, loaded = null, segmentsKnown = false;
      for (let depth = 0; scope && depth < 30; depth++, scope = scope.$parent) {
        if (activityId === null && scope.activity?.id != null) activityId = String(scope.activity.id);
        if (loaded === null && scope.activityReadLoaded != null) loaded = scope.activityReadLoaded === true;
        if (scope.unplayedSegments != null) segmentsKnown = true;
      }
      return { activityId, loaded, segmentsKnown };
    } catch (_) { return { activityId: null, loaded: null, segmentsKnown: false }; }
  }
  function videoPlayer(element) {
    const container = element.closest('.video-js');
    try {
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const videojs = pageWindow.videojs;
      const getPlayer = videojs?.getPlayer;
      const player = container?.player || element.player ||
        (typeof getPlayer === 'function' && ((container?.id && getPlayer.call(videojs, container.id)) ||
          (element.id && getPlayer.call(videojs, element.id))));
      return player && typeof player.play === 'function' && !player.isDisposed?.() ? player : null;
    } catch (_) { return null; }
  }
  function checkPlaybackIcon() {
    const target = video;
    if (!running || !target || !target.isConnected || target.paused || target.ended || target.seeking ||
        (transition && !repairJob) || waiting || iconSyncing || Date.now() < manualUntil) {
      iconCandidate = null; return;
    }
    const control = playControl(target), player = videoPlayer(target);
    let playerPaused;
    try { playerPaused = typeof player?.paused === 'function' ? player.paused() : null; } catch (_) { playerPaused = null; }
    if (!control || !control.isConnected || document.querySelectorAll('.mvp-toggle-play').length !== 1 || control.disabled ||
        control.getAttribute('aria-label') !== '播放' || playerPaused !== false) {
      iconCandidate = null; return;
    }
    const lastSync = iconLastAttempt.get(target);
    if (lastSync !== undefined && Date.now() - lastSync < 10000) {
      iconCandidate = null;
      display('按钮状态异常，稍候重新检查同步。'); return;
    }
    if (iconCandidate !== target) { iconCandidate = target; iconSince = Date.now(); return; }
    if (Date.now() - iconSince < 3000) return;
    // Synchronize repeated mismatches with a cooldown; rewind has its own guard.
    iconLastAttempt.set(target, Date.now()); iconCandidate = null; iconSyncing = true;
    display('播放器按钮状态不一致，尝试一次同步…');
    try { control.click(); } catch (_) { iconSyncing = false; stop('按钮同步失败，请手动核对播放器。'); return; }
    iconTimer = setTimeout(() => {
      iconSyncing = false;
      if (!running || video !== target || !target.isConnected || Date.now() < manualUntil) return;
      if (target.paused) { stop('按钮同步后视频已暂停，请手动恢复播放并检查观看进度。'); return; }
      const current = playControl(target);
      let paused = null;
      try { const p = videoPlayer(target); paused = typeof p?.paused === 'function' ? p.paused() : null; } catch (_) {}
      if (current === control && current.getAttribute('aria-label') === '暂停' && paused === false) {
        if (target.seeking || (transition && !repairJob) || waiting || !Number.isFinite(target.currentTime)) {
          display('按钮已同步，但播放器正在切换，未自动回退。'); return;
        }
        const from = target.currentTime;
        const rearmAt = iconRearmAfter.get(target);
        if (rearmAt !== undefined && from < rearmAt) {
          display('按钮已重新同步；正在重播上次回退的区段。'); return;
        }
        iconRearmAfter.set(target, from + 1);
        const rewindSeconds = repairJob ? 30 : 60;
        let destination = Math.max(0, from - rewindSeconds);
        try {
          const ranges = target.seekable;
          if (ranges && ranges.length) {
            let range = -1;
            for (let i = 0; i < ranges.length; i++) if (from >= ranges.start(i) && from <= ranges.end(i)) { range = i; break; }
            if (range < 0) { display('按钮已同步，无法确认可回退范围，请手动检查。'); return; }
            destination = Math.max(destination, ranges.start(range));
          }
          if (from - destination > 0.5) target.currentTime = destination;
          display(`按钮已同步，已回退最多 ${rewindSeconds} 秒重播；平台记录状态未知。`);
        } catch (_) { display('按钮已同步，但回退失败，请手动检查观看进度。'); }
      } else stop('按钮同步结果无法确认，已停止助手，请手动核对。');
    }, 1500);
  }
  function videoSource(element) {
    return element.currentSrc || element.src || element.querySelector('source[src]')?.src || '';
  }
  async function play() {
    if (!running || !video || busy) return;
    if (video.ended) { display('已找到视频，但视频已经结束；请检查观看进度。'); return; }
    const target = video, player = videoPlayer(target);
    display(target.paused ? '已找到视频，正在尝试播放…' : '已找到视频，媒体未暂停；平台记录状态未知');
    busy = true; lastAttempt = Date.now();
    try {
      applySettings();
      // Prefer the site's own toggle: its state and progress handlers may live
      // outside the Video.js instance. Only click when the media is paused.
      const control = playControl(target);
      if (target.paused && control && !control.disabled) {
        control.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!running || video !== target) return;
      if (target.paused && player) {
        try { await player.play(); } catch (_) { /* Try the media element below. */ }
      }
      if (target.paused) await target.play();
      if (running && video === target) display(target.paused ? '视频仍处于暂停状态。' : `媒体播放中 · 视频静音 · ${selectedRate} 倍；平台记录状态未知`);
    } catch { if (running && video === target) display('自动播放受阻，请在播放器上手动点击播放。'); }
    finally { busy = false; }
  }
  function onPause() {
    if (!running || !video || video.ended || transition || waiting || iconSyncing) return;
    if (Date.now() < manualUntil && !actuallyUnfocused()) {
      stop('已检测到手动操作并停止助手；可再次点击开始。');
    } else if (actuallyUnfocused()) {
      const target = video;
      lastPauseAt = Date.now();
      clearTimeout(recoveryTimer);
      display('后台播放暂停，等待播放器处理后恢复…');
      // Let the player's pause listeners run before triggering play or seeking.
      recoveryTimer = setTimeout(() => {
        if (running && video === target && target.isConnected && target.paused && !target.ended &&
            !target.seeking && !transition && !waiting && Date.now() >= manualUntil) void play();
      }, recoveryDelay);
    } else display('视频已暂停；可手动播放或重新开始。');
  }
  function onSettingChange() { if (running) applySettings(); }
  function attach(next) {
    if (video === next) return;
    clearTimeout(recoveryTimer);
    clearTimeout(iconTimer); iconSyncing = false; iconCandidate = null;
    lastPauseAt = 0;
    if (video) {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ratechange', onSettingChange);
      video.removeEventListener('volumechange', onSettingChange);
    }
    video = next; handled = false;
    if (video) {
      video.addEventListener('ended', onEnded);
      video.addEventListener('pause', onPause);
      video.addEventListener('ratechange', onSettingChange);
      video.addEventListener('volumechange', onSettingChange);
      applySettings();
    }
  }
  function startNext(current) {
    attach(current); handled = false; transition = true;
    const source = videoSource(current), url = location.href;
    let attempts = 0;
    display('正在等待新视频播放器准备…');
    const prepare = () => {
      if (!running || video !== current) return;
      if (!current.isConnected || videoSource(current) !== source || location.href !== url) {
        transition = false; stop('视频状态再次改变，请检查当前活动。'); return;
      }
      const player = videoPlayer(current), control = playControl(current);
      if ((!player || !control || control.disabled || current.readyState < 1) && ++attempts < 30) {
        timer = setTimeout(prepare, 500); return;
      }
      if (!player || !control || control.disabled || current.readyState < 1) {
        transition = false;
        stop('新播放器尚未准备好，请刷新页面并手动启动。'); return;
      }
      transition = false;
      if (!current.paused) { display('新视频媒体未暂停，播放器按钮状态需手动核对。'); return; }
      void play();
    };
    timer = setTimeout(prepare, 500);
  }
  function onEnded() {
    if (!running || handled || transition || waiting) return;
    handled = true; transition = true;
    const oldUrl = location.href, oldVideo = video, oldSource = videoSource(video);
    display('视频结束，等待后刷新并核对平台区段…');
    timer = setTimeout(() => {
      if (!running) return;
      if (video !== oldVideo || location.href !== oldUrl || videoSource(oldVideo) !== oldSource || !oldVideo.ended) {
        stop('视频或页面已变化，无法确认要核对的活动。'); return;
      }
      const state = activityState();
      if (!state.activityId) { stop('无法确认当前视频活动，未自动刷新，请检查进度。'); return; }
      try {
        sessionStorage.setItem(RECHECK_KEY, JSON.stringify({ url: oldUrl, activityId: state.activityId, created: Date.now() }));
        location.reload();
      } catch (_) { stop('无法保存核对状态或刷新，请手动检查进度。'); }
    }, 5000);
  }
  function repairFirstSegment(current, activityId, attempt = 0) {
    if (!running || !current || video !== current || !current.isConnected || !activityId) return;
    if (attempt >= 3) { stop('补看后仍有黄色区段，已停止自动重试，请检查平台进度。'); return; }
    const control = playControl(current);
    const holder = control?.closest('.mvp-replay-player-all-controls')?.querySelector('.mvp-progress-holder');
    const segment = holder?.querySelector('.mvp-unplayed-progress');
    const track = holder?.getBoundingClientRect(), mark = segment?.getBoundingClientRect(), duration = current.duration;
    if (!track || !mark || !Number.isFinite(duration) || duration <= 0 || track.width < 20 || mark.width <= 0 ||
        mark.left < track.left - 2 || mark.right > track.right + 2) {
      stop('无法可靠估算黄色区段的位置，请手动检查进度条。'); return;
    }
    const start = Math.max(0, (mark.left - track.left) / track.width * duration - 30);
    if (!Number.isFinite(start) || start >= duration) { stop('黄色区段位置异常，未开始补看。'); return; }
    const url = location.href, source = videoSource(current), job = {};
    repairJob = job; transition = true; handled = true;
    display(`从黄色区段前约 30 秒开始补看，播放至视频结尾（第 ${attempt + 1} 次）…`);
    try {
      if (!current.paused) current.pause();
      current.currentTime = start;
    } catch (_) { stop('无法跳转到黄色区段附近，请手动检查。'); return; }
    let playAttempts = 0, lastTime = start, lastAdvance = Date.now();
    current.addEventListener('seeked', () => {
      if (running && repairJob === job && transition && video === current && current.isConnected && current.paused && !current.ended) void play();
    }, { once: true });
    function tick() {
      if (!running || repairJob !== job || !transition) return;
      if (video !== current || !current.isConnected || location.href !== url || videoSource(current) !== source) {
        stop('视频或页面已变化，已停止补看。'); return;
      }
      if (!iconSyncing && !current.seeking && current.ended) {
        repairJob = null;
        try { if (!current.paused) current.pause(); } catch (_) {}
        display('补看结束，等待平台上报后刷新核对…');
        timer = setTimeout(() => {
          if (!running || video !== current || location.href !== url || activityState().activityId !== activityId) {
            if (running) stop('视频状态已变化，请手动检查进度。'); return;
          }
          try {
            sessionStorage.setItem(RECHECK_KEY, JSON.stringify({ url, activityId, created: Date.now(), repairAttempt: attempt + 1 }));
            location.reload();
          } catch (_) { stop('无法刷新核对，请手动检查进度。'); }
        }, 5000);
        return;
      }
      if (!current.seeking && current.paused && !iconSyncing) {
        if (!busy && ++playAttempts > 3) { stop('补看期间视频无法继续播放，请手动检查。'); return; }
        if (!busy) void play();
      } else if (!current.paused && !iconSyncing) {
        playAttempts = 0;
        checkPlaybackIcon();
      }
      if (Math.abs(current.currentTime - lastTime) > 0.2) { lastTime = current.currentTime; lastAdvance = Date.now(); }
      else if (Date.now() - lastAdvance > 30000) { stop('补看期间视频长时间未前进，请检查页面。'); return; }
      timer = setTimeout(tick, 2000);
    }
    timer = setTimeout(tick, 1000);
  }
  function nextVideoLink(activityId) {
    try {
      const rows = [...document.querySelectorAll('.module-list.full-screen li.activity')];
      const entries = rows.map(row => {
        const activity = pageWindow.angular?.element(row).scope()?.activity;
        const link = row.querySelector('a.activity-title[ng-click]');
        return activity && activity.id != null && activity.type && link ? { id: String(activity.id), type: activity.type, link } : null;
      });
      if (!entries.length || entries.some(entry => !entry)) return null;
      const indices = entries.map((entry, index) => entry.id === activityId ? index : -1).filter(index => index >= 0);
      if (indices.length !== 1) return null;
      const next = entries.slice(indices[0] + 1).find(entry => entry.type === 'online_video');
      return next && !next.link.classList.contains('locked') ? next.link : null;
    } catch (_) { return null; }
  }
  function recheckAfterReload(marker) {
    transition = true;
    display('已刷新，正在等待平台加载观看区段…');
    let attempts = 0, stable = 0, previous = null;
    function check() {
      if (!running) return;
      if (location.href !== marker.url) { stop('页面已变化，无法确认刷新后的视频。'); return; }
      const state = activityState(), current = activeVideo();
      if (state.activityId && state.activityId !== marker.activityId) {
        stop('刷新后活动已改变，已停止自动切换。'); return;
      }
      if (current && state.activityId === marker.activityId) attach(current);
      const progress = current && current.readyState >= 1 && state.activityId === marker.activityId &&
        state.loaded && state.segmentsKnown ? unreadProgress(current) : null;
      if (progress) {
        stable = previous === progress.count ? stable + 1 : 1;
        previous = progress.count;
        if (stable >= 3) {
          if (progress.count) {
            repairFirstSegment(current, marker.activityId, Number.isInteger(marker.repairAttempt) ? marker.repairAttempt : 0);
            return;
          }
          const next = nextVideoLink(marker.activityId);
          if (!next) { stop('没有找到可确认的下一个视频，或侧栏数据不完整；请检查课程列表。'); return; }
          attach(current);
          waiting = { oldVideo: current, oldSource: videoSource(current), oldUrl: location.href, candidate: null, source: '', url: '', stable: 0 };
          transition = false;
          next.click(); display('刷新后未检测到黄色区段，正在跳过测试并打开下一个视频…'); return;
        }
      } else { stable = 0; previous = null; }
      if (++attempts >= 30) { stop('刷新后无法确认平台区段已加载，已停止切换。'); return; }
      timer = setTimeout(check, 1000);
    }
    check();
  }
  function mount() {
    const host = document.createElement('div'); host.id = 'ahmu-video-helper';
    host.style.cssText = 'position:fixed;z-index:2147483646;right:16px;bottom:65px';
    const shadow = host.attachShadow({mode:'closed'});
    const panel = document.createElement('div');
    panel.style.cssText = 'font:14px sans-serif;background:white;color:#222;padding:12px;border-radius:8px;box-shadow:0 2px 12px #0005;width:250px;line-height:1.5';
    const title = document.createElement('strong'); title.textContent = '安医大视频助手';
    status = document.createElement('div');
    const label = document.createElement('label'); label.textContent = '视频倍速：';
    rate = document.createElement('select');
    for (const n of [1, 1.25, 1.5, 2]) { const option = document.createElement('option'); option.value = String(n); option.textContent = `${n}×`; rate.append(option); }
    rate.value = String(selectedRate); label.append(rate);
    rate.addEventListener('change', () => { selectedRate = Number(rate.value); localStorage.setItem(RATE_KEY, String(selectedRate)); applySettings(); if (running) display(`播放设置：视频静音 · ${selectedRate} 倍`); });
    toggle = document.createElement('button');
    toggle.style.cssText = 'display:block;background:#165dcc;border:0;border-radius:5px;color:white;padding:7px 12px;cursor:pointer;margin-top:8px';
    const warning = document.createElement('div');
    warning.style.cssText = 'color:#9a4c00;margin-top:6px';
    const repair = document.createElement('button');
    repair.textContent = '补看黄色区段';
    repair.style.cssText = 'display:block;margin-top:8px;padding:6px 10px;cursor:pointer';
    repair.addEventListener('click', () => {
      if (running) { display('请先停止助手，再开始补看黄色区段。'); return; }
      const current = activeVideo(), state = activityState();
      if (!current || !state.activityId || !state.loaded || !state.segmentsKnown) {
        display('视频或平台观看区段尚未加载，请稍候再试。'); return;
      }
      attach(current);
      running = true; sessionStorage.setItem(KEY, 'yes');
      repairFirstSegment(current, state.activityId, 0);
    });
    panel.append(title, status, label, toggle, repair, warning); shadow.append(panel); document.documentElement.append(host);
    display(running ? '正在查找视频，请稍候…' : '选择倍速后点击开始。');
    toggle.addEventListener('click', () => {
      if (running) { stop('已停止助手，播放器可手动控制。'); return; }
      attach(activeVideo());
      if (!video) {
        if (coursePage('content') || coursePage('courseware')) {
          running = true; sessionStorage.setItem(KEY, 'yes'); handled = false;
          if (coursePage('courseware')) { initial(); return; }
          waiting = { oldVideo: null, oldSource: '', oldUrl: location.href, candidate: null, source: '', url: '', stable: 0 };
          display('正在章节列表中查找未完成的视频…'); return;
        }
        display('没有找到视频，请先打开视频活动。'); return;
      }
      running = true; sessionStorage.setItem(KEY, 'yes'); handled = false; applySettings(); void play();
    });
    document.addEventListener('pointerdown', event => {
      if (!video || !event.isTrusted) return;
      const control = playControl(video);
      if (transition && (event.target === video || video.closest('.video-js')?.contains(event.target) ||
          control?.closest('.mvp-replay-player-all-controls')?.contains(event.target))) {
        stop('检测到手动播放器操作，已停止自动核对和切换。'); return;
      }
      if (control && (event.target === control || control.contains(event.target))) {
        // Do not immediately resume a pause deliberately requested by the user.
        manualUntil = Date.now() + 2000;
        if (running) stop('检测到手动播放控制，助手已停止。');
      } else if (event.target === video || video.closest('.video-js')?.contains(event.target)) {
        manualUntil = Date.now() + 2000;
      }
    }, true);
    let tries = 0, listCandidate = null, listStable = 0, listClicked = false;
    function findUnfinishedVideo() {
      if (!coursePage('content') || !pageWindow.angular) return null;
      const rows = [...document.querySelectorAll('.learning-activity[id^="learning-activity-"]')];
      for (const row of rows) {
        let activity;
        try { activity = pageWindow.angular.element(row).scope()?.activity; } catch (_) { return null; }
        if (!activity || activity.type == null) return null;
        if (activity.type !== 'online_video') continue;
        const tip = typeof activity.completenessTip === 'string' ? activity.completenessTip : '';
        const completion = row.querySelector('.completeness');
        if (!completion || !tip) return null;
        if (/未完成|部分完成/.test(tip)) {
          const link = row.querySelector('.clickable-area');
          if (!link || !row.id || !isVisible(link)) return null;
          return { id: row.id, link };
        }
        if (!/已完成/.test(tip)) return null;
      }
      return null;
    }
    function initial() {
      if (!running) { display('选择倍速后点击开始。'); return; }
      if (coursePage('courseware')) {
        display('正在打开章节列表，查找未完成的视频…');
        location.assign(`${courseBase}/content#/`);
        return;
      }
      const found = activeVideo();
      if (found) { attach(found); void play(); return; }
      if (++tries < 30) { timer = setTimeout(initial, 500); return; }
      waiting = { oldVideo: null, oldSource: '', oldUrl: location.href, candidate: null, source: '', url: '', stable: 0 };
      display('等待视频活动；可能已进入测试，请手动检查平台进度。');
    }
    let lastMonitorAt = Date.now(), previousVideo = null, previousTime = null, stalledSince = null;
    // A background timer may be delayed: also check when the page regains focus.
    const resumeAfterFocus = () => {
      if (running && !transition && !waiting && !iconSyncing && video?.isConnected && video.paused && !video.ended && !video.seeking && Date.now() >= manualUntil && Date.now() - lastPauseAt >= recoveryDelay) void play();
    };
    pageWindow.addEventListener('focus', resumeAfterFocus, true);
    monitor = setInterval(() => {
      const now = Date.now(), gap = now - lastMonitorAt;
      lastMonitorAt = now;
      if (!running) { previousVideo = null; previousTime = null; stalledSince = null; return; }
      if (gap > 15000) warning.textContent = '页面长时间未响应，观看记录可能不完整，请检查进度。';
      if (transition) return;
      if (video && video.isConnected && !video.ended && !video.paused && video === previousVideo && previousTime !== null) {
        if (Math.abs(video.currentTime - previousTime) < 0.1) {
          if (stalledSince === null) stalledSince = now;
          if (now - stalledSince >= 15000) warning.textContent = '检测到视频时间长时间未前进，请检查网络和观看进度。';
        } else stalledSince = null;
      } else stalledSince = null;
      previousVideo = video; previousTime = video?.currentTime ?? null;
      if (waiting) {
        if (!listClicked && coursePage('content')) {
          const candidate = findUnfinishedVideo();
          if (candidate && candidate.id === listCandidate) listStable++;
          else { listCandidate = candidate?.id || null; listStable = candidate ? 1 : 0; }
          if (candidate && listStable >= 3) {
            listClicked = true;
            display('找到首个可确认的未完成视频，正在打开…');
            candidate.link.click();
            return;
          }
          if (!candidate) display('未能确认未完成视频，请展开章节并检查完成状态。');
        }
        const current = activeVideo(), source = current ? videoSource(current) : '', url = location.href;
        const changed = current && source && !current.ended && (!waiting.oldVideo ||
          (current === waiting.oldVideo ? waiting.oldSource && source !== waiting.oldSource :
            url !== waiting.oldUrl || (waiting.oldSource && source !== waiting.oldSource)));
        if (!changed) { waiting.candidate = null; waiting.stable = 0; return; }
        if (current === waiting.candidate && source === waiting.source && url === waiting.url) waiting.stable++;
        else { waiting.candidate = current; waiting.source = source; waiting.url = url; waiting.stable = 1; }
        if (waiting.stable >= 2) {
          waiting = null; startNext(current);
        }
        return;
      }
      if (!video) return;
      if (!video.isConnected) {
        waiting = { oldVideo: video, oldSource: videoSource(video), oldUrl: location.href, candidate: null, source: '', url: '', stable: 0 };
        display('视频已切换，等待可确认的新视频。'); return;
      }
      applySettings();
      if (video.paused && !video.ended && !video.seeking && !iconSyncing && actuallyUnfocused() && now - lastPauseAt >= recoveryDelay && now - lastAttempt > 5000) void play();
      else checkPlaybackIcon();
    }, 3000);
    const savedRecheck = sessionStorage.getItem(RECHECK_KEY);
    if (savedRecheck) {
      sessionStorage.removeItem(RECHECK_KEY); // Consume before checking; a further reload cannot repeat it.
      let marker;
      try { marker = JSON.parse(savedRecheck); } catch (_) { marker = null; }
      if (!running || !marker || typeof marker.url !== 'string' || typeof marker.activityId !== 'string' ||
          !Number.isFinite(marker.created) || Date.now() - marker.created < 0 || Date.now() - marker.created > 600000 || marker.url !== location.href) {
        stop('刷新核对状态无效或页面已变化，请手动检查进度。');
      } else recheckAfterReload(marker);
    } else initial();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(recoveryTimer); clearTimeout(iconTimer); clearInterval(monitor); });
})();

