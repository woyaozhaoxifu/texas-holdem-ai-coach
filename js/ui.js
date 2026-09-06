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
    reviews: [],
    rvIdx: 0,
    busy: false,
    revealAll: false,
    selected: ['fish', 'rock', 'tag', 'lag', 'solver'],
    stats: null,
    aiTimer: null,
    bubbleTimer: null
  };

  // ================= 初始化 =================
  App.init = function () {
    App.stats = App.loadStats();

    el('btnSetup').onclick = function () { App.openSetup(); };
    el('btnReview').onclick = function () { if (App.reviews.length) App.showReview(App.reviews.length - 1); else App.toast('还没有可复盘的手牌'); };
    el('btnClass').onclick = function () { App.openClass(); };
    el('btnStats').onclick = function () { App.openStats(); };

    var closers = document.querySelectorAll('[data-close]');
    for (var i = 0; i < closers.length; i++) {
      closers[i].onclick = function () { el(this.getAttribute('data-close')).classList.add('hidden'); };
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
    el('btnStartTable').disabled = App.selected.length !== 5;
    el('modalSetup').classList.remove('hidden');
  };

  App.startTable = function (ids) {
    el('modalSetup').classList.add('hidden');
    var seats = [{ id: 'you', name: '你', isHuman: true, chips: 2000 }];
    ids.forEach(function (id) {
      var p = Personalities.get(id);
      seats.push({ id: id, name: p.name, avatar: p.avatar, personality: id, chips: 2000 });
    });
    App.game = new Poker.Game({
      seats: seats, smallBlind: 10, bigBlind: 20, playerIndex: 0, initialChips: 2000
    });
    App.reviews = [];
    App.revealAll = false;
    el('log').innerHTML = '';
    el('blinds').textContent = '10 / 20';
    App.log('牌局开始：你 vs ' + ids.map(function (i) { return Personalities.get(i).name; }).join('、'));
    App.nextHand();
  };

  App.nextHand = function () {
    if (!App.game) return;
    App.revealAll = false;
    el('btnNext').classList.add('hidden');
    App.game.startHand();
    el('handNo').textContent = App.game.handNo;
    App.log('—— 第 ' + App.game.handNo + ' 手 ——', 'hl');
    App.render();
    App.loop();
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
      var delay = 650 + Math.random() * 800;
      App.aiTimer = setTimeout(function () { App.doAI(); }, delay);
    }
  };

  App.doAI = function () {
    var g = App.game;
    if (!g || g.isHandOver || g.currentActor < 0) { App.loop(); return; }
    var idx = g.currentActor;
    var seat = g.seats[idx];
    var d = g.aiDecide(idx);
    App.showBubble(idx, d.reason || '……');
    var before = g.street;
    g.act(idx, d.action, d.raiseTo, d.reason);
    App.log(esc(seat.name) + ' <span class="act-' + (d.action === 'raise' || d.action === 'allin' ? 'raise' : d.action === 'fold' ? 'fold' : '') + '">' +
      actionCN(d.action) + (d.action === 'raise' || d.action === 'allin' ? ' ' + (d.raiseTo || d.amount) : (d.action === 'call' ? ' ' + d.amount : '')) + '</span>' +
      (d.reason ? ' <span class="reason">「' + esc(d.reason) + '」</span>' : ''));
    if (g.street !== before) App.log('★ ' + g.streetCN(g.street) + '：' + Cards.cardsText(g.board), 'hl');
    App.render();
    App.busy = false;
    setTimeout(function () { App.loop(); }, 260);
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
    }
  };

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
