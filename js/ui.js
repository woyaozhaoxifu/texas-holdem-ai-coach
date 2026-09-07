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
    oddsCollapsed: false  // 用户手动折叠
  };

  // 比赛盲注升级表（第 N 轮取第 N 档；第 6 档起带 Ante = BB×10% 向上取整到 5）
  var MATCH_BLINDS = [
    { sb: 10, bb: 20, ante: 0 }, { sb: 15, bb: 30, ante: 0 }, { sb: 25, bb: 50, ante: 0 },
    { sb: 40, bb: 80, ante: 0 }, { sb: 60, bb: 120, ante: 0 }, { sb: 100, bb: 200, ante: 20 },
    { sb: 150, bb: 300, ante: 30 }, { sb: 250, bb: 500, ante: 50 },
    { sb: 400, bb: 800, ante: 80 }, { sb: 600, bb: 1200, ante: 120 }
  ];

  // ================= 初始化 =================
  App.init = function () {
    App.stats = App.loadStats();

    el('btnSetup').onclick = function () { App.openSetup(); };
    el('btnReview').onclick = function () { if (App.reviews.length) App.showReview(App.reviews.length - 1); else App.toast('还没有可复盘的手牌'); };
    el('btnClass').onclick = function () { App.openClass(); };
    el('btnStats').onclick = function () { App.openStats(); };

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
    el('btnRaise').onclick = function () { App.playerAct('raise', parseInt(el('raiseVal').dataset.value || '0', 10)); };
    el('btnAllIn').onclick = function () { App.playerAct('allin'); };
    el('btnNext').onclick = function () { App.nextHand(); };
    el('btnHalfPot').onclick = function () { App.presetRaise(0.5); };
    el('btnTwoThirdPot').onclick = function () { App.presetRaise(0.67); };
    el('btnFullPot').onclick = function () { App.presetRaise(1.0); };
    el('raiseRange').oninput = function () { App.syncRaise(); };

    el('rvPrev').onclick = function () { if (App.rvIdx > 0) App.showReview(App.rvIdx - 1); };
    el('rvNext').onclick = function () { if (App.rvIdx < App.reviews.length - 1) App.showReview(App.rvIdx + 1); };
    el('btnClearStats').onclick = function () {
      App.stats = { hands: 0, wins: 0, profit: 0, best: 0, ok: 0, mistake: 0, blunder: 0, byStreet: {}, topMistakes: {} };
      App.saveStats(); App.openStats();
    };
    el('btnStartTable').onclick = function () { App.startTable(App.selected); };
    el('btnStartMatch').onclick = function () { App.startTable(App.selected, 'match'); };
    el('btnNextRound').onclick = function () { App.nextRound(); };
    el('btnMatchQuit').onclick = function () { App.showFinal(); };
    el('btnBackLobby').onclick = function () { App.backLobby(); };

    el('oddsCollapse').onclick = function () {
      App.oddsCollapsed = !App.oddsCollapsed;
      el('oddsCollapse').textContent = App.oddsCollapsed ? '▸' : '▾';
      App.updateOddsPanel();
    };
    el('chkOddsPin').onchange = function () { App.updateOddsPanel(); };

    App.openSetup();
  };

  App.toast = function (msg) {
    App.log('<span class="hl">' + esc(msg) + '</span>');
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
    var initialChips = 2000;
    var seats = [{ id: 'you', name: '你', isHuman: true, chips: initialChips }];
    ids.forEach(function (id) {
      var p = Personalities.get(id);
      seats.push({ id: id, name: p.name, avatar: p.avatar, personality: id, chips: initialChips });
    });
    var cfg = { seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: initialChips };
    if (matchMode) {
      cfg.autoRebuy = false;   // 比赛：不补筹，出局即淘汰
      cfg.match = { enabled: true, roundHands: 15, blindLevels: MATCH_BLINDS, payouts: [50, 30, 20] };
    }
    App.game = new Poker.Game(cfg);
    App.reviews = [];
    App.revealAll = false;
    App.busy = false;
    el('log').innerHTML = '';
    App.syncHeader();
    var foes = ids.map(function (i) { return Personalities.get(i).name; }).join('、');
    App.log('牌局开始：你 vs ' + foes + (matchMode ? '（比赛模式 · 每轮 15 手 · 盲注升级 · 无补筹）' : '（练习模式 · 无限手）'));
    App.nextHand();
  };

  App.nextHand = function () {
    if (!App.game) return;
    var g = App.game;
    if (g.match && g.match.enabled) {
      if (g.match.over) { App.showFinal(); return; }
      if (g.match.pendingRoundEnd) { App.showRoundResult(); return; }
    }
    App.revealAll = false;
    el('btnNext').classList.add('hidden');
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
    App.showBubble(idx, d.reason || '……');
    var before = g.street;
    g.act(idx, d.action, d.raiseTo, d.reason);
    App.log(esc(seat.name) + ' <span class="act-' + (d.action === 'raise' || d.action === 'allin' ? 'raise' : d.action === 'fold' ? 'fold' : '') + '">' +
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
    g.act(g.playerIndex, action, amt, '');
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
    var range = el('raiseRange');
    if (max > min) {
      range.min = min; range.max = max; range.step = 10;
      // 默认滑块位置：底池 + 跟注的 ⅔ 处（接近标准 2.2-3BB 开局加注）
      var defaultTarget = g.currentBet + Math.round((legal.pot + legal.toCall) * 0.67);
      range.value = Math.max(min, Math.min(max, defaultTarget));
      range.disabled = false;
      el('btnRaise').disabled = false;
      el('btnHalfPot').disabled = false;
      el('btnTwoThirdPot').disabled = false;
      el('btnFullPot').disabled = false;
    } else {
      range.disabled = true;
      el('btnRaise').disabled = true;
      el('btnHalfPot').disabled = true;
      el('btnTwoThirdPot').disabled = true;
      el('btnFullPot').disabled = true;
      range.value = min;
    }
    App.syncRaise();
    App.showCoachTip();
    App.render();
  };

  App.syncRaise = function () {
    var v = parseInt(el('raiseRange').value, 10);
    el('raiseVal').textContent = v;
    el('raiseVal').dataset.value = v;
  };

  /** 按底池倍数快速设置加注额（½ 池 / ⅔ 池 / 底池） */
  App.presetRaise = function (frac) {
    if (!App.game) return;
    var g = App.game;
    var legal = g.legalActions(g.playerIndex);
    var stdTarget = g.currentBet + Math.round((legal.pot + legal.toCall) * frac);
    var target = Math.max(legal.minRaiseTo, Math.min(legal.maxTo, stdTarget));
    el('raiseRange').value = target;
    App.syncRaise();
  };

  App.disableControls = function (disabled) {
    ['btnFold', 'btnCheck', 'btnCall', 'btnRaise', 'btnAllIn', 'btnHalfPot', 'btnTwoThirdPot', 'btnFullPot', 'raiseRange'].forEach(function (id) {
      el(id).disabled = disabled;
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
    if (key === App.oddsKey && App.oddsCache) return;

    var data = null;
    try { data = Poker.Equity.oddsPanel(seat.hole, g.board, nOpp, 600); } catch (e) { data = null; }
    if (!data) {
      body.innerHTML = '<div class="odds-note">暂时无法计算胜率。</div>';
      return;
    }
    App.oddsKey = key;
    App.oddsCache = data;
    body.innerHTML = App.oddsHtml(data);
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
      for (var i = 0; i < top.length; i++) {
        var b = top[i];
        chips += '<span class="odds-chip">' + esc(b.name) + ' ' + b.count + '（' + (b.pct * 100).toFixed(1) + '%）</span>';
      }
      html += '<div class="odds-beats">' + chips + '</div>';
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

    if (result) {
      var winners = result.winners || [];
      if (winners.length) {
        var txt = winners.map(function (w) {
          return esc(w.name) + ' 赢 ' + w.amount + (w.handName ? '（' + esc(w.handName) + '）' : '');
        }).join('、');
        App.log('★ ' + txt, 'act-win');
      }
      var review = Review.build(result, g);
      App.reviews.push(review);
      if (App.reviews.length > 30) App.reviews.shift();
      App.rvIdx = App.reviews.length - 1;
      App.stats = Review.updateStats(App.stats, review);
      App.saveStats();

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
    var standings = g.match.lastStandings || g.finalStandings();
    el('rRoundNo').textContent = g.match.roundNo;
    var elimNames = (g.match.roundBustOrder || []).map(function (i) {
      return g.seats[i] ? g.seats[i].name : '';
    }).filter(function (n) { return n; }).join('、');
    var subTxt = '盲注 ' + g.smallBlind + ' / ' + g.bigBlind;
    if (g.ante > 0) subTxt += ' · Ante ' + g.ante;
    subTxt += ' · 本轮共 ' + (g.match.handsInRound) + ' 手' + (elimNames ? ' · 出局：' + elimNames : '');
    el('roundSub').textContent = subTxt;
    var html = standHeaderHtml(false) + standings.map(function (row) { return standRowHtml(row, false); }).join('');
    el('roundBody').innerHTML = html;
    var top = standings[0];
    el('roundLeader').innerHTML = top && !top.eliminated
      ? '本轮领先：<b>' + esc(top.name) + '</b>　筹码 ¥' + top.chips
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

  /** 最终排名弹窗 */
  App.showFinal = function () {
    var g = App.game;
    if (!g) return;
    var standings = g.finalStandings();
    var champ = standings[0] || null;
    var html = '';
    if (champ) {
      html += '<div class="final-hero">' +
        '<div class="fa-avatar">' + (champ.avatar || (champ.isHuman ? '🙂' : '🤖')) + '</div>' +
        '<div class="fa-title">' + (champ.isHuman ? '你' : esc(champ.name)) + ' 夺冠</div>' +
        '<div class="fa-sub">累计积分 ' + champ.totalPts + ' · 剩余筹码 ¥' + champ.chips + '</div>' +
        '</div>';
    }
    html += standHeaderHtml(true) + standings.map(function (row) { return standRowHtml(row, true); }).join('');
    el('finalBody').innerHTML = html;
    el('modalRound').classList.add('hidden');   // 从轮次弹窗进入最终排名时关闭轮次弹窗
    el('modalFinal').classList.remove('hidden');
  };

  /** 返回选桌（清理比赛状态） */
  App.backLobby = function () {
    if (App.aiTimer) clearTimeout(App.aiTimer);
    if (App.bubbleTimer) clearTimeout(App.bubbleTimer);
    el('modalFinal').classList.add('hidden');
    el('modalRound').classList.add('hidden');
    App.game = null;
    App.reviews = [];
    App.mode = 'practice';
    App.busy = false;
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
    var nameHtml = esc(row.name) + (row.isHuman ? '<span class="y-badge">你</span>' : '');
    var avatar = row.avatar || (row.isHuman ? '🙂' : '🤖');
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
    el('streetLabel').textContent = g.streetCN(g.street);
    el('myChips').textContent = g.seats[g.playerIndex].chips;
    App.updateOddsPanel();
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

  App.seatEl = function (s) {
    var g = App.game;
    var div = document.createElement('div');
    div.className = 'seat';
    div.setAttribute('data-idx', s.index);
    if (s.index === g.currentActor && !g.isHandOver) div.className += ' active';
    if (s.folded) div.className += ' folded';
    if (s.isHuman) div.className += ' is-me';

    var p = s.personality;
    var moodCls = '';
    if (s.mood <= -25) moodCls = 'hot';
    else if (s.mood >= 25) moodCls = 'good';
    var moodTxt = p ? (Personalities.moodEmoji(s.mood) + ' ' + (s.moodLabel || '平静')) : '';

    var html = '<div class="seat-top">' +
      '<span class="avatar">' + (s.avatar || (s.isHuman ? '🙂' : '🤖')) + '</span>' +
      '<div style="min-width:0">' +
      '<div class="seat-name">' + esc(s.name) + '</div>' +
      (p ? '<div class="seat-style">' + Personalities.stars(p.difficulty) + ' ' + esc(p.style) + '</div>'
        : '<div class="seat-style">你</div>') +
      '</div></div>' +
      '<div class="seat-line"><span class="chips">¥' + s.chips + '</span>' +
      (moodTxt ? '<span class="mood ' + moodCls + '">' + moodTxt + '</span>' : '') + '</div>' +
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
      var bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.textContent = s.bet;
      div.appendChild(bet);
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
    return div;
  };

  function cardEl(card, small, fancy) {
    var d = document.createElement('div');
    if (fancy) {
      var fc = Cards.isRed(card) ? 'red' : 'black';
      d.className = 'card fancy ' + fc;
      d.innerHTML =
        '<span class="corner tl"><span class="r">' + Cards.RANK_NAMES[card.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[card.s] + '</span></span>' +
        '<span class="big-suit">' + Cards.SUIT_SYMBOLS[card.s] + '</span>' +
        '<span class="corner br"><span class="r">' + Cards.RANK_NAMES[card.r] + '</span><span class="s">' + Cards.SUIT_SYMBOLS[card.s] + '</span></span>';
      return d;
    }
    d.className = 'card' + (small ? ' small' : '') + ' ' + (Cards.isRed(card) ? 'red' : 'black');
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
        html += '<div><span class="who">' + esc(a.name) + '</span> ' + esc(a.action) + (a.amount ? ' ' + a.amount : '') +
          (a.reason ? ' <span class="reason">「' + esc(a.reason) + '」</span>' : '') + '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';

    // 对手解读
    if (r.opponents.length) {
      html += '<div class="rv-section"><div class="rv-h">对手解读（他们在想什么）</div>';
      r.opponents.forEach(function (o) {
        var hole = o.revealed ? esc(Cards.cardsText(o.hole)) : '未亮牌';
        html += '<div class="opp-row">' +
          '<span class="nm">' + esc(o.name) + '</span>' +
          '<span class="hd">' + esc(o.handName || hole) + '</span>' +
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
      var cls = Cards.isRed(c) ? 'red' : 'black';
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
