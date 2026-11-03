/*
 * 심장이 부릉부릉 — 비주얼 노벨 엔진
 * 스토리·대사·선택지·호감도·엔딩·연출은 전부 story.json에 있습니다.
 * 이 파일은 story.json을 읽어서 화면에 그려주기만 합니다.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ENDINGS_KEY = 'heartvroom.endings';
  const CARDS_KEY = 'heartvroom.cards';
  const FADE_MS = 350;

  let story = null;
  let state = null;
  let typing = null;   // 타자 효과 진행 상태
  let autoTimer = null;
  let busy = false;    // 화면 전환 중에는 입력 무시

  // ---------- 상태 ----------
  function newState() {
    const aff = {};
    for (const id of targetIds()) aff[id] = story.affection?.initial ?? 0;
    return {
      sceneId: null, lines: [], index: -1, done: null,
      affection: aff, vars: {}, onStage: [], lamps: {}, outfits: {}, exprs: {}, filters: [], bg: null,
      cards: [], ending: null, waiting: false, auto: false, log: [], route: null,
    };
  }

  const settings = () => Object.assign({ textSpeed: 28, autoDelay: 1400, showSfxText: true, musicVolume: 0.5, sfxVolume: 0.8 }, story.settings);
  const targetIds = () => Object.keys(story.characters).filter((id) => story.characters[id].target);
  // 공략 대상을 골랐으면 그 캐릭터만 호감도를 관리
  const activeTargets = () => state?.route ? [state.route.character] : targetIds();
  const maxAffection = () => story.affection?.max ?? 5;

  // 조건 { "avante": 2 } → 호감도(또는 vars 점수)가 2 이상이면 참
  function check(cond = {}) {
    return Object.entries(cond).every(([k, v]) => (state.affection[k] ?? state.vars[k] ?? 0) >= v);
  }
  function resolveNext(next) {
    if (next && typeof next === 'object') return check(next.if) ? next.then : next.else;
    return next;
  }

  // ---------- 장면 진행 ----------
  function goto(target) {
    const sceneId = resolveNext(target);
    const scene = story.scenes[sceneId];
    if (!scene) return fatal(`story.json에 "${sceneId}" 장면이 없습니다.`);
    state.sceneId = sceneId;
    const lines = scene.background ? [{ bg: scene.background }, ...(scene.lines || [])] : (scene.lines || []);
    playLines(lines, () => endOfScene(scene));
  }

  function playLines(lines, done) {
    state.lines = lines;
    state.index = -1;
    state.done = done;
    step();
  }

  // 다음 줄 실행. 명령만 있는 줄은 실행하고 바로 다음 줄로, 대사가 있으면 멈춰서 클릭을 기다림
  function step() {
    for (;;) {
      state.index++;
      const line = state.lines[state.index];
      if (!line) return state.done();

      if (line.bg !== undefined && line.bg !== state.bg && state.bg !== null && !busy) {
        // 배경이 바뀌면 암전 → 교체 → 이어서 진행
        return transition(() => { setBackground(line.bg); if (!runLine(line)) step(); });
      }
      if (line.bg !== undefined) setBackground(line.bg);
      if (runLine(line)) return;
    }
  }

  // 명령을 실행하고, 대사가 있으면 화면에 띄우고 true 반환
  function runLine(line) {
    let stageChanged = false;
    if (line.filter !== undefined) setFilters(line.filter);
    if (line.flash) flash();
    if (line.exit) { state.onStage = state.onStage.filter((id) => id !== line.exit); stageChanged = true; }
    if (line.enter && !state.onStage.includes(line.enter)) {
      state.onStage.push(line.enter);
      delete state.exprs[line.enter];   // 새로 등장하면 기본 표정
      stageChanged = true;
    }
    if (line.outfit) { Object.assign(state.outfits, line.outfit); stageChanged = true; }
    if (line.expression) {
      // "expression": "sad" 는 말하는 캐릭터, { "avante": "sad" } 는 지정한 캐릭터. 바꾸기 전까지 유지됨
      const e = typeof line.expression === 'string'
        ? (line.speaker ? { [line.speaker]: line.expression } : {}) : line.expression;
      Object.assign(state.exprs, e);
      stageChanged = true;
    }
    if (line.lamp) { Object.assign(state.lamps, line.lamp); stageChanged = true; }
    if (line.bgm !== undefined) playBgm(line.bgm);
    if (line.sfx) playSfx(line.sfx);
    if (line.card) getCard(line.card);
    if (line.affection) applyAffection(line.affection);
    if (line.vars) addVars(line.vars);
    if (line.ending) state.ending = line.ending;

    if (line.text === undefined) {
      if (stageChanged) renderStage(null);
      return false;
    }
    showText(line);
    return true;
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

  function showText(line) {
    const ch = story.characters[line.speaker];
    const onStage = state.onStage.includes(line.speaker);
    renderStage(onStage ? line.speaker : null);

    const plate = $('nameplate');
    plate.classList.toggle('show', !!ch);
    $('nameplate-name').textContent = ch ? ch.name : '';
    const lamp = story.lamps?.[state.lamps[line.speaker]];
    plate.classList.toggle('has-lamp', !!lamp);
    plate.style.setProperty('--lamp', lamp?.color || 'transparent');
    $('dialog').style.setProperty('--speaker', ch ? ch.color : 'rgba(255,255,255,.35)');
    $('dialog').classList.toggle('narration', !ch);
    renderSidePortrait(ch?.side ? line.speaker : null, lamp);

    const text = String(line.text ?? '');
    $('text').classList.toggle('thought', /^\(.*\)$/s.test(text.trim()));
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
    if (busy || state?.waiting || !state?.sceneId) return;
    if (typing) return finishTyping(typing.text);   // 첫 클릭은 문장 완성
    step();
  }

  function endOfScene(scene) {
    if (scene.showEnding) return showEnding();
    if (scene.choice?.routeChoice && state.route) return goto(state.route.start);
    if (scene.choice) return showChoice(scene.choice);
    if (scene.next) return goto(scene.next);
    fatal(`"${state.sceneId}" 장면에 choice, next, showEnding 중 아무것도 없습니다.`);
  }

  // ---------- 선택지 ----------
  function showChoice(choice) {
    state.waiting = true;
    clearTimeout(autoTimer);
    $('choice-prompt').textContent = choice.prompt || '';
    $('choice-prompt').hidden = !choice.prompt;
    const list = $('choice-list');
    list.innerHTML = '';
    // 공략 중인 캐릭터 전용 선택지(byRoute)가 있으면 그것을 사용
    const options = (state.route && choice.byRoute?.[state.route.character]) || choice.options || [];
    options.filter((o) => !o.require || check(o.require)).forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice' + (opt.require ? ' secret' : '');
      b.innerHTML = `<span class="choice-no">${i + 1}</span><span class="choice-text"></span>`;
      b.querySelector('.choice-text').textContent = opt.text;
      b.style.animationDelay = `${i * 70}ms`;
      b.onclick = () => pickOption(opt);
      list.appendChild(b);
    });
    open('choices', true);
  }

  function pickOption(opt) {
    if (!state.waiting) return;
    playSound(story.uiSounds?.choice);
    open('choices', false);
    state.waiting = false;
    state.log.push({ choice: true, text: opt.text });
    if (opt.affection) applyAffection(opt.affection);
    if (opt.vars) addVars(opt.vars);
    if (opt.lines?.length) playLines(opt.lines, () => goto(opt.next));
    else goto(opt.next);
  }

  function applyAffection(delta) {
    for (const [id, d] of Object.entries(delta)) {
      if (!(id in state.affection) || !d || !activeTargets().includes(id)) continue;
      state.affection[id] = Math.max(0, Math.min(maxAffection(), state.affection[id] + d));
      if (story.affection?.showChangeToast !== false) toast(id, d);
    }
    renderHud();
  }

  function addVars(delta) {
    for (const [k, d] of Object.entries(delta)) state.vars[k] = (state.vars[k] || 0) + d;
  }

  // ---------- 연출 ----------
  function setBackground(bgId) {
    state.bg = bgId;
    const bg = story.backgrounds?.[bgId] || {};
    const layers = [];
    if (bg.image) layers.push(`url("${bg.image}")`);   // 파일이 없으면 이 층만 투명 → 그라데이션이 보임
    layers.push(bg.gradient || 'linear-gradient(180deg, #2a2340, #120e1c)');
    $('bg').style.backgroundImage = layers.join(', ');
    // 배경이 바뀌면 필터와 등장인물 초기화
    setFilters([]);
    state.onStage = [];
    state.exprs = {};
    renderStage(null);
  }

  function setFilters(names) {
    state.filters = [].concat(names || []);
    const defs = state.filters.map((n) => story.filters?.[n]).filter(Boolean);
    $('bg').style.filter = defs.map((d) => d.css).filter(Boolean).join(' ');
    $('bg-overlay').style.background = defs.filter((d) => d.overlay)
      .map((d) => `linear-gradient(${d.overlay}, ${d.overlay})`).join(', ') || 'none';
    $('rain').classList.toggle('on', defs.some((d) => d.rain));
  }

  function flash() {
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth;   // 애니메이션 다시 시작
    f.classList.add('on');
    $('game').classList.remove('shake');
    void $('game').offsetWidth;
    $('game').classList.add('shake');
  }

  function playSfx(name) {
    const src = story.sounds?.[name];
    if (src) playSound(src);
    // 음원이 없거나 소리를 꺼 둔 경우에만 글자로 표시
    if (!settings().showSfxText || (src && !sound.muted)) return;
    const el = document.createElement('div');
    el.className = 'sfx';
    el.textContent = name;
    $('sfx').appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  function getCard(id) {
    const card = story.cards?.[id];
    if (!card) return;
    if (!state.cards.includes(id)) state.cards.push(id);
    const owned = loadList(CARDS_KEY);
    const isNew = !owned.includes(id);
    if (isNew) saveList(CARDS_KEY, id);

    const el = document.createElement('div');
    el.className = 'card-pop';
    el.innerHTML = `<div class="card-label">연대기 카드${isNew ? ' <b>NEW</b>' : ''}</div><div class="card-year"></div><div class="card-text"></div>`;
    el.querySelector('.card-year').textContent = card.year;
    el.querySelector('.card-text').textContent = card.text;
    $('cards').appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------- 엔딩 ----------
  function showEnding() {
    state.waiting = true;
    state.auto = false;
    syncAutoButton();
    const ending = story.endings?.[state.ending] || { type: 'normal', title: '엔딩' };
    const type = ending.type || 'normal';
    const accent = { happy: '#ff6b9d', normal: '#9aa4c7', bad: '#6b2d3a' }[type] || '#9aa4c7';

    const card = document.querySelector('.ending-card');
    card.style.setProperty('--accent', accent);
    // 엔딩 그림(캐릭터 고백·프러포즈 등)을 크게 걸고, 종류별 분위기 연출
    const layer = $('ending');
    layer.classList.remove('type-happy', 'type-normal', 'type-bad');
    layer.classList.add(`type-${type}`);
    layer.style.setProperty('--accent', accent);
    layer.classList.toggle('has-art', !!ending.image);
    if (ending.image) $('ending-img').src = ending.image;
    else $('ending-img').removeAttribute('src');
    const hearts = layer.querySelector('.ending-hearts');
    hearts.innerHTML = type === 'happy'
      ? Array.from({ length: 14 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-delay:${(i * 0.45) % 5}s;font-size:${14 + (i * 7) % 18}px">♥</i>`).join('')
      : '';
    $('ending-badge').textContent = `${type.toUpperCase()} END`;
    $('ending-title').textContent = ending.title || '';
    $('ending-subtitle').textContent = ending.subtitle || '';
    $('ending-cards').textContent = `연대기 카드 ${state.cards.length} / ${Object.keys(story.cards || {}).length}`;

    $('ending-scores').innerHTML = '';
    for (const id of activeTargets()) $('ending-scores').appendChild(heartRow(id, 'score-row'));

    if (state.ending) saveList(ENDINGS_KEY, state.ending);
    setTimeout(() => open('ending', true), 400);
  }

  function startGame(sceneId, route = null) {
    open('ending', false);
    open('title-screen', false);
    open('select', false);
    clearTimeout(autoTimer);
    state = newState();
    state.route = route;
    syncAutoButton();
    setFilters([]);
    $('stage').innerHTML = '';
    renderHud();
    goto(typeof sceneId === 'string' ? sceneId : story.meta.start);
  }

  function toTitle() {
    playBgm(story.meta?.titleMusic);
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
  // 무대 위 캐릭터를 id별로 유지해서, 표정만 바뀔 때 깜빡이지 않게 함
  // 의상 + 표정으로 그림 고르기: suit_sad → suit_neutral → sad → default 순서로 있는 것
  function imageFor(id) {
    const imgs = story.characters[id].images || {};
    const outfit = state.outfits[id] || story.characters[id].outfit;   // 정하지 않았으면 캐릭터 기본 의상
    const expr = state.exprs[id];
    const keys = outfit ? [`${outfit}_${expr || 'neutral'}`, `${outfit}_neutral`] : [];
    if (expr) keys.push(expr);
    keys.push('default');
    return imgs[keys.find((k) => imgs[k])] || '';
  }

  function renderStage(speaker) {
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
      el.classList.toggle('dim', !!speaker && speaker !== id);
      const lamp = story.lamps?.[state.lamps[id]];
      el.style.setProperty('--lamp', lamp?.color || '#fffbe6');
      el.classList.toggle('has-lamp', !!lamp);
      el.classList.toggle('faded', !!lamp?.fade);
      const ch = story.characters[id];
      setCharImage(el, imageFor(id), ch.images?.default);
      if (el.parentNode !== stage) stage.appendChild(el);
    });
  }

  // 주인공(side: true)은 무대 대신 대사창 왼쪽 위에 상반신 초상화로 표시
  function renderSidePortrait(id, lamp) {
    const box = $('side-portrait');
    $('dialog').classList.toggle('has-side', !!id);
    if (!id) return;
    box.style.setProperty('--lamp', lamp?.color || 'transparent');
    const src = imageFor(id);
    if (box.dataset.src === src) return;
    box.dataset.src = src;
    const loader = new Image();
    loader.onload = () => { if (box.dataset.src === src) box.querySelector('img').src = src; };
    loader.src = src;
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

  // 새 그림을 다 받은 뒤에 바꿔서 깜빡이지 않게 함
  // 로드 실패 시: 표정 이미지 → 기본 이미지 → 실루엣 순서로 대체
  function setCharImage(el, src, fallback) {
    if (el.dataset.src === src) return;
    el.dataset.src = src;
    const img = el.querySelector('img');
    if (!src) { el.classList.remove('has-image'); img.removeAttribute('src'); return; }
    const loader = new Image();
    loader.onload = () => {
      if (el.dataset.src !== src) return;   // 그 사이 다른 그림으로 바뀜
      img.src = src;
      el.classList.add('has-image');
    };
    loader.onerror = () => {
      if (el.dataset.src !== src) return;
      if (fallback && src !== fallback) setCharImage(el, fallback, null);
      else el.classList.remove('has-image');
    };
    loader.src = src;
  }

  function heartRow(id, cls) {
    const ch = story.characters[id];
    const v = state ? state.affection[id] ?? 0 : 0;
    const row = document.createElement('div');
    row.className = cls;
    row.dataset.id = id;
    row.style.setProperty('--c', ch.color);
    const hearts = Array.from({ length: maxAffection() }, (_, i) => `<i class="${i < v ? 'on' : ''}">♥</i>`).join('');
    row.innerHTML = `<span class="hud-name"></span><span class="hearts">${hearts}</span>`;
    row.querySelector('.hud-name').textContent = ch.name;
    return row;
  }

  function renderHud() {
    const list = $('hud-list');
    list.innerHTML = '';
    for (const id of activeTargets()) {
      const row = heartRow(id, 'hud-row');
      row.classList.toggle('chosen', state?.route?.character === id);
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
    const list = $('album-list');
    list.innerHTML = '';
    const section = (title, got, total) => {
      const h = document.createElement('div');
      h.className = 'album-count';
      h.innerHTML = `<b></b> <span>${got} / ${total}</span>`;
      h.querySelector('b').textContent = title;
      list.appendChild(h);
    };

    const seenEndings = loadList(ENDINGS_KEY);
    const endings = Object.entries(story.endings || {});
    section('엔딩', endings.filter(([id]) => seenEndings.includes(id)).length, endings.length);
    for (const [id, e] of endings) {
      const got = seenEndings.includes(id);
      const item = document.createElement('div');
      item.className = 'album-item' + (got ? '' : ' locked');
      item.style.setProperty('--c', story.characters[e.character]?.color || (e.type === 'bad' ? '#8a3a4a' : '#9aa4c7'));
      item.innerHTML = `<span class="album-type"></span><span class="album-title"></span>`;
      item.querySelector('.album-type').textContent = (e.type || 'normal').toUpperCase();
      item.querySelector('.album-title').textContent = got ? e.title : '???';
      list.appendChild(item);
    }

    const owned = loadList(CARDS_KEY);
    const cards = Object.entries(story.cards || {});
    section('연대기 카드', cards.filter(([id]) => owned.includes(id)).length, cards.length);
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const [id, c] of cards) {
      const got = owned.includes(id);
      const el = document.createElement('div');
      el.className = 'card-mini' + (got ? '' : ' locked');
      el.innerHTML = '<div class="card-year"></div><div class="card-text"></div>';
      el.querySelector('.card-year').textContent = got ? c.year : '????';
      el.querySelector('.card-text').textContent = got ? c.text : '아직 모으지 못한 카드';
      grid.appendChild(el);
    }
    list.appendChild(grid);
  }

  function renderTitle() {
    const title = story.meta?.title || '';
    $('title-logo-text').textContent = title;
    $('title-sub').textContent = story.meta?.subtitle || '';
    $('credits-team').textContent = story.meta?.credits?.team || '';
    $('credits-members').textContent = story.meta?.credits?.members || '';
    document.title = title || document.title;
    const img = $('title-logo-img');
    img.alt = title;
    img.onload = () => $('title-logo').classList.add('has-image');
    img.onerror = () => $('title-logo').classList.remove('has-image');
    if (story.meta?.logo) img.src = story.meta.logo;
    // 시작 화면 배경 그림 (없으면 기존 그라데이션 유지)
    const bg = story.meta?.titleBackground;
    if (bg) {
      const pic = new Image();
      pic.onload = () => {
        $('title-screen').style.setProperty('--title-bg', `url("${bg}")`);
        $('title-screen').classList.add('has-bg');
      };
      pic.src = bg;
    }
  }

  // ---------- 공략 대상 선택 ----------
  let picked = null;

  function openSelect() {
    const routes = story.routes?.list || [];
    if (!routes.length) return startGame();
    picked = null;
    $('select-title').textContent = story.routes.title || '';
    $('select-quote').textContent = '';
    $('select-go').disabled = true;
    const list = $('select-list');
    list.innerHTML = '';
    list.dataset.count = routes.length;
    routes.forEach((r) => {
      const ch = story.characters[r.character];
      if (!ch) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick';
      b.style.setProperty('--c', ch.color);
      b.innerHTML = '<div class="pick-art"></div><div class="pick-name"></div><div class="pick-title"></div>';
      const art = createChar(r.character);
      setCharImage(art, ch.images?.default || '', null);
      b.querySelector('.pick-art').appendChild(art);
      b.querySelector('.pick-name').textContent = ch.name;
      b.querySelector('.pick-title').textContent = ch.title || '';
      b.onclick = () => {
        picked = r;
        for (const el of list.children) el.classList.toggle('selected', el === b);
        $('select-quote').textContent = r.quote ? `“${r.quote}”` : '';
        $('select-quote').style.setProperty('--c', ch.color);
        $('select-go').disabled = false;
      };
      list.appendChild(b);
    });
    open('ending', false);
    open('select', true);
    playBgm(story.meta?.titleMusic);
  }

  // ---------- 소리 ----------
  // 브라우저는 사용자가 한 번 누르기 전엔 소리를 막기 때문에, 막히면 첫 클릭 때 다시 재생
  const SOUND_KEY = 'heartvroom.muted';
  const sound = { bgm: null, name: null, muted: false };
  try { sound.muted = localStorage.getItem(SOUND_KEY) === '1'; } catch { /* 무시 */ }

  const audioSrc = (path) => encodeURI(path);   // 파일명에 띄어쓰기·한글이 있어도 되게

  function playSound(path) {
    if (sound.muted || !path) return;
    try {
      const a = new Audio(audioSrc(path));
      a.volume = settings().sfxVolume;
      a.play().catch(() => {});
    } catch { /* 소리 실패는 무시 */ }
  }

  function playBgm(name) {
    name = name || null;
    if (name === sound.name) return;   // 같은 곡이면 끊지 않고 이어서
    sound.name = name;
    if (sound.bgm) fadeOut(sound.bgm);
    sound.bgm = null;
    const path = name && story.music?.[name];
    if (!path) return;
    const a = new Audio(audioSrc(path));
    a.loop = true;
    a.volume = 0;
    a.muted = sound.muted;
    sound.bgm = a;
    startBgm(a);
  }

  function resumeBgm() {
    const a = sound.bgm;
    if (a && a.paused) startBgm(a);
  }

  // 재생이 늦게 시작돼도, 그 사이 다른 곡으로 바뀌었으면 겹치지 않게 바로 멈춤
  function startBgm(a) {
    a.play().then(() => {
      if (sound.bgm === a) fadeTo(a, settings().musicVolume);
      else a.pause();
    }).catch(() => {});
  }

  function fadeTo(a, target, ms = 800, then) {
    clearInterval(a._fade);
    const from = a.volume;
    const start = performance.now();
    a._fade = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / ms);
      a.volume = Math.max(0, Math.min(1, from + (target - from) * t));
      if (t >= 1) { clearInterval(a._fade); then?.(); }
    }, 40);
  }
  function fadeOut(a) { fadeTo(a, 0, 600, () => { a.pause(); a.removeAttribute('src'); a.load(); }); }

  function toggleMute() {
    sound.muted = !sound.muted;
    if (sound.bgm) { sound.bgm.muted = sound.muted; if (!sound.muted) resumeBgm(); }
    try { localStorage.setItem(SOUND_KEY, sound.muted ? '1' : '0'); } catch { /* 무시 */ }
    syncSoundButton();
  }
  function syncSoundButton() {
    const b = $('sound-toggle');
    b.textContent = sound.muted ? '🔇' : '🔊';
    b.setAttribute('aria-label', sound.muted ? '소리 켜기' : '소리 끄기');
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

  function loadList(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  }
  function saveList(key, id) {
    try {
      const list = loadList(key);
      if (!list.includes(id)) localStorage.setItem(key, JSON.stringify([...list, id]));
    } catch { /* 저장 불가 환경에서는 무시 */ }
  }

  // 배경 이미지를 미리 받아 두어 장면 전환 때 깜빡임 줄이기
  function preloadBackgrounds() {
    for (const bg of Object.values(story.backgrounds || {})) {
      if (bg.image) new Image().src = bg.image;
    }
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
    const chars = story.characters;
    const sceneOk = (n) => (n && typeof n === 'object') ? sceneOk(n.then) && sceneOk(n.else) : !!story.scenes[n];
    const checkLine = (where, l) => {
      if (l.speaker && !chars[l.speaker]) warn(`${where}: speaker "${l.speaker}"가 characters에 없습니다.`);
      for (const k of ['enter', 'exit']) if (l[k] && !chars[l[k]]) warn(`${where}: ${k} "${l[k]}"가 characters에 없습니다.`);
      if (l.bg && !story.backgrounds?.[l.bg]) warn(`${where}: 배경 "${l.bg}"가 backgrounds에 없습니다.`);
      for (const f of [].concat(l.filter || [])) if (!story.filters?.[f]) warn(`${where}: 필터 "${f}"가 filters에 없습니다.`);
      for (const [c, color] of Object.entries(l.lamp || {})) {
        if (!chars[c]) warn(`${where}: 램프 캐릭터 "${c}"가 없습니다.`);
        if (!story.lamps?.[color]) warn(`${where}: 램프 색 "${color}"가 lamps에 없습니다.`);
      }
      for (const [c, o] of Object.entries(l.outfit || {})) {
        if (!Object.keys(chars[c]?.images || {}).some((k) => k.startsWith(o + '_'))) warn(`${where}: "${c}"에게 의상 "${o}" 그림이 없습니다.`);
      }
      if (l.bgm && !story.music?.[l.bgm]) warn(`${where}: 배경음악 "${l.bgm}"이 music에 없습니다.`);
      if (l.card && !story.cards?.[l.card]) warn(`${where}: 카드 "${l.card}"가 cards에 없습니다.`);
      if (l.ending && !story.endings?.[l.ending]) warn(`${where}: 엔딩 "${l.ending}"이 endings에 없습니다.`);
    };
    for (const r of story.routes?.list || []) {
      if (!chars[r.character]) warn(`routes: 캐릭터 "${r.character}"가 characters에 없습니다.`);
      if (!story.scenes[r.start]) warn(`routes: 시작 장면 "${r.start}"이 없습니다.`);
    }
    if (!story.scenes[story.meta?.start]) warn(`meta.start "${story.meta?.start}" 장면이 없습니다.`);
    for (const [sid, sc] of Object.entries(story.scenes)) {
      (sc.lines || []).forEach((l, i) => checkLine(`${sid} ${i + 1}번째 줄`, l));
      if (sc.next && !sceneOk(sc.next)) warn(`${sid}.next가 없는 장면을 가리킵니다.`);
      if (!sc.next && !sc.choice && !sc.showEnding) warn(`${sid}: next, choice, showEnding 중 하나가 필요합니다.`);
      const allOptions = [...(sc.choice?.options || []), ...Object.values(sc.choice?.byRoute || {}).flat()];
      for (const r of Object.keys(sc.choice?.byRoute || {})) if (!chars[r]) warn(`${sid}: byRoute 캐릭터 "${r}"가 없습니다.`);
      allOptions.forEach((o, i) => {
        const where = `${sid} 선택지 ${i + 1}`;
        if (!sceneOk(o.next)) warn(`${where}의 next가 없는 장면을 가리킵니다.`);
        for (const k of Object.keys(o.affection || {})) if (!chars[k]?.target) warn(`${where}: "${k}"는 공략 대상(target)이 아닙니다.`);
        (o.lines || []).forEach((l, j) => checkLine(`${where} 반응 ${j + 1}번째 줄`, l));
      });
    }
  }

  // ---------- 입력 ----------
  function bindInput() {
    const game = $('game');
    game.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) {
        const a = btn.dataset.action;
        if (a === 'start') openSelect();
        else if (a === 'go') { if (picked) { playSound(story.uiSounds?.choice); startGame(null, picked); } }
        else if (a === 'back') open('select', false);
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

    $('restart').addEventListener('click', openSelect);
    $('hud-toggle').addEventListener('click', () => $('hud').classList.toggle('collapsed'));

    document.addEventListener('keydown', (e) => {
      const modal = document.querySelector('.modal.is-open');
      if (e.key === 'Escape' && modal) return modal.classList.remove('is-open');
      if (modal || $('title-screen').classList.contains('is-open') || $('select').classList.contains('is-open')) return;
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
    preloadBackgrounds();
    syncSoundButton();
    $('sound-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
    ['pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, resumeBgm));
    playBgm(story.meta?.titleMusic);
    // 테스트용: 주소 끝에 #scene=p2 를 붙이면 그 장면부터 바로 시작
    const jump = decodeURIComponent(location.hash).match(/scene=([^&]+)/);
    if (jump) startGame(jump[1]);
  }

  boot();
})();
