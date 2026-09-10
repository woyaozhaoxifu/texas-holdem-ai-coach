/* global window, document, localStorage, setTimeout, clearTimeout */
/**
 * ui.js —— 界面渲染与交互。
 * 牌桌 / 座位 / 公共牌 / 玩家操作 / AI 行动驱动 / 复盘面板 / 课堂 / 统计
 */
(function (root) {
  'use strict';

  var Poker = root.Poker;
  var Cards = Poker.Cards;
  var Personalities = Poker.Personalities;
  var Coach = Poker.Coach;
  var Review = Poker.Review;

  function el(id) { return document.getElementById(id); }
  function pct(x) { return Math.round(x * 100); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var App = {
    game: null,
    mode: 'practice',   // 'practice' | 'match'
    reviews: [],
    rvIdx: 0,
    busy: false,
    revealAll: false,
    selected: ['fish', 'rock', 'tag', 'lag', 'solver'],
    stats: null,
    aiTimer: null,
    bubbleTimer: null,
    oddsKey: '',          // 胜率助手缓存键（街/牌面/对手数变化才重算）
    oddsCache: null,      // 最近一次 oddsPanel 结果
    oddsCollapsed: false, // 用户手动折叠
    oddsPendingKey: '',   // 正在后台(Worker)计算的 key，避免重复发起
    anonMode: false,      // 匿名桌：隐藏对手身份（选桌时勾选，开局生效）
    anonymRevealed: false // 匿名桌：身份是否已揭晓（全局、不可逆）
  };

  // 赛制结构：单一数据源在 js/structure.js（window.Poker.Structures）
  // ——盲注表不再在此处留副本，ui 与 game 都从 Structures 读
  var Structures = Poker.Structures;

  // 筹码面额体系（盲注 10/20、起始筹码 2000 均可整除：10=2×5，20=4×5，2000=2×1000）
  var CHIP_DENOMS = [
    { v: 1000, cls: 'den-1000', label: '1000' },
    { v: 500,  cls: 'den-500',  label: '500'  },
    { v: 100,  cls: 'den-100',  label: '100'  },
    { v: 25,   cls: 'den-25',   label: '25'   },
    { v: 5,    cls: 'den-5',    label: '5'    }
  ];

  /** 按面额取配色/文案（未知面额退回最小面额外观） */
  function denomMeta(v) {
    for (var i = 0; i < CHIP_DENOMS.length; i++) {
      if (CHIP_DENOMS[i].v === v) return CHIP_DENOMS[i];
    }
    return { v: v, cls: 'den-5', label: String(v) };
  }

  // ================= 匿名桌（需求 C）=================
  // 对手代号：座位 1..5 → 东家 / 南家 / 西家 / 北家 / 中家（统一面具头像）
  var ANON_CODES = ['东家', '南家', '西家', '北家', '中家'];
  var ANON_AVATAR = '🎭';

  /** 座位号 → 方位代号（座位 1 起；越界取模，保证永远有值） */
  App.anonCode = function (idx) {
    var i = (typeof idx === 'number' && idx >= 1) ? ((idx - 1) % ANON_CODES.length) : 0;
    return ANON_CODES[i];
  };

  /** 把「座位对象 / 座位号 / 榜单行 / 复盘条目」统一解析成座位对象 */
  function resolveSeat(seat) {
    var g = App.game;
    var s = seat;
    if (typeof seat === 'number') s = (g && g.seats) ? g.seats[seat] : null;
    if (s && typeof s === 'object') {
      var idx = (typeof s.index === 'number') ? s.index : (typeof s.seatIndex === 'number' ? s.seatIndex : -1);
      if (idx >= 0 && g && g.seats && g.seats[idx]) s = g.seats[idx];
    }
    return s || null;
  }

  /** 是否正处于「隐藏身份」状态（开了匿名桌且还没揭晓） */
  App.anonActive = function () {
    return !!(App.anonMode && !App.anonymRevealed);
  };

  /** 匿名桌：某座位当前应显示的名字。
   *  人类永远显示真名；匿名且未揭晓时，AI 显示方位代号。
   *  @param {object|number} seat 座位对象（含 name 与 index/seatIndex）或座位号 */
  App.displayName = function (seat) {
    var s = resolveSeat(seat);
    if (!s) return '';
    if (s.isHuman) return s.name || '你';
    if (App.anonActive()) {
      var i = (typeof s.index === 'number') ? s.index : (typeof s.seatIndex === 'number' ? s.seatIndex : -1);
      if (i >= 0) return App.anonCode(i);
    }
    return s.name || '';
  };

  /** 匿名桌：某座位当前应显示的头像（匿名未揭晓的 AI 统一面具） */
  App.anonAvatar = function (seat) {
    var s = resolveSeat(seat);
    if (!s) return '';
    if (s.isHuman) return s.avatar || '🙂';
    if (App.anonActive()) return ANON_AVATAR;
    return s.avatar || '🤖';
  };

  /** 揭晓身份：全局且不可逆（点按钮，或比赛轮末 / 终局自动调用）
   *  @param {boolean=} auto true = 比赛自动揭晓（日志加说明） */
  App.revealIdentities = function (auto) {
    if (!App.anonMode || App.anonymRevealed) return false;
    App.anonymRevealed = true;
    App.syncAnonUi();
    App.log('🕵️ 身份已揭晓' + (auto ? '（比赛结算自动揭晓）' : ''), 'hl');
    if (App.game) App.render();
    return true;
  };

  /** 顶栏「揭晓身份」按钮：仅匿名桌且未揭晓时显示 */
  App.syncAnonUi = function () {
    var b = el('btnReveal');
    if (!b || !b.classList) return;
    if (App.anonActive()) b.classList.remove('hidden');
    else b.classList.add('hidden');
  };

  // ================= 初始化 =================
  App.init = function () {
    App.stats = App.loadStats();
    App.oppStats = App.loadOppStats();
    App.prefs = App.loadPrefs();
    App.applyPrefsUi();
    App.bindPref('chkAnon', 'anon');
    App.bindPref('chkCoach', 'coach');
    App.bindPref('chkSound', 'sound');
    App.bindKeys();

    el('btnSetup').onclick = function () { App.openSetup(); };
    el('btnReview').onclick = function () { if (App.reviews.length) App.showReview(App.reviews.length - 1); else App.toast('还没有可复盘的手牌'); };
    el('btnClass').onclick = function () { App.openClass(); };
    el('btnStats').onclick = function () { App.openStats(); };
    el('btnSession').onclick = function () { App.showSessionSummary(); };
    el('btnSessionCopy').onclick = function () { App.sessionCopy(); };
    el('btnSessionDl').onclick = function () { App.sessionDownload(); };

    var closers = document.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].onclick = function () {
        var tid = this.getAttribute('data-close');
        var g = App.game;
        // 轮次结算弹窗在等待玩家选择下一轮/结束前不允许直接关掉（否则牌局会卡住）
        if (tid === 'modalRound' && g && g.match && g.match.enabled && g.match.pendingRoundEnd && !g.match.over) {
          App.toast('轮次结算中：请点击「开始下一轮」或「结束比赛」');
          return;
        }
        el(tid).classList.add('hidden');
      };
    }

    el('btnFold').onclick = function () { App.playerAct('fold'); };
    el('btnCheck').onclick = function () { App.playerAct('check'); };
    el('btnCall').onclick = function () { App.playerAct('call'); };
    el('btnRaise').onclick = function () { App.syncRaise(true); App.playerAct('raise', App.raiseAmount()); };
    el('btnAllIn').onclick = function () { App.playerAct('allin'); };
    el('btnNext').onclick = function () { App.nextHand(); };
    el('btnHalfPot').onclick = function () { App.presetRaise(0.5); };
    el('btnTwoThirdPot').onclick = function () { App.presetRaise(0.67); };
    el('btnFullPot').onclick = function () { App.presetRaise(1.0); };
    // 精确数值输入：输入中实时同步但不回写（避免打断输入），失焦 / 回车 / 点「加注」时才 clamp 回写
    el('raiseInput').oninput = function () { App.syncRaise(false); };
    el('raiseInput').onchange = function () { App.syncRaise(true); };
    el('raiseInput').onkeydown = function (e) {
      if (e.key === 'Enter') { App.syncRaise(true); App.playerAct('raise', App.raiseAmount()); }
    };
    // 步进按钮：±10 / ±100，按住可连续点，自动 clamp 到 [最小加注, 全下]
    el('btnMinus100').onclick = function () { App.stepRaise(-100); };
    el('btnMinus10').onclick = function () { App.stepRaise(-10); };
    el('btnPlus10').onclick = function () { App.stepRaise(10); };
    el('btnPlus100').onclick = function () { App.stepRaise(100); };

    el('rvPrev').onclick = function () { if (App.rvIdx > 0) App.showReview(App.rvIdx - 1); };
    el('rvNext').onclick = function () { if (App.rvIdx < App.reviews.length - 1) App.showReview(App.rvIdx + 1); };
    el('btnClearStats').onclick = function () {
      App.stats = { hands: 0, wins: 0, profit: 0, best: 0, ok: 0, mistake: 0, blunder: 0, byStreet: {}, topMistakes: {} };
      App.saveStats(); App.openStats();
    };
    el('btnStartTable').onclick = function () { App.startTable(App.selected); };
    el('btnStartMatch').onclick = function () { App.startTable(App.selected, 'match'); };
    // 赛制选择器：联动提示文案与开始按钮（每轮手数）
    var selS = el('selStructure');
    if (selS) {
      var updStruct = function () {
        var s = (typeof Structures !== 'undefined' && Structures) ? Structures.get(selS.value || 'fast') : null;
        if (!s) return;
        var hint = el('structHint');
        if (hint) hint.textContent = s.desc;
        var bm = el('btnStartMatch');
        if (bm) bm.textContent = '🏆 比赛 · 每轮 ' + s.handsPerLevel + ' 手';
      };
      selS.onchange = updStruct;
      updStruct();
    }
    el('btnNextRound').onclick = function () { App.nextRound(); };
    el('btnMatchQuit').onclick = function () { App.showFinal(); };
    el('btnBackLobby').onclick = function () { App.backLobby(); };

    el('oddsCollapse').onclick = function () {
      App.oddsCollapsed = !App.oddsCollapsed;
      el('oddsCollapse').textContent = App.oddsCollapsed ? '▸' : '▾';
      App.updateOddsPanel();
    };
    el('chkOddsPin').onchange = function () { App.updateOddsPanel(); };

    var rv = el('btnReveal');
    if (rv) rv.onclick = function () { App.revealIdentities(false); };

    // 对手标注弹窗：预设标签 / 自定义 / 清除
    el('tagCustomOk').onclick = function () {
      if (App.tagTargetIdx >= 0) App.applyTag(App.tagTargetIdx, el('tagCustom').value);
    };
    el('tagClear').onclick = function () {
      if (App.tagTargetIdx >= 0) App.clearTag(App.tagTargetIdx);
    };
    el('tagCustom').onkeydown = function (e) {
      if (e.key === 'Enter') {
        if (App.tagTargetIdx >= 0) App.applyTag(App.tagTargetIdx, el('tagCustom').value);
      }
    };

    App.syncScale();
    if (window.addEventListener) window.addEventListener('resize', App.syncScale);
    App.openSetup();
  };

  App.toast = function (msg) {
    App.log('<span class="hl">' + esc(msg) + '</span>');
  };

  /** 等比缩放：已弃用 —— 牌桌现直接铺满窗口（.table-area 用 100% 自适应）。
   *  保留函数入口与 resize 监听，避免破坏调用方；不再修改 --table-scale。 */
  App.syncScale = function () {
    // 满屏自适应：固定画布不再做 transform scale，故此处为空操作。
    return;
  };

  /** 把金额贪心拆成各面额筹码。
   *  @param {number} amount 金额（整数）
   *  @return {Array<{v:number,n:number}>} [{v:1000,n:2},{v:100,n:1},...]，只含 n>0 的面额；
   *          amount 非数字 / NaN / <=0 → []
   *  例：120 → [{v:100,n:1},{v:5,n:4}]；2000 → [{v:1000,n:2}]；0 → [] */
  App.chipBreakdown = function (amount) {
    var left = Math.floor(Number(amount));
    if (!isFinite(left) || left <= 0) return [];
    var out = [];
    for (var i = 0; i < CHIP_DENOMS.length; i++) {
      var d = CHIP_DENOMS[i];
      var n = Math.floor(left / d.v);
      if (n > 0) {
        out.push({ v: d.v, n: n });
        left -= n * d.v;
      }
    }
    return out;
  };

  /** 座位下注徽标里的小筹码图标：取该注码拆解出的主面额（最大面额优先，最多 3 枚） */
  App.betChipHtml = function (amount) {
    var parts = App.chipBreakdown(amount);
    if (!parts.length) return '<span class="chip-icon"></span>';
    var html = '';
    for (var i = 0; i < parts.length && i < 3; i++) {
      html += '<i class="chip-icon ' + denomMeta(parts[i].v).cls + '"></i>';
    }
    return html;
  };

  /** 底池筹码堆：按面额分"摞"渲染（每摞最多 5 枚，超出在摞下方标 ×N）。
   *  由真实底池金额驱动（App.render 每次重绘），因此与底池数字永远一致。 */
  App.renderPotChips = function (amount) {
    var pile = el('potChipsPile');
    if (!pile) return;
    var parts = App.chipBreakdown(amount);
    var html = '';
    for (var i = 0; i < parts.length && i < 5; i++) {
      var meta = denomMeta(parts[i].v);
      var n = parts[i].n;
      var show = Math.min(n, 5);
      var chips = '';
      for (var k = 0; k < show; k++) chips += '<i class="pile-chip ' + meta.cls + '"></i>';
      html += '<span class="pin-stack" title="面额 ' + meta.label + ' × ' + n + ' = ' + (meta.v * n) + '">' +
        '<span class="pin-stack-chips">' + chips + '</span>' +
        '<span class="pin-stack-foot"><span class="pin-stack-label">' + meta.label + '</span>' +
        (n > 5 ? '<span class="pin-stack-count">×' + n + '</span>' : '') +
        '</span></span>';
    }
    pile.innerHTML = html;
  };

  /** 筹码飞入动画：fromEl 中心 → toEl 中心，制造下注/赢钱的沉浸感。
   *  筹码由 amount 的真实面额拆解生成（大面额先飞），总枚数上限 10 枚；
   *  amount <= 0 / 非数字 → 退化为 4 枚灰色筹码（兼容兜底，不崩）。 */
  App.chipFly = function (fromEl, toEl, amount) {
    if (!fromEl || !toEl) return;
    var layer = document.querySelector('.chip-anim-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'chip-anim-layer';
      document.body.appendChild(layer);
    }
    function center(e) {
      var r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    var f = center(fromEl), t = center(toEl);
    // 按面额拆出飞行筹码（大面额在前），上限 10 枚
    var parts = App.chipBreakdown(amount);
    var plan = [];
    for (var i = 0; i < parts.length && plan.length < 10; i++) {
      var take = Math.min(parts[i].n, 10 - plan.length);
      for (var k = 0; k < take; k++) plan.push(denomMeta(parts[i].v));
    }
    if (!plan.length) {
      // 兜底：金额无效时仍飞 4 枚灰筹码，保证不崩
      var gray = { v: 0, cls: 'den-gray', label: '' };
      plan = [gray, gray, gray, gray];
    }
    for (var j = 0; j < plan.length; j++) {
      (function (meta, order) {
        var c = document.createElement('div');
        c.className = 'chip ' + meta.cls;
        var dx = (Math.random() - 0.5) * 30;
        var dy = (Math.random() - 0.5) * 30;
        c.style.left = (f.x + dx - 8) + 'px';
        c.style.top = (f.y + dy - 8) + 'px';
        layer.appendChild(c);
        var start = function () {
          // 双 rAF：确保先完成初始绘制再触发过渡
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              var spread = 16;
              var tx = (t.x - f.x - dx) + (Math.random() - 0.5) * spread;
              var ty = (t.y - f.y - dy) + (Math.random() - 0.5) * spread;
              c.style.transition = 'transform .55s cubic-bezier(.2,.6,.3,1), opacity .55s ease-out';
              c.style.transform = 'translate(' + tx + 'px,' + ty + 'px) rotate(' + (180 + Math.random() * 360) + 'deg)';
              c.style.opacity = '0';
            });
          });
        };
        if (order > 0) setTimeout(start, order * 45);   // 大面额先飞，逐枚错开
        else start();
        setTimeout(function () {
          if (c.parentNode) c.parentNode.removeChild(c);
        }, 700 + order * 45);
      })(plan[j], j);
    }
  };

  // ================= 选桌 =================
  App.openSetup = function () {
    var grid = el('persGrid');
    grid.innerHTML = '';
    Personalities.all().forEach(function (p) {
      var c = document.createElement('div');
      c.className = 'pers-card' + (App.selected.indexOf(p.id) >= 0 ? ' sel' : '');
      c.innerHTML = '<div class="pers-head"><span class="avatar">' + p.avatar + '</span>' +
        '<span class="pers-name">' + esc(p.name) + '</span></div>' +
        '<div class="pers-style">' + Personalities.stars(p.difficulty) + '　' + esc(p.style) + '</div>' +
        '<div class="pers-desc">' + esc(p.desc) + '</div>';
      c.onclick = function () {
        var k = App.selected.indexOf(p.id);
        if (k >= 0) App.selected.splice(k, 1);
        else if (App.selected.length < 5) App.selected.push(p.id);
        App.openSetup();
      };
      grid.appendChild(c);
    });
    el('setupHint').textContent = '已选 ' + App.selected.length + ' / 5';
    var ready = App.selected.length === 5;
    el('btnStartTable').disabled = !ready;
    el('btnStartMatch').disabled = !ready;
    el('modalSetup').classList.remove('hidden');
  };

  App.startTable = function (ids, mode) {
    mode = mode || 'practice';
    App.mode = mode;
    el('modalSetup').classList.add('hidden');
    var matchMode = mode === 'match';
    // 匿名桌：从选桌弹窗读开关（开局生效，整局不变；揭晓状态每局重置）
    var chkAnon = el('chkAnon');
    App.anonMode = !!(chkAnon && chkAnon.checked);
    App.anonymRevealed = false;
    App.seatTags = {};        // 每局重置：玩家手打的对桌标签
    App.syncAnonUi();
    // 赛制：从选桌弹窗读（默认 fast，保证老用户行为不变）
    var selStruct = el('selStructure');
    var structId = (selStruct && selStruct.value) || 'fast';
    var st = Structures.get(structId);
    var initialChips = st.startStack;
    var seats = [{ id: 'you', name: '你', isHuman: true, chips: initialChips }];
    ids.forEach(function (id) {
      var p = Personalities.get(id);
      seats.push({ id: id, name: p.name, avatar: p.avatar, personality: id, chips: initialChips });
    });
    var cfg = { seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: initialChips };
    if (matchMode) {
      cfg.autoRebuy = false;   // 比赛：不补筹，出局即淘汰（重入例外，见 reentry 配置）
      cfg.match = {
        enabled: true,
        structure: st.id,
        roundHands: st.handsPerLevel,
        blindLevels: st.levels,
        payouts: Structures.payoutsFor(st, seats.length),
        allowReentry: st.allowReentry,
        reentryUntilLevel: st.reentryUntilLevel,
        reentryMax: st.reentryMax
      };
    }
    App.game = new Poker.Game(cfg);
    App.initTableTalk();          // 牌桌对话面板：建 DOM + 订阅 game.emit('tableTalk')
    App.seedOppStats();          // 把跨会话累积的对手统计灌进本桌座位
    App.reviews = [];
    App.revealAll = false;
    App.busy = false;
    App.session = { hands: 0, playerWins: 0, bestDelta: -1e9, bestTxt: '', worstDelta: 1e9, worstTxt: '', startChips: initialChips };
    el('log').innerHTML = '';
    App.syncHeader();
    var foes = ids.map(function (i, k) {
      return App.anonActive() ? App.anonCode(k + 1) : Personalities.get(i).name;   // 座位从 1 开始
    }).join('、');
    App.log('牌局开始：你 vs ' + foes + (matchMode ? '（比赛模式 · 每轮 15 手 · 盲注升级 · 无补筹）' : '（练习模式 · 无限手）'));
    App.nextHand();
  };

  App.nextHand = function () {
    if (!App.game) return;
    var g = App.game;
    // 上一手已结算 → 把对手累计统计落盘（首手 handNo=0 不动，避免用 0 覆盖历史）
    if (g.handNo > 0) App.saveOppStats();
    if (g.match && g.match.enabled) {
      if (g.match.over) { App.showFinal(); return; }
      if (g.match.pendingRoundEnd) { App.showRoundResult(); return; }
    }
    App.revealAll = false;
    el('btnNext').classList.add('hidden');
    var pile = el('potChipsPile');
    if (pile) pile.innerHTML = '';   // 新一手：把上一手留在桌上的筹码清掉
    var ok = g.startHand();
    if (ok === false) {
      if (g.match && g.match.over) App.showFinal();
      else if (g.match && g.match.pendingRoundEnd) App.showRoundResult();
      return;
    }
    el('handNo').textContent = g.handNo;
    App.syncHeader();
    App.log('—— 第 ' + g.handNo + ' 手 ——', 'hl');
    App.render();
    App.loop();
  };

  /** 顶栏：盲注 + 比赛轮次标识 */
  App.syncHeader = function () {
    var g = App.game;
    if (!g) return;
    var blindTxt = g.smallBlind + ' / ' + g.bigBlind;
    if (g.ante > 0) blindTxt += ' + Ante ' + g.ante;
    el('blinds').textContent = blindTxt;
    var rt = el('roundTag');
    if (g.match && g.match.enabled) {
      rt.classList.remove('hidden');
      rt.innerHTML = '第 ' + g.match.roundNo + ' 轮' +
        '<span class="rc-pts">积分 ' + (g.match.points[g.playerIndex] || 0) + '</span>';
    } else {
      rt.classList.add('hidden');
    }
    // 距升级盲注倒计时（KPC/快节奏都显示；轮满时隐藏，因即将弹轮次结算）
    var bn = el('blindNext');
    if (bn) {
      var m = g.match;
      if (m && m.enabled && !m.pendingRoundEnd && m.roundNo < (m.blindLevels ? m.blindLevels.length : 0)) {
        var rem = Math.max(0, (m.roundHands || 0) - (m.handsInRound || 0));
        var nxt = m.blindLevels[Math.min(m.roundNo, m.blindLevels.length - 1)];
        bn.classList.remove('hidden');
        bn.textContent = '距升级 ' + rem + ' 手 → ' + nxt.sb + '/' + nxt.bb + (nxt.ante ? ' +' + nxt.ante : '');
      } else {
        bn.classList.add('hidden');
      }
    }
  };

  // ================= 主循环 =================
  App.loop = function () {
    var g = App.game;
    if (!g) return;
    if (g.isHandOver) { App.onHandEnd(); return; }
    if (g.currentActor < 0) { App.onHandEnd(); return; }

    var seat = g.seats[g.currentActor];
    if (seat.isHuman) {
      App.showPlayerActions();
    } else {
      App.busy = true;
      App.disableControls(true);
      App.render();
      // 先决策、后定延时：弃牌/过牌不“装思考”，全下/加注才停顿
      var dec = g.aiDecide(g.currentActor);
      App._aiDecision = { idx: g.currentActor, d: dec };
      var delay;
      if (dec.action === 'fold') delay = 350 + Math.random() * 250;
      else if (dec.action === 'check' || dec.action === 'call') delay = 550 + Math.random() * 350;
      else delay = 750 + Math.random() * 550;   // raise / allin：关键决策多想想
      App.aiTimer = setTimeout(function () { App.doAI(); }, delay);
    }
  };

  App.doAI = function () {
    var g = App.game;
    if (!g || g.isHandOver || g.currentActor < 0) { App.loop(); return; }
    var idx = g.currentActor;
    var seat = g.seats[idx];
    // 用 loop 里预决策的结果（若状态没变），避免二次计算且让延时与动作匹配
    var pd = App._aiDecision;
    var d = (pd && pd.idx === idx) ? pd.d : g.aiDecide(idx);
    App._aiDecision = null;
    // 「反常手」：该座位本手首次行动时，用气泡亮出违和台词（只亮一次）
    var pp = seat.personality;
    var bubbleTxt = d.reason || '……';
    if (pp && pp.quirkNote && !pp._qlog) {
      pp._qlog = true;
      bubbleTxt = '『' + pp.quirkNote + '』';
    }
    App.showBubble(idx, bubbleTxt);
    var before = g.street;
    var c0 = seat.committed;
    g.act(idx, d.action, d.raiseTo, d.reason);
    App.sfx(d.action);   // AI 行动音效（弃/过/跟/加/全下）
    // 沉浸感：AI 跟注/加注/全下 → 按本次真实投入额把筹码从座位飞向底池
    if (d.action === 'call' || d.action === 'raise' || d.action === 'allin') {
      var seatNode = document.querySelector('.seat[data-idx="' + idx + '"]');
      var invested = seat.committed - c0;   // committed 是每手累计，跨街切换也不会被清零
      if (seatNode && invested > 0) App.chipFly(seatNode, el('pot'), invested);
    }
    App.log(esc(App.displayName(seat)) + ' <span class="act-' + (d.action === 'raise' || d.action === 'allin' ? 'raise' : d.action === 'fold' ? 'fold' : '') + '">' +
      actionCN(d.action) + (d.action === 'raise' || d.action === 'allin' ? ' ' + (d.raiseTo || d.amount) : (d.action === 'call' ? ' ' + d.amount : '')) + '</span>' +
      (d.reason ? ' <span class="reason">「' + esc(d.reason) + '」</span>' : ''));
    if (g.street !== before) App.log('★ ' + g.streetCN(g.street) + '：' + Cards.cardsText(g.board), 'hl');
    App.render();
    App.busy = false;
    setTimeout(function () { App.loop(); }, 200);
  };

  App.playerAct = function (action, raiseTo) {
    var g = App.game;
    if (!g || g.currentActor !== g.playerIndex) return;
    var legal = g.legalActions(g.playerIndex);
    var amt = 0;
    if (action === 'raise') amt = Math.min(Math.max(raiseTo || legal.minRaiseTo, legal.minRaiseTo), legal.maxTo);
    var me0 = g.seats[g.playerIndex].committed;
    g.act(g.playerIndex, action, amt, '');
    App.sfx(action);   // 跟注/加注/全下…反馈音（音频上下文在首次用户手势后可用）
    // 沉浸感：投入筹码 → 按本次真实投入额把筹码从手牌区飞向底池
    if (action === 'call' || action === 'raise' || action === 'allin') {
      var invested = g.seats[g.playerIndex].committed - me0;
      if (invested > 0) App.chipFly(el('myHand'), el('pot'), invested);
    }
    App.log('<b>你</b> ' + actionCN(action) + (amt ? ' ' + amt : ''));
    App.render();
    setTimeout(function () { App.loop(); }, 200);
  };

  App.showPlayerActions = function () {
    var g = App.game;
    var legal = g.legalActions(g.playerIndex);
    App.disableControls(false);
    el('btnCheck').style.display = legal.canCheck ? '' : 'none';
    el('btnCall').style.display = legal.canCall ? '' : 'none';
    el('btnCall').textContent = '跟注 ' + legal.toCall;
    el('btnFold').disabled = false;

    var min = legal.minRaiseTo, max = legal.maxTo;
    var num = el('raiseInput');
    if (max > min) {
      num.min = min; num.max = max; num.step = 1;
      // 默认加注额：底池 + 跟注的 ⅔ 处（接近标准 2.2-3BB 开局加注）
      var defaultTarget = g.currentBet + Math.round((legal.pot + legal.toCall) * 0.67);
      num.value = Math.max(min, Math.min(max, defaultTarget));
      num.disabled = false;
      el('btnRaise').disabled = false;
      el('btnHalfPot').disabled = false;
      el('btnTwoThirdPot').disabled = false;
      el('btnFullPot').disabled = false;
    } else {
      num.disabled = true;
      el('btnRaise').disabled = true;
      el('btnHalfPot').disabled = true;
      el('btnTwoThirdPot').disabled = true;
      el('btnFullPot').disabled = true;
      num.value = min;
    }
    App.syncRaise(true);
    App.showCoachTip();
    App.render();
  };

  /** 同步加注数值：clamp 到 [min,max] 并存进 dataset。
   *  @param {boolean=} writeBack 是否把 clamp 结果回写输入框——输入过程中不要回写，否则会打断用户打字 */
  App.syncRaise = function (writeBack) {
    var num = el('raiseInput');
    if (!num) return;
    var lo = parseInt(num.min, 10), hi = parseInt(num.max, 10);
    var v = parseInt(num.value, 10);
    if (isNaN(v)) v = isNaN(lo) ? 0 : lo;
    if (!isNaN(lo) && v < lo) v = lo;
    if (!isNaN(hi) && v > hi) v = hi;
    num.dataset.value = v;
    if (writeBack) num.value = v;
  };

  /** 当前输入框里的加注额（已 clamp） */
  App.raiseAmount = function () {
    var num = el('raiseInput');
    if (!num) return 0;
    var v = parseInt(num.dataset.value, 10);
    if (isNaN(v)) v = parseInt(num.value, 10);
    return isNaN(v) ? 0 : v;
  };

  /** 按底池倍数快速设置加注额（½ 池 / ⅔ 池 / 底池） */
  App.presetRaise = function (frac) {
    if (!App.game) return;
    var g = App.game;
    var legal = g.legalActions(g.playerIndex);
    var stdTarget = g.currentBet + Math.round((legal.pot + legal.toCall) * frac);
    var target = Math.max(legal.minRaiseTo, Math.min(legal.maxTo, stdTarget));
    el('raiseInput').value = target;
    App.syncRaise(true);
  };

  /** 步进调整加注额：+/-10、+/-100（自动 clamp 到合法区间） */
  App.stepRaise = function (delta) {
    var num = el('raiseInput');
    if (!num) return;
    var v = parseInt(num.dataset.value, 10);
    if (isNaN(v)) v = parseInt(num.value, 10);
    if (isNaN(v)) v = parseInt(num.min, 10);
    if (isNaN(v)) v = 0;
    num.value = v + delta;
    App.syncRaise(true);
  };

  App.disableControls = function (disabled) {
    ['btnFold', 'btnCheck', 'btnCall', 'btnRaise', 'btnAllIn', 'btnHalfPot', 'btnTwoThirdPot', 'btnFullPot',
      'raiseInput', 'btnMinus100', 'btnMinus10', 'btnPlus10', 'btnPlus100'].forEach(function (id) {
      var n = el(id);
      if (n) n.disabled = disabled;
    });
  };

  // ================= 胜率助手（我的回合显示「会输给什么牌」）=================
  /**
   * 更新右侧胜率助手：仅在我的回合（或勾选「固定」时）展示。
   * 计算有缓存：街/牌面/我的底牌/对手数不变则不重算，避免每帧穷举。
   */
  App.updateOddsPanel = function () {
    var wrap = el('oddsWrap');
    var g = App.game;
    if (!g) { wrap.classList.add('hidden'); return; }
    var seat = g.seats[g.playerIndex];
    var myTurn = g.currentActor === g.playerIndex && !g.isHandOver;
    var pinned = !!el('chkOddsPin').checked;
    var show = !!seat && !seat.folded && seat.hole && seat.hole.length === 2 && !g.isHandOver && (myTurn || pinned);
    if (!show) {
      wrap.classList.add('hidden');
      App.oddsKey = '';
      return;
    }
    wrap.classList.remove('hidden');
    var body = el('oddsBody');
    if (App.oddsCollapsed) { body.classList.add('hidden'); return; }
    body.classList.remove('hidden');

    var nOpp = g.numOpponents(seat);
    var key = g.street + '|' + nOpp + '|' +
      seat.hole[0].r + ':' + seat.hole[0].s + ',' + seat.hole[1].r + ':' + seat.hole[1].s + '|' +
      g.board.map(function (c) { return c.r + ':' + c.s; }).join(',');

    // 已有缓存（同步命中）→ 直接渲染
    if (key === App.oddsKey && App.oddsCache) {
      body.innerHTML = App.oddsHtml(App.oddsCache);
      return;
    }
    // 该 key 正在后台(Worker)计算 → 避免重复发起
    if (key === App.oddsPendingKey) return;

    App.oddsPendingKey = key;
    body.innerHTML = '<div class="odds-note">计算中…</div>';

    var reqKey = key;
    var hole = seat.hole.slice();
    var board = g.board.slice();
    try {
      // 重计算(深筹码 KPC 穷举/蒙特卡洛)移到后台线程，主线程不冻结；
      // 浏览器不支持 Worker(file:// 等)时 computeAsync 自动同步回退。
      Poker.Equity.computeAsync({
        type: 'oddsPanel',
        payload: { hole: hole, board: board, numOpponents: nOpp, iterations: 600 }
      }).then(function (data) {
        if (App.oddsPendingKey !== reqKey) return; // 已被更新的请求取代
        App.oddsPendingKey = '';
        if (!data) {
          body.innerHTML = '<div class="odds-note">暂时无法计算胜率。</div>';
          return;
        }
        App.oddsKey = reqKey;
        App.oddsCache = data;
        // 仍应展示且未被折叠时才写回（用当前 game 引用判断，避免跨局串台）
        if (App.game === g && !App.oddsCollapsed && !body.classList.contains('hidden')) {
          body.innerHTML = App.oddsHtml(data);
        }
      });
    } catch (e) {
      App.oddsPendingKey = '';
      body.innerHTML = '<div class="odds-note">暂时无法计算胜率。</div>';
    }
  };

  /** 把 oddsPanel 结果渲染成教学面板 HTML（纯文本 + 少量 span） */
  App.oddsHtml = function (d) {
    var html = '';
    var eqTxt = pct(d.equity1);
    // flop/turn 的大数字是「按当前牌面」的成牌胜率（非打到河牌的真实胜率），加小标签区分口径
    var nowLabel = (!d.preflop && d.street !== 'river')
      ? '<span class="od-now" title="按当前已发公共牌比大小，不含后续街反超">当前牌面</span>'
      : '';
    var nLine = d.numOpponents > 1
      ? '　vs ' + d.numOpponents + ' 人 <span class="od-approx">≈ ' + pct(d.equityN) + '%</span>'
      : '';
    html += '<div class="odds-eq">vs 1 个随机对手 <b>' + eqTxt + '%</b>' + nowLabel + nLine + '</div>';

    if (d.preflop) {
      html += '<div class="odds-hole">我的起手牌：<b>' + esc(d.holeDesc) + '</b></div>' +
        '<div class="odds-note">翻牌前公共牌未发，无法列出具体会输给的牌。</div>' +
        '<div class="odds-how">怎么算的：把还没看到的牌发给 1 个对手，一路发到河牌反复模拟比大小，我赢的次数 ÷ 模拟次数 ≈ 胜率。翻牌前只需要把胜率跟跟注赔率比：胜率更高就跟注或加注，否则弃牌。</div>';
      return html;
    }

    // 翻牌/转牌/河牌：列出“会输给什么牌”
    var loseH = d.street === 'river' ? '我会输给什么牌' : '我会输给什么牌（按当前牌面）';
    html += '<div class="odds-lose-h">' + loseH + '</div>';
    if (d.beats.length) {
      var top = d.beats.slice(0, 5);
      var chips = '';
      var loses = d.loses || 1;
      for (var i = 0; i < top.length; i++) {
        var b = top[i];
        // 你也是高牌时，输给“高牌”实际上是输给更大的踢脚，文案要说明白
        var chipName = (b.rank === 0 && d.myMadeRank === 0) ? '高牌（踢脚更大）' : b.name;
        // 百分比 = 该牌型在“会输我的牌”里的占比，这样所有芯片加起来是 100%，更直观
        var condPct = (b.count / loses * 100).toFixed(1);
        chips += '<span class="odds-chip">' + esc(chipName) + ' ' + b.count + '（' + condPct + '%）</span>';
      }
      html += '<div class="odds-beats">' + chips + '</div>';
      html += '<div class="odds-note">百分比 = 该牌型在“会输我的牌”里占比</div>';
    } else {
      html += '<div class="odds-none">当前牌面没有对手能赢你</div>';
    }
    html += '<div class="odds-tie">平局 <b>' + pct(d.tiePct) + '%</b>　含平局折半我赢 <b>' + eqTxt + '%</b>　（我当前成牌：' + esc(d.myMadeName) + '）</div>';

    var later = d.street === 'turn' ? '河牌仍可能反超我' : '转牌、河牌仍可能反超我';
    var how = d.street === 'river'
      ? '怎么算的：把每张没看到的牌两两发给 1 个对手，与公共牌凑成 7 张比大小：我赢的次数 + 平局一半 ÷ ' + d.total + ' 种组合 = 单挑胜率（河牌已发完，精确无误）。'
      : '怎么算的：把每张没看到的牌两两当作对手底牌，与当前公共牌凑牌比大小：我赢的次数 + 平局一半 ÷ ' + d.total + ' 种组合 = 当前牌面胜率。' + later + '，真实到河牌胜率请参考左侧「教学提示」。';
    html += '<div class="odds-how">' + how + '</div>';
    return html;
  };

  // ================= 牌桌对话面板（订阅 game.emit('tableTalk')）=================
  // 说明：game.js 的 emit 仅把事件压入 this.events，并无 on() 订阅机制。
  // 这里在不改动 game.js 的前提下，包装 App.game.emit 增加监听器分发，
  // 供 AI 大脑（另一 worker 负责）emit('tableTalk', {seatIndex,name,text,kind}) 时实时渲染。
  // kind: bluff(橙) | badbeat(红) | steal(蓝) | reentry(紫) | generic(灰)
  App.initTableTalk = function () {
    if (!App._ttEl) {
      var box = document.createElement('div');
      box.className = 'table-talk';
      box.id = 'tableTalk';
      var head = document.createElement('div');
      head.className = 'table-talk-head';
      var title = document.createElement('span');
      title.textContent = '牌桌对话';
      var toggle = document.createElement('span');
      toggle.className = 'table-talk-toggle';
      toggle.textContent = '▾';
      toggle.onclick = function () {
        box.classList.toggle('collapsed');
        toggle.textContent = box.classList.contains('collapsed') ? '▸' : '▾';
      };
      head.appendChild(title);
      head.appendChild(toggle);
      var log = document.createElement('div');
      log.className = 'table-talk-log';
      box.appendChild(head);
      box.appendChild(log);
      document.body.appendChild(box);
      App._ttEl = box;
      App._ttLog = log;
    }
    App.installTableTalkListener();
  };

  App.installTableTalkListener = function () {
    var g = App.game;
    if (!g || g._ttInstalled) return;
    var origEmit = Poker.Game.prototype.emit;
    g.emit = function (type, data) {
      var ev = origEmit.call(g, type, data); // 保留原行为：压入 this.events
      var hs = App._ttHandlers;
      if (hs && hs[type]) {
        var ls = hs[type];
        for (var i = 0; i < ls.length; i++) {
          try { ls[i](data, ev); } catch (e) { /* 单条监听异常不影响其余 */ }
        }
      }
      return ev;
    };
    g.on = function (type, cb) {
      App._ttHandlers = App._ttHandlers || {};
      (App._ttHandlers[type] = App._ttHandlers[type] || []).push(cb);
    };
    g._ttInstalled = true;
    App._ttHandlers = {}; // 新一局重置监听，避免跨局重复
    g.on('tableTalk', function (data) { App.addTableTalk(data); });
  };

  App.addTableTalk = function (data) {
    if (!data) return;
    var log = App._ttLog;
    if (!log) return;
    var line = document.createElement('div');
    var kind = data.kind || 'generic';
    line.className = 'table-talk-line tt-' + kind;
    var name = data.name || (data.seatIndex != null ? ('座位' + (data.seatIndex + 1)) : '');
    line.textContent = name + '：' + (data.text || '');
    log.appendChild(line);
    while (log.childNodes.length > 60) log.removeChild(log.firstChild); // 限长，避免无限增长
    log.scrollTop = log.scrollHeight;
  };

  App.showCoachTip = function () {
    var g = App.game;
    if (!g) return;
    var box = el('coachTip');
    if (!el('chkCoach').checked) { box.innerHTML = '<span class="why">（教学提示已关闭）</span>'; return; }
    var s = Coach.suggest(g);
    if (!s) { box.innerHTML = ''; return; }
    if (g.street === 'preflop') {
      box.innerHTML = '<span>建议：<b>' + s.actionCN + '</b></span><span class="why">' + esc(s.text) + '　' + esc(s.why) + '</span>';
    } else {
      box.innerHTML = '<span>胜率 <b>' + pct(s.equity) + '%</b>　底池赔率 <b>' + pct(s.potOdds) + '%</b>　建议：<b>' + s.actionCN + '</b></span>' +
        '<span class="why">' + esc(s.why) + '</span>';
    }
  };

  App.showBubble = function (seatIndex, text) {
    App.clearBubble();
    if (!text) return;
    var node = document.querySelector('.seat[data-idx="' + seatIndex + '"]');
    if (!node) return;
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    node.appendChild(b);
    App.bubbleTimer = setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 3200);
  };

  App.clearBubble = function () {
    if (App.bubbleTimer) clearTimeout(App.bubbleTimer);
    var bs = document.querySelectorAll('.bubble');
    for (var i = 0; i < bs.length; i++) bs[i].parentNode.removeChild(bs[i]);
  };

  // ================= 手牌结束 =================
  App.onHandEnd = function () {
    var g = App.game;
    var result = g.lastResult;
    App.clearBubble();
    App.disableControls(true);
    App.revealAll = true;
    App.render();

    // 沉浸感：本手赢了 → 按真实赢得的金额把筹码从底池飞回手牌区
    if (result && result.playerDelta > 0) {
      var winAmt = 0;
      (result.winners || []).forEach(function (w) {
        if (w.seatIndex === g.playerIndex) winAmt += w.amount;
      });
      if (winAmt <= 0) winAmt = result.playerDelta;
      App.sfx('win');
      setTimeout(function () { App.chipFly(el('pot'), el('myHand'), winAmt); }, 200);
    }

    if (result) {
      var winners = result.winners || [];
      if (winners.length) {
        var txt = winners.map(function (w) {
          return esc(App.displayName(w)) + ' 赢 ' + w.amount + (w.handName ? '（' + esc(w.handName) + '）' : '');
        }).join('、');
        App.log('★ ' + txt, 'act-win');
      }
      var review = Review.build(result, g);
      App.reviews.push(review);
      if (App.reviews.length > 30) App.reviews.shift();
      App.rvIdx = App.reviews.length - 1;
      App.stats = Review.updateStats(App.stats, review);
      App.saveStats();

      // —— 本局战绩聚合（「战绩」小结 / 导出用）——
      var ss = App.session;
      if (ss) {
        ss.hands++;
        if (result.playerDelta > 0) ss.playerWins++;
        if (result.playerDelta > ss.bestDelta) {
          ss.bestDelta = result.playerDelta;
          ss.bestTxt = (result.playerDelta > 0 ? '+' : '') + result.playerDelta + ' ｜ ' + review.summary;
        }
        if (result.playerDelta < ss.worstDelta) {
          ss.worstDelta = result.playerDelta;
          ss.worstTxt = String(result.playerDelta) + ' ｜ ' + review.summary;
        }
      }

      var d = result.playerDelta;
      App.log('本手盈亏：' + (d > 0 ? '+' : '') + d + ' ｜ ' + esc(review.summary), d > 0 ? 'act-win' : '');
    }

    var inMatch = !!(g.match && g.match.enabled);
    if (inMatch) {
      App.syncHeader();
      if (g.match.over) { App.showFinal(); return; }          // 比赛结束 → 最终排名
      if (g.match.pendingRoundEnd) { App.showRoundResult(); return; } // 轮满 → 轮次结算
      var meM = g.seats[g.playerIndex];
      if (meM.chips <= 0) App.log('你已被淘汰，接下来以旁观视角继续比赛。', 'hl');
      // 重入：人类筹码归零且赛制允许 → 浮出「重入」按钮（AI 已在后台自动重入）
      var reBtn = el('btnReentry');
      if (reBtn) {
        if (g.match.pendingReentry && g.match.pendingReentry[g.playerIndex]) {
          reBtn.classList.remove('hidden');
          reBtn.onclick = function () { App.doReentry(); };
          App.log('你在可重入窗口内筹码归零，可点击「重入」以起始筹码继续比赛。', 'hl');
        } else {
          reBtn.classList.add('hidden');
        }
      }
      el('btnNext').textContent = '下一手';
      el('btnNext').onclick = function () { App.nextHand(); };
      el('btnNext').classList.remove('hidden');
      setTimeout(function () { if (App.rvIdx >= 0) App.showReview(App.rvIdx); }, 900);
      return;
    }

    // ---- 练习模式（原逻辑不变）----
    var me = g.seats[g.playerIndex];
    if (me.chips <= 0) {
      App.log('你的筹码已耗尽，牌局结束。可以重新选桌再来一局。', 'hl');
      el('btnNext').textContent = '重新开局';
      el('btnNext').onclick = function () { App.openSetup(); };
    } else {
      el('btnNext').textContent = '下一手';
      el('btnNext').onclick = function () { App.nextHand(); };
    }
    el('btnNext').classList.remove('hidden');
    setTimeout(function () { App.showReview(App.rvIdx); }, 900);
  };

  // ================= 比赛模式（轮次结算 / 最终排名）=================
  /** 轮末结算弹窗 */
  App.showRoundResult = function () {
    var g = App.game;
    if (!g || !g.match) return;
    App.revealIdentities(true);   // 比赛：每轮结算自动揭晓
    var standings = g.match.lastStandings || g.finalStandings();
    el('rRoundNo').textContent = g.match.roundNo;
    var elimNames = (g.match.roundBustOrder || []).map(function (i) {
      return g.seats[i] ? App.displayName(g.seats[i]) : '';
    }).filter(function (n) { return n; }).join('、');
    var subTxt = '盲注 ' + g.smallBlind + ' / ' + g.bigBlind;
    if (g.ante > 0) subTxt += ' · Ante ' + g.ante;
    subTxt += ' · 本轮共 ' + (g.match.handsInRound) + ' 手' + (elimNames ? ' · 出局：' + elimNames : '');
    el('roundSub').textContent = subTxt;
    var html = standHeaderHtml(false) + standings.map(function (row) { return standRowHtml(row, false); }).join('');
    el('roundBody').innerHTML = html;
    var top = standings[0];
    el('roundLeader').innerHTML = top && !top.eliminated
      ? '本轮领先：<b>' + esc(App.displayName(top)) + '</b>　筹码 ¥' + top.chips
      : '';
    // 只剩 1 人时不应走轮次弹窗（会直接进最终排名），此处保险起见
    var quit = el('btnMatchQuit'), nxt = el('btnNextRound');
    if (g.match.over) {
      quit.style.display = 'none'; nxt.style.display = 'none';
      nxt.textContent = '查看最终排名';
      nxt.onclick = function () { App.showFinal(); };
    } else {
      quit.style.display = ''; nxt.style.display = '';
      nxt.textContent = '开始下一轮';
      nxt.onclick = function () { App.nextRound(); };
    }
    el('modalRound').classList.remove('hidden');
  };

  /** 开始下一轮（盲注升级、手数清零） */
  App.nextRound = function () {
    var g = App.game;
    if (!g || !g.match) return;
    el('modalRound').classList.add('hidden');
    var ok = g.startNextRound();
    if (!ok) { App.showFinal(); return; }
    App.syncHeader();
    App.nextHand();
  };

  /** 人类重入：把筹码重置为起始筹码，留在比赛里 */
  App.doReentry = function () {
    var g = App.game;
    if (!g || !g.match) return;
    var ok = g.reenter(g.playerIndex);
    var reBtn = el('btnReentry');
    if (reBtn) reBtn.classList.add('hidden');
    if (!ok) { App.toast('当前不可重入（已过窗口或次数用尽）'); return; }
    App.toast('已重入，筹码重置为 ' + (g.match.startStack || g.initialChips));
    App.syncHeader();
    App.render();
    // 重入后立刻开下一手
    el('btnNext').textContent = '下一手';
    el('btnNext').onclick = function () { App.nextHand(); };
    el('btnNext').classList.remove('hidden');
  };

  /** 最终排名弹窗 */
  App.showFinal = function () {
    var g = App.game;
    if (!g) return;
    App.revealIdentities(true);   // 比赛结束自动揭晓
    var standings = g.finalStandings();
    var champ = standings[0] || null;
    var html = '';
    if (champ) {
      html += '<div class="final-hero">' +
        '<div class="fa-avatar">' + App.anonAvatar(champ) + '</div>' +
        '<div class="fa-title">' + esc(App.displayName(champ)) + ' 夺冠</div>' +
        '<div class="fa-sub">累计积分 ' + champ.totalPts + ' · 剩余筹码 ¥' + champ.chips + '</div>' +
        '</div>';
    }
    html += standHeaderHtml(true) + standings.map(function (row) { return standRowHtml(row, true); }).join('');
    el('finalBody').innerHTML = html;
    el('modalRound').classList.add('hidden');   // 从轮次弹窗进入最终排名时关闭轮次弹窗
    App.saveOppStats();                          // 终局落盘对手统计
    el('modalFinal').classList.remove('hidden');
  };

  /** 返回选桌（清理比赛状态） */
  App.backLobby = function () {
    App.saveOppStats();   // 离桌前把对手统计落盘
    if (App.aiTimer) clearTimeout(App.aiTimer);
    if (App.bubbleTimer) clearTimeout(App.bubbleTimer);
    el('modalFinal').classList.add('hidden');
    el('modalRound').classList.add('hidden');
    App.game = null;
    App.reviews = [];
    App.mode = 'practice';
    App.busy = false;
    App.anonMode = false;
    App.anonymRevealed = false;
    App.syncAnonUi();
    el('roundTag').classList.add('hidden');
    App.openSetup();
  };

  /** 榜单表头（final=true 时不含“本轮”列） */
  function standHeaderHtml(isFinal) {
    return '<div class="stand-hdr">' +
      '<span class="stand-rank">#</span>' +
      '<span class="stand-avatar"></span>' +
      '<span class="stand-name">玩家</span>' +
      '<span class="stand-chips">筹码</span>' +
      (isFinal ? '' : '<span class="stand-delta">本轮</span>') +
      '<span class="stand-pts">' + (isFinal ? '总分' : '积分') + '</span>' +
      '</div>';
  }

  /** 榜单行 */
  function standRowHtml(row, isFinal) {
    var rankCls = row.rank === 1 ? ' r1' : row.rank === 2 ? ' r2' : row.rank === 3 ? ' r3' : '';
    var rowCls = 'stand-row';
    if (row.isHuman) rowCls += ' me';
    if (row.eliminated) rowCls += ' out';
    var nameHtml = esc(App.displayName(row)) + (row.isHuman ? '<span class="y-badge">你</span>' : '');
    var avatar = App.anonAvatar(row);
    var html = '<div class="' + rowCls + '">' +
      '<span class="stand-rank' + rankCls + '">' + row.rank + '</span>' +
      '<span class="stand-avatar">' + avatar + '</span>' +
      '<span class="stand-name">' + nameHtml + '</span>' +
      '<span class="stand-chips">' + row.chips + '</span>';
    if (!isFinal) {
      var dCls = row.roundDelta > 0 ? ' up' : (row.roundDelta < 0 ? ' down' : '');
      var deltaTxt = row.roundDelta > 0 ? '+' + row.roundDelta : String(row.roundDelta);
      html += '<span class="stand-delta' + dCls + '">' + deltaTxt + '</span>';
    }
    html += '<span class="stand-pts">' +
      (!isFinal && row.roundPts > 0 ? '<small>+' + row.roundPts + '</small>' : '') +
      row.totalPts + '</span></div>';
    return html;
  }

  // ================= 渲染 =================
  App.render = function () {
    var g = App.game;
    if (!g) return;
    App.renderSeats();
    App.renderBoard();
    App.renderMyHand();
    el('pot').textContent = g.potTotal();
    App.renderPotChips(g.potTotal());
    el('streetLabel').textContent = g.streetCN(g.street);
    el('myChips').textContent = g.seats[g.playerIndex].chips;
    App.updateOddsPanel();
    App.syncScale();
  };

  /** 桌面上的玩家大牌区（座位从座排行里移到这里，牌翻开朝上） */
  App.renderMyHand = function () {
    var g = App.game;
    var seat = g.seats[g.playerIndex];
    var box = el('myCards');
    box.innerHTML = '';
    if (seat.hole && seat.hole.length) {
      for (var i = 0; i < 2; i++) {
        var c = seat.hole[i];
        if (c) box.appendChild(cardEl(c, false, true));
        else {
          var ph = document.createElement('div');
          ph.className = 'card fancy empty';
          box.appendChild(ph);
        }
      }
    } else {
      for (var k = 0; k < 2; k++) {
        var ph2 = document.createElement('div');
        ph2.className = 'card fancy empty';
        box.appendChild(ph2);
      }
    }
    var t = el('myChipsT');
    if (t) t.textContent = '¥' + seat.chips;
    var state = [];
    if (seat.folded) state.push('<span class="st-fold">已弃牌</span>');
    else if (seat.allIn) state.push('<span class="st-allin">ALL-IN</span>');
    if (seat.bet > 0 && !seat.folded) state.push('<span class="st-bet">已投 ' + seat.bet + '</span>');
    if (g.currentActor === g.playerIndex && !g.isHandOver) state.push('<span class="st-act">轮到你了</span>');
    el('myState').innerHTML = state.join('　');
    // 人类也显示 庄 Puck + 本手已投（玩家不在 .seat 列表里，需要单独显示）
    var bar = el('myHand').querySelector('.mh-bar');
    if (bar) {
      var meta = bar.querySelector('.mh-meta');
      if (!meta) { meta = document.createElement('span'); meta.className = 'mh-meta'; bar.appendChild(meta); }
      var pp = [];
      if (seat.role === 'D') pp.push('<span class="role-puck r-D" title="庄">庄</span>');
      else if (seat.role === 'SB') pp.push('<span class="role-puck r-SB" title="小盲">小盲</span>');
      else if (seat.role === 'BB') pp.push('<span class="role-puck r-BB" title="大盲">大盲</span>');
      if (seat.committed && seat.committed > 0) pp.push('<span class="seat-committed">' + seat.committed + '</span>');
      meta.innerHTML = pp.join('');
    }
    var zone = el('myHand');
    zone.className = 'my-hand';
    if (g.currentActor === g.playerIndex && !g.isHandOver) zone.className += ' active';
    if (seat.folded) zone.className += ' folded';
    if (seat.allIn) zone.className += ' allin';
  };

  App.renderBoard = function () {
    var g = App.game;
    var box = el('board');
    box.innerHTML = '';
    for (var i = 0; i < 5; i++) {
      var c = g.board[i];
      if (c) box.appendChild(cardEl(c));
      else {
        var e = document.createElement('div');
        e.className = 'card empty';
        box.appendChild(e);
      }
    }
  };

  App.renderSeats = function () {
    var g = App.game;
    var top = el('rowTop'), bottom = el('rowBottom');
    top.innerHTML = ''; bottom.innerHTML = '';
    var n = g.seats.length;
    var ais = [];
    for (var i = 1; i < n; i++) ais.push(i);   // 玩家座位已独立到桌面 myHand 区
    var half = Math.ceil(ais.length / 2);
    ais.slice(0, half).forEach(function (i) { top.appendChild(App.seatEl(g.seats[i])); });
    ais.slice(half).forEach(function (i) { bottom.appendChild(App.seatEl(g.seats[i])); });
  };

  // ================= 对手 HUD（C2）=================
  /** 由座位客观统计派生 HUD 显示值；hands<5 / 分母 0 → '–' */
  App.hudData = function (s) {
    var st = s && s.stats;
    if (!st) return null;
    var hands = st.hands || 0;
    var vpipTxt = '–', pfrTxt = '–', f2cTxt = '–';
    if (hands >= 1) {
      // 1 手起就显示真实百分比（早期波动大但比"啥也不显示"更直观）
      vpipTxt = Math.round((st.vpip || 0) / hands * 100) + '%';
      pfrTxt = Math.round((st.pfr || 0) / hands * 100) + '%';
      if ((st.cBetFaced || 0) > 0) f2cTxt = Math.round((st.foldToCBet || 0) / st.cBetFaced * 100) + '%';
    }
    return {
      hands: hands,
      vpip: vpipTxt,
      pfr: pfrTxt,
      f2c: f2cTxt,
      tooltip: '手数 ' + hands +
        '｜入池 ' + vpipTxt +
        '｜翻前加注 ' + pfrTxt +
        '｜3bet ' + (st.threeBet || 0) + ' 次' +
        '｜面对c-bet弃牌 ' + f2cTxt +
        '｜摊牌 ' + (st.showdowns || 0) + ' 次'
    };
  };

  /** HUD 徽标 HTML（两格：入池 / 翻前加注；完整统计放 title 悬浮） */
  App.hudBadgeHtml = function (hud) {
    if (!hud) return '';
    return '<div class="hud-mini" title="' + esc(hud.tooltip) + '">' +
      '<span>入池 ' + esc(hud.vpip) + '</span>' +
      '<span>加注 ' + esc(hud.pfr) + '</span>' +
      '</div>';
  };

  App.seatEl = function (s) {
    var g = App.game;
    var div = document.createElement('div');
    div.className = 'seat';
    div.setAttribute('data-idx', s.index);
    if (s.index === g.currentActor && !g.isHandOver) div.className += ' active';
    if (s.folded) div.className += ' folded';
    if (s.isHuman) div.className += ' is-me';
    // 匿名桌：AI 换成代号 + 面具头像，并隐藏人格风格（HUD 统计照常显示）
    var anon = App.anonActive() && !s.isHuman;
    if (anon) div.className += ' anon';

    var p = s.personality;
    var moodCls = '';
    if (s.mood <= -25) moodCls = 'hot';
    else if (s.mood >= 25) moodCls = 'good';
    var moodTxt = p ? (Personalities.moodEmoji(s.mood) + ' ' + (s.moodLabel || '平静')) : '';

    // C2 迷你 HUD：对手客观数据徽标（仅 bot；hands<5 显示 –）
    var hud = (p && !s.isHuman) ? App.hudData(s) : null;

    var styleHtml = anon
      ? ''   // 匿名：不显示人格风格（否则等于泄底）
      : (p ? '<div class="seat-style">' + Personalities.stars(p.difficulty) + ' ' + esc(p.style) + '</div>'
        : '<div class="seat-style">你</div>');

    // 角色 puck：庄/小盲/大盲 + 我的上家（永远标记玩家上家，让你一眼看清行动方向）
    var pucks = [];
    if (s.role === 'D' || s.role === 'SB' || s.role === 'BB') {
      var rLbl = s.role === 'D' ? '庄' : (s.role === 'SB' ? '小盲' : '大盲');
      pucks.push('<span class="role-puck r-' + s.role + '" title="' + rLbl + '">' + rLbl + '</span>');
    }
    var upIdx = (g.playerIndex - 1 + g.seats.length) % g.seats.length;
    if (s.index === upIdx && !s.isHuman) {
      pucks.push('<span class="role-puck up" title="你的上家">上家</span>');
    }
    var pucksHtml = pucks.length ? '<span class="role-pucks">' + pucks.join('') + '</span>' : '';
    var committedHtml = (s.committed && s.committed > 0) ? '<div class="seat-committed">' + s.committed + '</div>' : '';

    var html = '<div class="seat-top">' +
      '<span class="avatar">' + App.anonAvatar(s) + '</span>' +
      pucksHtml +
      '<div style="min-width:0">' +
      '<div class="seat-name">' + esc(App.displayName(s)) + '</div>' +
      styleHtml +
      '</div></div>' +
      '<div class="seat-line"><span class="chips">¥' + s.chips + '</span>' +
      (moodTxt ? '<span class="mood ' + moodCls + '">' + moodTxt + '</span>' : '') + '</div>' +
      committedHtml +
      (hud ? App.hudBadgeHtml(hud) : '') +
      '<div class="hole"></div>';

    if (s.folded && !s.isHuman) {
      // 弃牌状态角标
    }
    div.innerHTML = html;

    // 底牌：玩家底牌统一在下方大牌区展示（座位只显示牌背），避免双份
    var hole = div.querySelector('.hole');
    var show = !s.isHuman && App.revealAll && !s.folded;
    for (var k = 0; k < 2; k++) {
      var c = s.hole[k];
      if (!c) {
        var ph = document.createElement('div');
        ph.className = 'card small empty';
        hole.appendChild(ph);
      } else if (show) {
        hole.appendChild(cardEl(c, true));
      } else {
        var bk = document.createElement('div');
        bk.className = 'card small back';
        hole.appendChild(bk);
      }
    }

    if (s.bet > 0) {
      var betText = s.lastAction || s.bet;
      var bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.innerHTML = App.betChipHtml(s.bet) + ' ' + esc(betText);
      div.appendChild(bet);
    }
    // 过牌：单独一个小状态徽标（与弃牌/全下徽标并列，但不与主下注徽标冲突）
    if (s.lastAction === '过牌' && !s.folded && !s.allIn) {
      var chk = document.createElement('div');
      chk.className = 'seat-status check';
      chk.textContent = '过牌';
      div.appendChild(chk);
    }
    if (s.allIn && !s.folded) {
      var st = document.createElement('div');
      st.className = 'seat-status allin';
      st.textContent = 'ALL-IN';
      div.appendChild(st);
    } else if (s.folded) {
      var st2 = document.createElement('div');
      st2.className = 'seat-status';
      st2.textContent = '弃牌';
      div.appendChild(st2);
    }

    // 与玩家的关系（记仇 / 拿捏）
    if (p && s.relations) {
      var rel = s.relations['you'] || 0;
      if (Math.abs(rel) >= 25) {
        var r = document.createElement('div');
        r.className = 'seat-relation ' + (rel < 0 ? 'grudge' : 'bully');
        r.textContent = rel < 0 ? '⚔ 盯上你' : '🎯 拿捏你';
        r.title = rel < 0 ? '他记住你了，会对你更凶、更不愿弃牌' : '他觉得你好欺负，会更频繁地偷你的池';
        div.appendChild(r);
      }
    }

    // 玩家手打标签徽标（紧凶 / 浪 / 鱼 …）：点击座位即可编辑
    var tag = App.seatTags ? App.seatTags[s.index] : null;
    if (tag) {
      var tg = document.createElement('div');
      tg.className = 'seat-tag';
      tg.textContent = '🏷 ' + tag;
      tg.title = '点击座位可修改 / 清除标签';
      div.appendChild(tg);
    }
    // 点击整个座位 → 打开标注弹窗（边打边记牌）
    div.classList.add('taggable');
    div.addEventListener('click', function () { App.openTag(s.index); });
    return div;
  };

  // ================= 对手标注（需求：点击座位打标签）=================
  App.tagTargetIdx = -1;
  var TAG_PRESETS = ['紧凶', '松凶', '紧弱', '松弱', '浪', '鱼', '岩石', 'GTO', '其他'];

  /** 打开标注弹窗，针对座位 idx */
  App.openTag = function (idx) {
    var s = App.game && App.game.seats ? App.game.seats[idx] : null;
    if (!s) return;
    App.tagTargetIdx = idx;
    var box = el('tagPresets');
    box.innerHTML = '';
    TAG_PRESETS.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tag-preset' + (App.seatTags && App.seatTags[idx] === t ? ' on' : '');
      b.textContent = t;
      b.onclick = function () { App.applyTag(idx, t); };
      box.appendChild(b);
    });
    el('tagTitle').textContent = '给「' + App.displayName(s) + '」打个标签，帮助边打边记牌';
    el('tagCustom').value = (App.seatTags && App.seatTags[idx]) ? App.seatTags[idx] : '';
    el('modalTag').classList.remove('hidden');
  };

  /** 写入 / 更新标签（text 为空则清除） */
  App.applyTag = function (idx, text) {
    text = (text || '').trim();
    if (text) App.seatTags[idx] = text;
    else delete App.seatTags[idx];
    el('modalTag').classList.add('hidden');
    if (App.game) App.render();
  };

  /** 清除标签 */
  App.clearTag = function (idx) {
    delete App.seatTags[idx];
    el('modalTag').classList.add('hidden');
    if (App.game) App.render();
  };

  // ================= 本局战绩小结 / 导出 =================
  /** 计算本局各座位相对起始筹码的盈亏行 */
  App.sessionRows = function () {
    var g = App.game;
    var rows = [];
    if (!g || !g.seats) return rows;
    var start = (App.session && App.session.startChips) || g.config.initialChips || 2000;
    for (var i = 0; i < g.seats.length; i++) {
      var s = g.seats[i];
      if (!s) continue;   // 出局淘汰者仍列出（chips=0 即真实亏损）
      rows.push({
        idx: s.index, name: App.displayName(s), avatar: App.anonAvatar(s),
        isHuman: s.isHuman, delta: (s.chips || 0) - start
      });
    }
    return rows;
  };

  App.showSessionSummary = function () {
    if (!App.game) { App.toast('还没有进行中的牌局'); return; }
    var g = App.game;
    var ss = App.session || {};
    var mode = App.mode === 'match' ? '比赛' : '练习';
    var rows = App.sessionRows();
    var cards = '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="v">' + ss.hands + '</div><div class="k">本局手数</div></div>' +
      '<div class="stat-cell"><div class="v">' + (ss.playerWins || 0) + '</div><div class="k">你赢下的手</div></div>' +
      '<div class="stat-cell"><div class="v">' + g.handNo + '</div><div class="k">当前第几手</div></div>' +
      '</div>';
    var list = rows.map(function (r) {
      var dCls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : '';
      var sign = r.delta > 0 ? '+' : '';
      return '<div class="ss-row' + (r.isHuman ? ' me' : '') + '">' +
        '<span class="ss-avatar">' + r.avatar + '</span>' +
        '<span class="ss-name">' + esc(r.name) + (r.isHuman ? ' <b>(你)</b>' : '') + '</span>' +
        '<span class="ss-delta ' + dCls + '">' + sign + r.delta + '</span>' +
        '</div>';
    }).join('');
    var best = ss.bestTxt ? '<div class="ss-best"><b>🥇 最优一手</b>　' + esc(ss.bestTxt) + '</div>' : '';
    var worst = ss.worstTxt ? '<div class="ss-best"><b>🥴 最差一手</b>　' + esc(ss.worstTxt) + '</div>' : '';
    el('sessionMeta').textContent = '模式：' + mode + '（' + (ss.startChips || 0) + ' 筹码开局）';
    el('sessionBody').innerHTML = cards + '<div class="ss-list">' + list + '</div>' + best + worst;
    el('modalSession').classList.remove('hidden');
  };

  /** 战绩 → 纯文本（复制用） */
  App.sessionText = function () {
    var g = App.game, ss = App.session || {};
    var lines = [];
    lines.push('德州扑克 AI 对战 · 本局战绩');
    lines.push('时间：' + new Date().toLocaleString('zh-CN') + '　模式：' + (App.mode === 'match' ? '比赛' : '练习'));
    lines.push('手数：' + ss.hands + '　你赢下：' + (ss.playerWins || 0) + ' 手');
    App.sessionRows().forEach(function (r) {
      lines.push((r.isHuman ? '你' : r.name) + '：' + (r.delta > 0 ? '+' : '') + r.delta);
    });
    if (ss.bestTxt) lines.push('最优一手：' + ss.bestTxt);
    if (ss.worstTxt) lines.push('最差一手：' + ss.worstTxt);
    return lines.join('\n');
  };

  App.sessionCopy = function () {
    var txt = App.sessionText();
    function done(okFlag) { App.toast(okFlag ? '战绩已复制到剪贴板' : '复制失败，请用「下载」'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    }
  };

  App.sessionDownload = function () {
    var g = App.game, ss = App.session || {};
    var payload = {
      time: new Date().toISOString(), mode: App.mode || 'practice',
      hands: ss.hands, playerWins: ss.playerWins || 0,
      best: ss.bestTxt || '', worst: ss.worstTxt || '',
      standings: App.sessionRows()
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'poker-session-' + Date.now() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  };

  function cardEl(card, small, fancy) {
    var d = document.createElement('div');
    if (fancy) {
      var fc = Cards.suitClass(card);
      d.className = 'card fancy ' + fc;
      d.innerHTML =
        '<span class="corner tl"><span class="r">' + Cards.RANK_NAMES[card.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[card.s] + '</span></span>' +
        '<span class="big-suit">' + Cards.SUIT_SYMBOLS[card.s] + '</span>' +
        '<span class="corner br"><span class="r">' + Cards.RANK_NAMES[card.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[card.s] + '</span></span>';
      return d;
    }
    d.className = 'card' + (small ? ' small' : '') + ' ' + Cards.suitClass(card);
    d.innerHTML = '<span class="r">' + Cards.RANK_NAMES[card.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[card.s] + '</span>';
    return d;
  }

  function actionCN(a) {
    return a === 'fold' ? '弃牌' : a === 'call' ? '跟注' : a === 'raise' ? '加注' : a === 'check' ? '过牌' : a === 'allin' ? '全下' : a;
  }

  App.log = function (html, cls) {
    var box = el('log');
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  };

  // ================= 运气 / AIV（C1）=================
  /** 带符号数字（+83 / -200） */
  function fmtNum(v) {
    var x = Math.round(v * 10) / 10;
    return (x > 0 ? '+' : '') + x;
  }

  /** 全桌 AIV 聚合：按座位累计运气/EV + 按 |运气| 降序的全部「冤家」行 */
  App.aivSession = function (g) {
    var segs = g && g.aivEvents;
    if (!segs || !segs.length) return null;
    var luck = {}, evSum = {}, i, j;
    var rows = [];
    for (i = 0; i < segs.length; i++) {
      var evt = segs[i];
      var ps = evt.players || [];
      for (j = 0; j < ps.length; j++) {
        var p = ps[j];
        if (!p.risk) continue;   // 只统计风险承担者（弃牌者运气=0 无意义）
        luck[p.idx] = (luck[p.idx] || 0) + p.luck;
        evSum[p.idx] = (evSum[p.idx] || 0) + p.ev;
        rows.push({ handNo: evt.handNo, streetCN: evt.streetCN, desc: evt.desc, pot: evt.pot, idx: p.idx, name: p.name, ev: p.ev, actual: p.actual, luck: p.luck });
      }
    }
    var seatIdx, worst = null, best = null;
    for (seatIdx in luck) {
      if (!Object.prototype.hasOwnProperty.call(luck, seatIdx)) continue;
      var L = luck[seatIdx];
      if (!worst || L < worst.luck) worst = { idx: +seatIdx, name: '', luck: L, ev: evSum[seatIdx] };
      if (!best || L > best.luck) best = { idx: +seatIdx, name: '', luck: L, ev: evSum[seatIdx] };
    }
    rows.sort(function (a, b) { return Math.abs(b.luck) - Math.abs(a.luck); });
    return { count: segs.length, rows: rows, worst: worst, best: best };
  };

  /** 复盘面板顶部：全桌运气摘要 + 大冤家牌 top 段 */
  App.aivSessionHtml = function (g) {
    var s = App.aivSession(g);
    if (!s) return '';
    var g2 = g;
    // 补齐 最背/最旺 的名字（从座位表找）
    var seatName = function (idx) {
      var dn = App.displayName(idx);          // 匿名桌：优先用代号
      if (dn) return dn;
      if (g2 && g2.seats && g2.seats[idx]) return g2.seats[idx].name || ('座位' + (idx + 1));
      var row = null;
      for (var r = 0; r < s.rows.length; r++) if (s.rows[r].idx === idx) { row = s.rows[r]; break; }
      return row ? row.name : ('座位' + (idx + 1));
    };
    var txt = '全下 EV：本桌累计 <b>' + s.count + '</b> 个全下段。';
    if (s.worst) {
      txt += '最背：<b class="aiv-bad">' + esc(seatName(s.worst.idx)) + '</b>（累计运气 ' + fmtNum(s.worst.luck) + '，EV 合计 ' + fmtNum(s.worst.ev) + '）';
    }
    if (s.best && (!s.worst || s.best.idx !== s.worst.idx)) {
      txt += '　最旺：<b class="aiv-good">' + esc(seatName(s.best.idx)) + '</b>（累计运气 ' + fmtNum(s.best.luck) + '）';
    }
    var h = '<div class="rv-section"><div class="rv-h">运气 / AIV（全下 EV）</div>' +
      '<div class="aiv-session">' + txt + '</div>';
    if (s.rows.length) {
      var top = s.rows.slice(0, 3);
      top.forEach(function (r) {
        var nm = (typeof r.idx === 'number') ? seatName(r.idx) : (r.name || '');
        h += '<div class="aiv-row">' +
          '<span class="aiv-hand">第 ' + r.handNo + ' 手 · ' + esc(r.streetCN) +
          (r.desc ? ' · ' + esc(r.desc) : '') + '</span>' +
          '<span class="aiv-nm">' + esc(nm) + '</span>' +
          '<span class="rs">EV ' + fmtNum(r.ev) + ' ／ 实际 ' + fmtNum(r.actual) +
          ' ／ 运气 <b class="' + (r.luck >= 0 ? 'aiv-good' : 'aiv-bad') + '">' + fmtNum(r.luck) + '</b></span></div>';
      });
    }
    return h + '</div>';
  };

  /** 当前手若含全下段，显示本手逐段 EV/运气 */
  App.aivHandHtml = function (r) {
    if (!r || !r.aiv || !r.aiv.count) return '';
    var events = r.aiv.events || [];
    var rows = [];
    events.forEach(function (evt) {
      (evt.players || []).forEach(function (p) {
        if (!p.risk) return;
        rows.push({ pot: evt.pot, desc: evt.desc, streetCN: evt.streetCN, idx: p.idx, name: p.name, ev: p.ev, actual: p.actual, luck: p.luck, allIn: p.allIn });
      });
    });
    if (!rows.length) return '';
    var h = '<div class="rv-section"><div class="rv-h">本手全下 EV（AIV）</div>';
    rows.forEach(function (x) {
      var nm = (typeof x.idx === 'number') ? (App.displayName(x.idx) || x.name) : x.name;
      h += '<div class="aiv-row">' +
        '<span class="aiv-nm">' + esc(nm) + '</span>' +
        '<span class="rs">底池 ' + x.pot + (x.desc ? ' · ' + esc(x.desc) : '') + ' · ' + esc(x.streetCN) + '</span>' +
        '<span class="rs">EV ' + fmtNum(x.ev) + ' ／ 实际 ' + fmtNum(x.actual) +
        ' ／ 运气 <b class="' + (x.luck >= 0 ? 'aiv-good' : 'aiv-bad') + '">' + fmtNum(x.luck) + '</b></span></div>';
    });
    return h + '</div>';
  };

  // ================= 复盘面板 =================
  App.showReview = function (idx) {
    if (!App.reviews.length) return;
    if (idx < 0) idx = 0;
    if (idx >= App.reviews.length) idx = App.reviews.length - 1;
    App.rvIdx = idx;
    var r = App.reviews[idx];
    el('rvIndex').textContent = (idx + 1) + ' / ' + App.reviews.length;

    var html = '';

    // 概览
    html += '<div class="rv-overview">' +
      '<div class="rv-cards"><span class="rv-label">你的底牌</span>' + cardsHtml(r.playerHole) +
      '<span class="rv-handname">' + esc(r.playerHandName) + '</span></div>' +
      '<div class="rv-cards"><span class="rv-label">公共牌</span>' + cardsHtml(r.board) + '</div>' +
      '<div>底池 <b>' + r.pot + '</b>　盈亏 ' +
      '<span class="rv-delta ' + (r.delta > 0 ? 'up' : 'down') + '">' + (r.delta > 0 ? '+' : '') + r.delta + '</span></div>' +
      '<div class="rv-summary">' + esc(r.summary) + '</div>' +
      '</div>';

    // C1 运气 / AIV：先显示本手全下段 EV，再是全桌最背/最旺 + 大冤家牌
    html += App.aivHandHtml(r);
    html += App.aivSessionHtml(App.game);

    // 决策点评
    if (r.decisions.length) {
      html += '<div class="rv-section"><div class="rv-h">关键决策点评</div>';
      r.decisions.forEach(function (d) {
        html += '<div class="decision ' + d.verdict + '">' +
          '<div class="dec-h"><span class="street">' + esc(d.streetCN) + '</span>' +
          '<span class="nums">胜率 ' + pct(d.equity) + '% ／ 底池赔率 ' + pct(d.potOdds) + '% ／ 你' + esc(d.actionCN) +
          (d.amount ? ' ' + d.amount : '') + (d.evLoss > 0 ? ' ／ 损失≈' + d.evLoss : '') + '</span></div>' +
          '<div class="dec-comment">' + esc(d.comment) + '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    // 逐街回放
    html += '<div class="rv-section"><div class="rv-h">逐街回放</div>';
    r.streets.forEach(function (s) {
      html += '<div class="rv-street"><div class="rv-street-h">' + esc(s.streetCN) +
        (s.board.length ? '　' + esc(Cards.cardsText(s.board)) : '') + '　底池 ' + s.pot + '</div><div class="rv-acts">';
      s.actions.forEach(function (a) {
        html += '<div><span class="who">' + esc(App.displayName(a)) + '</span> ' + esc(a.action) + (a.amount ? ' ' + a.amount : '') +
          (a.reason ? ' <span class="reason">「' + esc(a.reason) + '」</span>' : '') + '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';

    // 对手解读（复盘亮牌：每个对手都显示本手实际底牌）
    if (r.opponents.length) {
      html += '<div class="rv-section"><div class="rv-h">对手解读（底牌全开 · 他们当时在想什么）</div>';
      r.opponents.forEach(function (o) {
        var holeHtml = (o.hole && o.hole.length) ? cardsHtml(o.hole) : '<span class="rv-label">未亮牌</span>';
        var hdTxt = o.handName ? esc(o.handName) : (o.folded ? '<span class="op-fold">弃牌</span>' : '');
        html += '<div class="opp-row">' +
          '<span class="nm">' + esc(App.displayName(o)) + '</span>' +
          '<span class="op-hole">' + holeHtml + '</span>' +
          (hdTxt ? '<span class="hd">' + hdTxt + '</span>' : '') +
          (o.wasBluff ? '<span class="bluff">诈唬</span>' : '') +
          '<span class="rs">' + esc(o.lastAction) + (o.reason ? '「' + esc(o.reason) + '」' : '') + '</span>' +
          '<span class="mood ' + (o.mood <= -25 ? 'hot' : '') + '">' + Personalities.moodEmoji(o.mood) + ' ' + esc(o.moodLabel) + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    // 知识点
    if (r.tips.length) {
      html += '<div class="rv-section"><div class="rv-h">本手知识点</div>';
      r.tips.forEach(function (t) {
        html += '<div class="tip-card"><h4>' + esc(t.title) + '</h4><p>' + esc(t.body) + '</p></div>';
      });
      html += '</div>';
    }

    el('reviewBody').innerHTML = html;
    el('modalReview').classList.remove('hidden');
  };

  function cardsHtml(cards) {
    if (!cards || !cards.length) return '<span class="rv-label">—</span>';
    return cards.map(function (c) {
      var cls = Cards.suitClass(c);
      return '<span class="card small ' + cls + '"><span class="r">' + Cards.RANK_NAMES[c.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[c.s] + '</span></span>';
    }).join('');
  }

  // ================= 课堂 =================
  App.openClass = function () {
    var html = '';
    Coach.TIPS.forEach(function (t) {
      html += '<div class="tip-card"><h4>' + esc(t.title) + '</h4><p>' + esc(t.body) + '</p></div>';
    });
    el('tipsList').innerHTML = html;
    el('modalClass').classList.remove('hidden');
  };

  // ================= 统计 =================
  App.loadStats = function () {
    try {
      var raw = localStorage.getItem('poker_stats_v1');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { hands: 0, wins: 0, profit: 0, best: 0, ok: 0, mistake: 0, blunder: 0, byStreet: {}, topMistakes: {} };
  };

  App.saveStats = function () {
    try { localStorage.setItem('poker_stats_v1', JSON.stringify(App.stats)); } catch (e) { /* ignore */ }
  };

  // ================= 对手建模跨会话持久化 =================
  // 按人格 id 累积对手客观统计（入池/加注/3bet/偷盲…），换桌或刷新浏览器后保留，
  // 与「点击标注」组成完整对手档案；HUD 直接读 seat.stats，因此天然复用。
  App.oppStats = {};
  App.loadOppStats = function () {
    try {
      var raw = localStorage.getItem('poker_opp_stats_v1');
      if (raw) return JSON.parse(raw) || {};
    } catch (e) { /* ignore */ }
    return {};
  };
  App.saveOppStats = function () {
    var g = App.game;
    if (!g || !g.seats) return;
    var map = App.oppStats || {};
    for (var i = 0; i < g.seats.length; i++) {
      var s = g.seats[i];
      if (!s || s.isHuman || !s.id || !s.stats) continue;
      var copy = {};
      for (var k in s.stats) if (s.stats.hasOwnProperty(k)) copy[k] = s.stats[k];
      map[s.id] = copy;
    }
    try { localStorage.setItem('poker_opp_stats_v1', JSON.stringify(map)); } catch (e) { /* ignore */ }
    App.oppStats = map;
  };
  /** 开局：把已存的历史统计灌进本桌座位的 seat.stats（覆盖新建的 0 值对象，不累加第二次） */
  App.seedOppStats = function () {
    var g = App.game;
    if (!g || !g.seats) return;
    var map = App.oppStats || {};
    for (var i = 0; i < g.seats.length; i++) {
      var s = g.seats[i];
      if (!s || s.isHuman || !s.id || !s.stats) continue;
      var base = map[s.id];
      if (!base) continue;
      for (var k in base) if (base.hasOwnProperty(k) && s.stats) s.stats[k] = (s.stats[k] || 0) + (base[k] || 0);
    }
  };

  // ================= 偏好记忆（匿名桌/教学提示/音效）=================
  App.prefs = {};
  App.loadPrefs = function () {
    try {
      var raw = localStorage.getItem('poker_prefs_v1');
      if (raw) return JSON.parse(raw) || {};
    } catch (e) { /* ignore */ }
    return {};
  };
  App.savePrefs = function () {
    try { localStorage.setItem('poker_prefs_v1', JSON.stringify(App.prefs)); } catch (e) { /* ignore */ }
  };
  App.pref = function (key, def) {
    var v = App.prefs[key];
    return v === undefined ? def : v;
  };
  /** 偏好 → 界面控件 */
  App.applyPrefsUi = function () {
    var set = function (id, v) { var x = document.getElementById(id); if (x) x.checked = !!v; };
    set('chkAnon', App.pref('anon', false));
    set('chkCoach', App.pref('coach', true));
    set('chkSound', App.pref('sound', true));
  };
  /** 控件变更 → 存偏好 */
  App.bindPref = function (id, key) {
    var x = document.getElementById(id);
    if (!x) return;
    x.onchange = function () { App.prefs[key] = !!x.checked; App.savePrefs(); };
  };

  // ================= 音效（WebAudio 合成，零依赖，可关）=================
  App._actx = null;
  App._ac = function () {
    if (!App.pref('sound', true)) return null;
    try {
      if (!App._actx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        App._actx = new AC();
      }
      if (App._actx.state === 'suspended' && App._actx.resume) App._actx.resume();
      return App._actx;
    } catch (e) { return null; }
  };
  App._tone = function (freq, t0, dur, type, vol) {
    var ac = App._ac();
    if (!ac) return;
    try {
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      var now = ac.currentTime + t0;
      o.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol || 0.10, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (dur || 0.15));
      o.connect(g); g.connect(ac.destination);
      o.start(now); o.stop(now + (dur || 0.15) + 0.05);
    } catch (e) { /* ignore */ }
  };
  /** 语义音效 */
  App.sfx = function (kind) {
    if (!App.pref('sound', true)) return;
    switch (kind) {
      case 'fold': App._tone(170, 0, 0.10, 'square', 0.05); break;
      case 'check': App._tone(340, 0, 0.09, 'triangle', 0.07); break;
      case 'call': App._tone(470, 0, 0.10, 'triangle', 0.09); break;
      case 'raise': App._tone(560, 0, 0.09, 'triangle', 0.10); App._tone(720, 0.08, 0.12, 'triangle', 0.10); break;
      case 'allin': App._tone(300, 0, 0.16, 'sawtooth', 0.08); App._tone(540, 0.09, 0.18, 'sawtooth', 0.09); App._tone(880, 0.19, 0.30, 'sawtooth', 0.10); break;
      case 'win': App._tone(523, 0, 0.12, 'triangle', 0.11); App._tone(659, 0.10, 0.12, 'triangle', 0.11); App._tone(784, 0.20, 0.24, 'triangle', 0.11); break;
      case 'deal': App._tone(740, 0, 0.05, 'sine', 0.05); App._tone(980, 0.05, 0.06, 'sine', 0.05); break;
    }
  };

  // ================= 键盘快捷键：F 弃 / C 跟注或过牌 / R 加注 / A 全下 =================
  App.bindKeys = function () {
    if (App._keysBound) return;
    App._keysBound = true;
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var g = App.game;
      if (!g || g.isHandOver || g.currentActor !== g.playerIndex || App.busy) return;
      var legal = g.legalActions(g.playerIndex);
      var canBet = legal.maxTo > legal.minRaiseTo;
      var k = (e.key || '').toLowerCase();
      var acted = false;
      if (k === 'f') { App.playerAct('fold'); acted = true; }
      else if (k === 'c') {
        if (legal.canCheck) { App.playerAct('check'); acted = true; }
        else if (legal.canCall) { App.playerAct('call'); acted = true; }
      } else if (k === 'r') {
        if (canBet) { App.syncRaise(true); App.playerAct('raise', App.raiseAmount()); acted = true; }
      } else if (k === 'a') {
        if (canBet) { App.playerAct('allin'); acted = true; }
      }
      if (acted) e.preventDefault();
    });
  };

  App.openStats = function () {
    var s = App.stats;
    if (!s || !s.hands) {
      el('statsBody').innerHTML = '<div class="empty-tip">还没有数据，先打几手牌吧。</div>';
      el('modalStats').classList.remove('hidden');
      return;
    }
    var total = (s.best || 0) + (s.ok || 0) + (s.mistake || 0) + (s.blunder || 0);
    var acc = total ? Math.round(((s.best || 0) + (s.ok || 0)) / total * 100) : 0;
    var html = '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="v">' + s.hands + '</div><div class="k">手牌数</div></div>' +
      '<div class="stat-cell"><div class="v">' + acc + '%</div><div class="k">决策准确率</div></div>' +
      '<div class="stat-cell"><div class="v" style="color:' + (s.profit >= 0 ? '#45b7a8' : '#e05263') + '">' + (s.profit > 0 ? '+' : '') + s.profit + '</div><div class="k">累计盈亏</div></div>' +
      '<div class="stat-cell"><div class="v">' + (s.best || 0) + '</div><div class="k">最优决策</div></div>' +
      '<div class="stat-cell"><div class="v" style="color:#e0a33e">' + (s.ok || 0) + '</div><div class="k">可接受</div></div>' +
      '<div class="stat-cell"><div class="v" style="color:#e05263">' + ((s.mistake || 0) + (s.blunder || 0)) + '</div><div class="k">失误</div></div>' +
      '</div>';

    var bs = s.byStreet || {};
    var keys = Object.keys(bs);
    if (keys.length) {
      var max = 0;
      keys.forEach(function (k) { if (bs[k] > max) max = bs[k]; });
      html += '<div class="rv-h">失误分布（按街）</div>';
      keys.forEach(function (k) {
        html += '<div class="bar-row"><span class="lbl">' + esc(k) + '</span><span class="bar"><span style="width:' +
          Math.round(bs[k] / max * 100) + '%"></span></span><span>' + bs[k] + '</span></div>';
      });
    }

    var tm = s.topMistakes || {};
    var tk = Object.keys(tm).sort(function (a, b) { return tm[b] - tm[a]; }).slice(0, 3);
    if (tk.length) {
      html += '<div class="rv-h" style="margin-top:14px">最常犯的错（应有 → 实际）</div>';
      tk.forEach(function (k) {
        html += '<div class="bar-row"><span class="lbl" style="width:auto">' + esc(k) + '</span><span>' + tm[k] + ' 次</span></div>';
      });
    }
    el('statsBody').innerHTML = html;
    el('modalStats').classList.remove('hidden');
  };

  Poker.App = App;
})(typeof window !== 'undefined' ? window : this);
