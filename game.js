/*
 * 드라이브 하트 — 비주얼 노벨 엔진
 * 스토리·대사·선택지·호감도·엔딩은 전부 story.json에 있습니다.
 * 이 파일은 story.json을 읽어서 화면에 그려주기만 합니다.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALBUM_KEY = 'driveheart.endings';
  const FADE_MS = 350;

  let story = null;
  let state = null;
  let typing = null;   // 타자 효과 진행 상태
  let autoTimer = null;
  let busy = false;    // 화면 전환 중에는 입력 무시

  // ---------- 상태 ----------
  function newState() {
    const aff = {};
    for (const id of Object.keys(story.characters)) aff[id] = story.affection?.initial ?? 0;
    return { sceneId: null, lineIndex: 0, affection: aff, onStage: [], bg: null,
             waiting: false, auto: false, log: [], endingChar: null };
  }

  const settings = () => Object.assign({ textSpeed: 28, autoDelay: 1400 }, story.settings);
  const fillVars = (s) => String(s ?? '').replace(/\{player\}/g, story.meta?.playerName || '나');

  // ---------- 장면 진행 ----------
  function goto(sceneId) {
    if (sceneId === 'ENDING') sceneId = pickEnding();
    const scene = story.scenes[sceneId];
    if (!scene) return fatal(`story.json에 "${sceneId}" 장면이 없습니다.`);

    const enter = () => {
      state.sceneId = sceneId;
      state.lineIndex = 0;
      state.onStage = scene.characters || [];
      setBackground(scene.background);
      showLine();
    };
    // 배경이 바뀌면 암전 전환
    if (scene.background !== state.bg && state.bg !== null) transition(enter);
    else enter();
  }

  function transition(mid) {
    busy = true;
    $('fade').classList.add('on');
    setTimeout(() => {
      mid();
      $('fade').classList.remove('on');
      setTimeout(() => { busy = false; }, FADE_MS);
    }, FADE_MS);
  }

  function showLine() {
    const scene = story.scenes[state.sceneId];
    const line = (scene.lines || [])[state.lineIndex];
    if (!line) return endOfScene(scene);

    if (line.show) state.onStage = line.show;
    renderStage(line.speaker, line.expression);

    const ch = story.characters[line.speaker];
    const plate = $('nameplate');
    plate.classList.toggle('show', !!ch);
    plate.textContent = ch ? ch.name : '';
    $('dialog').style.setProperty('--speaker', ch ? ch.color : 'rgba(255,255,255,.35)');
    $('dialog').classList.toggle('narration', !ch);

    const text = fillVars(line.text);
    state.log.push({ name: ch?.name, color: ch?.color, text });
    typeText(text);
  }

  function typeText(text) {
    clearTimeout(autoTimer);
    if (typing) clearInterval(typing.timer);
    const el = $('text');
    $('dialog').classList.remove('done');
    const chars = [...text];
    let i = 0;
    el.textContent = '';
    const speed = settings().textSpeed;
    if (speed <= 0) return finishTyping(text);
    typing = { text, timer: setInterval(() => {
      el.textContent += chars[i++] ?? '';
      if (i >= chars.length) finishTyping(text);
    }, speed) };
  }

  function finishTyping(text) {
    if (typing) clearInterval(typing.timer);
    typing = null;
    $('text').textContent = text;
    $('dialog').classList.add('done');
    if (state.auto) {
      autoTimer = setTimeout(() => { if (state.auto) advance(); },
        settings().autoDelay + text.length * 25);
    }
  }

  function advance() {
    if (busy || state.waiting || !state.sceneId) return;
    if (typing) return finishTyping(typing.text);   // 첫 클릭은 문장 완성
    state.lineIndex++;
    showLine();
  }

  function endOfScene(scene) {
    if (scene.ending) return showEnding(scene);
    if (scene.choice) return showChoice(scene.choice);
    if (scene.next) return goto(scene.next);
    fatal(`"${state.sceneId}" 장면에 choice, next, ending 중 아무것도 없습니다.`);
  }

  // ---------- 선택지 ----------
  function showChoice(choice) {
    state.waiting = true;
    clearTimeout(autoTimer);
    $('choice-prompt').textContent = fillVars(choice.prompt);
    const list = $('choice-list');
    list.innerHTML = '';
    (choice.options || []).forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.innerHTML = `<span class="choice-no">${i + 1}</span><span class="choice-text"></span>`;
      b.querySelector('.choice-text').textContent = fillVars(opt.text);
      b.style.animationDelay = `${i * 70}ms`;
      b.onclick = () => pickOption(opt);
      list.appendChild(b);
    });
    open('choices', true);
  }

  function pickOption(opt) {
    if (!state.waiting) return;
    open('choices', false);
    state.waiting = false;
    state.log.push({ choice: true, text: fillVars(opt.text) });
    applyAffection(opt.affection);
    goto(opt.next);
  }

  function applyAffection(delta = {}) {
    const max = story.affection?.max ?? 10;
    for (const [id, d] of Object.entries(delta)) {
      if (!(id in state.affection) || !d) continue;
      state.affection[id] = Math.max(0, Math.min(max, state.affection[id] + d));
      if (story.affection?.showChangeToast !== false) toast(id, d);
    }
    renderHud();
  }

  // 호감도가 가장 높은 캐릭터 (동점이면 story.json characters 순서상 앞쪽)
  function pickEnding() {
    const rule = story.endings || {};
    let best = null;
    for (const id of Object.keys(story.characters)) {
      if (!rule.happy?.[id]) continue;
      if (best === null || state.affection[id] > state.affection[best]) best = id;
    }
    if (best !== null && state.affection[best] >= (rule.threshold ?? 0)) {
      state.endingChar = best;
      return rule.happy[best];
    }
    state.endingChar = null;
    return rule.normal;
  }

  // ---------- 엔딩 ----------
  function showEnding(scene) {
    state.waiting = true;
    state.auto = false;
    syncAutoButton();
    const ending = scene.ending;
    const ch = story.characters[ending.character || state.endingChar];
    const happy = ending.type !== 'normal';

    const card = document.querySelector('.ending-card');
    card.style.setProperty('--accent', happy && ch ? ch.color : '#9aa4c7');
    $('ending-badge').textContent = happy ? 'HAPPY END' : 'NORMAL END';
    $('ending-title').textContent = fillVars(ending.title);
    $('ending-subtitle').textContent = fillVars(ending.subtitle);

    const max = story.affection?.max ?? 10;
    $('ending-scores').innerHTML = '';
    for (const [id, c] of Object.entries(story.characters)) {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.style.setProperty('--c', c.color);
      row.innerHTML = `<span class="score-name"></span><span class="bar"><i style="width:${state.affection[id] / max * 100}%"></i></span><b>${state.affection[id]}</b>`;
      row.querySelector('.score-name').textContent = c.name;
      $('ending-scores').appendChild(row);
    }

    saveEnding(state.sceneId);
    setTimeout(() => open('ending', true), 400);
  }

  function startGame() {
    open('ending', false);
    open('title-screen', false);
    clearTimeout(autoTimer);
    state = newState();
    syncAutoButton();
    $('stage').innerHTML = '';
    renderHud();
    goto(story.meta.start);
  }

  function toTitle() {
    clearTimeout(autoTimer);
    if (typing) clearInterval(typing.timer);
    typing = null;
    if (state) { state.auto = false; state.sceneId = null; }
    syncAutoButton();
    open('ending', false);
    open('choices', false);
    open('title-screen', true);
  }

  // ---------- 화면 그리기 ----------
  function setBackground(bgId) {
    state.bg = bgId ?? null;
    const bg = story.backgrounds?.[bgId] || {};
    const layers = [];
    if (bg.image) layers.push(`url("${bg.image}")`);   // 파일이 없으면 이 층만 투명 → 그라데이션이 보임
    layers.push(bg.gradient || 'linear-gradient(180deg, #2a2340, #120e1c)');
    $('bg').style.backgroundImage = layers.join(', ');
  }

  // 무대 위 캐릭터를 id별로 유지해서, 표정만 바뀔 때 깜빡이지 않게 함
  function renderStage(speaker, expression) {
    const stage = $('stage');
    const ids = state.onStage.filter((id) => story.characters[id]);
    stage.dataset.count = ids.length;

    for (const el of [...stage.children]) {
      if (!ids.includes(el.dataset.id)) el.remove();
    }
    ids.forEach((id, order) => {
      let el = stage.querySelector(`[data-id="${id}"]`);
      if (!el) el = createChar(id);
      el.style.order = order;
      el.classList.toggle('speaking', speaker === id);
      el.classList.toggle('dim', !!speaker && speaker !== id && !!story.characters[speaker]);
      const ch = story.characters[id];
      const want = (speaker === id && expression && ch.images?.[expression]) ||
                   (speaker === id ? null : el.dataset.src) || ch.images?.default || '';
      setCharImage(el, want, ch.images?.default);
      stage.appendChild(el);
    });
  }

  function createChar(id) {
    const ch = story.characters[id];
    const el = document.createElement('div');
    el.className = 'char';
    el.dataset.id = id;
    el.style.setProperty('--c', ch.color);
    el.innerHTML = `
      <div class="silhouette">
        <div class="lights"><i></i><i></i></div>
        <div class="sil-name"></div>
        <div class="sil-title"></div>
        <div class="sil-file"></div>
      </div>
      <img alt="">`;
    el.querySelector('.sil-name').textContent = ch.name;
    el.querySelector('.sil-title').textContent = ch.title || '';
    el.querySelector('.sil-file').textContent = ch.images?.default || '';
    el.querySelector('img').alt = ch.name;
    return el;
  }

  // 이미지 로드 실패 시: 표정 이미지 → 기본 이미지 → 실루엣 순서로 대체
  function setCharImage(el, src, fallback) {
    if (el.dataset.src === src) return;
    el.dataset.src = src;
    const img = el.querySelector('img');
    if (!src) { el.classList.remove('has-image'); img.removeAttribute('src'); return; }
    img.onload = () => el.classList.add('has-image');
    img.onerror = () => {
      if (fallback && src !== fallback) setCharImage(el, fallback, null);
      else el.classList.remove('has-image');
    };
    img.src = src;
  }

  function renderHud() {
    const max = story.affection?.max ?? 10;
    const list = $('hud-list');
    list.innerHTML = '';
    for (const [id, ch] of Object.entries(story.characters)) {
      const v = state ? state.affection[id] : 0;
      const row = document.createElement('div');
      row.className = 'hud-row';
      row.dataset.id = id;
      row.style.setProperty('--c', ch.color);
      row.innerHTML = `<span class="heart">♥</span><span class="hud-name"></span><span class="bar"><i style="width:${v / max * 100}%"></i></span><b>${v}</b>`;
      row.querySelector('.hud-name').textContent = ch.name;
      list.appendChild(row);
    }
  }

  function toast(id, d) {
    const ch = story.characters[id];
    const t = document.createElement('div');
    t.className = 'toast' + (d < 0 ? ' down' : '');
    t.style.setProperty('--c', ch.color);
    t.textContent = `${d > 0 ? '♥' : '♡'} ${ch.name} ${d > 0 ? '+' : ''}${d}`;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 2200);
    // renderHud가 행을 새로 만들기 때문에 다음 프레임에 효과 적용
    requestAnimationFrame(() => {
      document.querySelector(`.hud-row[data-id="${id}"]`)?.classList.add(d > 0 ? 'pulse-up' : 'pulse-down');
    });
  }

  function renderLog() {
    const list = $('log-list');
    list.innerHTML = '';
    for (const e of state?.log || []) {
      const row = document.createElement('div');
      row.className = 'log-row' + (e.choice ? ' log-choice' : '');
      if (e.name) {
        const n = document.createElement('div');
        n.className = 'log-name';
        n.style.color = e.color;
        n.textContent = e.name;
        row.appendChild(n);
      }
      const t = document.createElement('div');
      t.textContent = e.choice ? `▶ ${e.text}` : e.text;
      row.appendChild(t);
      list.appendChild(row);
    }
    if (!list.children.length) list.innerHTML = '<div class="empty">아직 기록이 없습니다.</div>';
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function renderAlbum() {
    const seen = loadEndings();
    const list = $('album-list');
    list.innerHTML = '';
    for (const [sid, sc] of Object.entries(story.scenes)) {
      if (!sc.ending) continue;
      const got = seen.includes(sid);
      const charId = sc.ending.character ||
        Object.keys(story.endings?.happy || {}).find((k) => story.endings.happy[k] === sid);
      const color = story.characters[charId]?.color || '#9aa4c7';
      const item = document.createElement('div');
      item.className = 'album-item' + (got ? '' : ' locked');
      item.style.setProperty('--c', color);
      item.innerHTML = `<span class="album-type"></span><span class="album-title"></span>`;
      item.querySelector('.album-type').textContent = sc.ending.type === 'normal' ? 'NORMAL' : 'HAPPY';
      item.querySelector('.album-title').textContent = got ? fillVars(sc.ending.title) : '???';
      list.appendChild(item);
    }
    const total = list.children.length;
    const head = document.createElement('div');
    head.className = 'album-count';
    head.textContent = `달성 ${seen.filter((s) => story.scenes[s]?.ending).length} / ${total}`;
    list.prepend(head);
  }

  function renderTitle() {
    $('title-logo').textContent = story.meta?.title || '';
    $('title-sub').textContent = story.meta?.subtitle || '';
    document.title = story.meta?.title || document.title;
    const cast = $('title-cast');
    cast.innerHTML = '';
    for (const ch of Object.values(story.characters)) {
      const s = document.createElement('span');
      s.style.setProperty('--c', ch.color);
      s.textContent = ch.name;
      cast.appendChild(s);
    }
  }

  // ---------- 보조 ----------
  function open(id, on) { $(id).classList.toggle('is-open', on); }

  function toggleAuto() {
    if (!state?.sceneId) return;
    state.auto = !state.auto;
    syncAutoButton();
    if (state.auto && !typing && !state.waiting) advance();
  }
  function syncAutoButton() {
    document.querySelector('[data-action="auto"]').classList.toggle('active', !!state?.auto);
  }

  function loadEndings() {
    try { return JSON.parse(localStorage.getItem(ALBUM_KEY)) || []; } catch { return []; }
  }
  function saveEnding(sid) {
    try {
      const seen = loadEndings();
      if (!seen.includes(sid)) localStorage.setItem(ALBUM_KEY, JSON.stringify([...seen, sid]));
    } catch { /* 저장 불가 환경에서는 무시 */ }
  }

  function fatal(msg) {
    if (typing) clearInterval(typing.timer);
    typing = null;
    $('nameplate').classList.remove('show');
    $('text').textContent = '⚠ ' + msg;
    $('dialog').classList.add('narration');
    console.error(msg);
  }

  // 팀원이 story.json을 고쳤을 때 실수를 콘솔에 알려줌
  function validate() {
    const warn = (m) => console.warn('[story.json] ' + m);
    const has = (sid) => sid === 'ENDING' || story.scenes[sid];
    if (!story.scenes[story.meta?.start]) warn(`meta.start "${story.meta?.start}" 장면이 없습니다.`);
    for (const [sid, sc] of Object.entries(story.scenes)) {
      if (sc.next && !has(sc.next)) warn(`${sid}.next → "${sc.next}" 장면이 없습니다.`);
      (sc.choice?.options || []).forEach((o, i) => {
        if (!has(o.next)) warn(`${sid} 선택지 ${i + 1}의 next → "${o.next}" 장면이 없습니다.`);
        for (const k of Object.keys(o.affection || {})) {
          if (!story.characters[k]) warn(`${sid} 선택지 ${i + 1}: 캐릭터 "${k}"가 characters에 없습니다.`);
        }
      });
      for (const l of sc.lines || []) {
        if (l.speaker && !story.characters[l.speaker]) warn(`${sid}: speaker "${l.speaker}"가 characters에 없습니다.`);
      }
    }
    for (const sid of [...Object.values(story.endings?.happy || {}), story.endings?.normal]) {
      if (sid && !story.scenes[sid]) warn(`endings → "${sid}" 장면이 없습니다.`);
    }
  }

  // ---------- 입력 ----------
  function bindInput() {
    const game = $('game');
    game.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) {
        const a = btn.dataset.action;
        if (a === 'start') startGame();
        else if (a === 'album') { renderAlbum(); open('album', true); }
        else if (a === 'log') { renderLog(); open('log', true); }
        else if (a === 'auto') toggleAuto();
        else if (a === 'title') toTitle();
        else if (a === 'close') btn.closest('.layer').classList.remove('is-open');
        return;
      }
      if (e.target.closest('.layer.is-open, #hud')) {
        // 모달 바깥 어두운 영역 클릭 시 닫기
        if (e.target.classList.contains('modal')) e.target.classList.remove('is-open');
        return;
      }
      advance();
    });

    $('restart').addEventListener('click', startGame);
    $('hud-toggle').addEventListener('click', () => $('hud').classList.toggle('collapsed'));

    document.addEventListener('keydown', (e) => {
      const modal = document.querySelector('.modal.is-open');
      if (e.key === 'Escape' && modal) return modal.classList.remove('is-open');
      if (modal || $('title-screen').classList.contains('is-open')) return;
      if (state?.waiting && /^[1-9]$/.test(e.key)) {
        const b = $('choice-list').children[+e.key - 1];
        if (b && $('choices').classList.contains('is-open')) b.click();
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
    });
  }

  // ---------- 시작 ----------
  async function boot() {
    try {
      const res = await fetch('story.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      story = await res.json();
    } catch (e) {
      open('title-screen', false);
      return fatal('story.json을 불러오지 못했습니다. 쉼표·따옴표 등 JSON 문법을 확인하거나, README의 방법으로 서버를 켜고 실행해 주세요. (' + e.message + ')');
    }
    story.characters ||= {};
    story.scenes ||= {};
    validate();
    renderTitle();
    bindInput();
  }

  boot();
})();
