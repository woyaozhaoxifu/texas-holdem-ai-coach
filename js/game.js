/* global window, global */
/**
 * game.js —— 德州扑克牌局状态机（No-Limit Hold'em）。
 *
 * 职责：发牌 / 盲注 / 四街下注轮 / 边池(side pot) / 摊牌比较 / 筹码结算。
 * 同时记录 handLog（每个决策点快照），供 coach.js 与 review.js 做教学复盘。
 *
 * 不依赖 DOM，可在 Node 下直接跑自动对战。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  function treq(p) {
    try { return typeof require !== 'undefined' ? require(p) : null; } catch (e) { return null; }
  }
  var Cards = Poker.Cards || treq('./cards.js');
  var HandEval = Poker.HandEval || treq('./handEval.js');
  var Equity = Poker.Equity || treq('./equity.js');
  var Personalities = Poker.Personalities || treq('./ai/personalities.js');

  var STREETS = ['preflop', 'flop', 'turn', 'river'];
  var STREET_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };

  function Game(config) {
    this.config = config || {};
    this.smallBlind = this.config.smallBlind || 10;
    this.bigBlind = this.config.bigBlind || 20;
    this.initialChips = this.config.initialChips || 1000;
    this.rng = this.config.rng || Math.random;

    this.seats = [];
    var defs = this.config.seats || [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var isHuman = !!d.isHuman;
      this.seats.push({
        index: i,
        id: d.id || ('seat' + i),
        name: d.name || ('座位' + (i + 1)),
        avatar: d.avatar || '',
        isHuman: isHuman,
        personality: isHuman ? null : (typeof d.personality === 'string' ? Personalities.get(d.personality) : (d.personality || Personalities.get('tag'))),
        chips: d.chips != null ? d.chips : 1000,
        hole: [],
        bet: 0,
        committed: 0,
        folded: false,
        allIn: false,
        sittingOut: false,
        consecutiveLosses: 0,
        mood: 0,
        moodLabel: '平静',
        moodEvent: '',
        relations: {},   // { 对手id: 关系值 } 负=记恨，正=觉得好欺负
        eliminated: false, // 比赛模式下：筹码归零被淘汰
        lastAction: '',
        lastReason: '',
        stats: { hands: 0, vpip: 0, pfr: 0, folds: 0, calls: 0, raises: 0, showdowns: 0, wins: 0, facedBet: 0, foldsToBet: 0 }
      });
    }

    this.playerIndex = this.config.playerIndex != null ? this.config.playerIndex : 0;
    this.button = -1;
    this.handNo = 0;
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;
    this.aggressorIndex = -1;
    this.queue = [];
    this.currentActor = -1;
    this.deck = [];
    this.handLog = [];
    this.streetSnaps = [];
    this.lastResult = null;
    this.history = [];
    this.events = [];
    // 人类玩家模型（供 Boss 读牌 + HUD）
    this.playerModel = { hands: 0, vpip: 0, foldToBet: 0, aggression: 0 };

    // ---- 比赛模式（轮次制）：match.enabled === true ----
    // roundHands: 每轮手数；blindLevels: 盲注按轮升级；不补筹，出局即淘汰
    this.match = null;
    if (this.config.match && this.config.match.enabled) {
      var mOpt = this.config.match;
      var levels = (mOpt.blindLevels && mOpt.blindLevels.length) ? mOpt.blindLevels
        : [{ sb: 10, bb: 20 }, { sb: 15, bb: 30 }, { sb: 25, bb: 50 }, { sb: 40, bb: 80 },
           { sb: 60, bb: 120 }, { sb: 100, bb: 200 }, { sb: 150, bb: 300 }, { sb: 250, bb: 500 },
           { sb: 400, bb: 800 }, { sb: 600, bb: 1200 }];
      var lv0 = levels[0] || { sb: 10, bb: 20 };
      this.smallBlind = lv0.sb;
      this.bigBlind = lv0.bb;
      this.config.autoRebuy = false;   // 比赛永不补筹
      var m = {
        enabled: true,
        roundHands: mOpt.roundHands || 15,
        blindLevels: levels,
        roundNo: 1,
        handsInRound: 0,
        pendingRoundEnd: false,   // true 表示轮末已结算、等待确认进入下一轮
        over: false,              // true 表示比赛结束（只剩 1 人）
        points: [],               // 累计积分（按座位）
        roundPts: [],             // 本轮积分（按座位）
        roundStartChips: [],      // 本轮开始时筹码快照（用于 delta）
        roundBustOrder: [],       // 本轮内出局顺序
        bustOrder: [],            // 全比赛出局顺序
        bustRound: [],            // 每个座位出局时的轮次（0=未出局）
        eliminated: [],           // 每个座位是否已淘汰
        lastStandings: null
      };
      for (var mi = 0; mi < this.seats.length; mi++) {
        m.roundStartChips[mi] = this.seats[mi].chips;
        m.points[mi] = 0;
        m.roundPts[mi] = 0;
        m.bustRound[mi] = 0;
        m.eliminated[mi] = false;
      }
      this.match = m;
    }
  }

  Game.prototype.emit = function (type, data) {
    var ev = data || {};
    ev.type = type;
    this.events.push(ev);
    return ev;
  };

  Game.prototype.drainEvents = function () {
    var e = this.events;
    this.events = [];
    return e;
  };

  Game.prototype.activeSeats = function () {
    var out = [];
    for (var i = 0; i < this.seats.length; i++) if (!this.seats[i].folded && !this.seats[i].sittingOut) out.push(this.seats[i]);
    return out;
  };

  /** 还能主动行动的玩家（未弃牌且未 all-in） */
  Game.prototype.actableSeats = function () {
    var out = [];
    for (var i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      if (!s.folded && !s.allIn && !s.sittingOut && s.chips > 0) out.push(s);
    }
    return out;
  };

  Game.prototype.potTotal = function () {
    var t = 0;
    for (var i = 0; i < this.seats.length; i++) t += this.seats[i].committed;
    return t;
  };

  Game.prototype.numOpponents = function (seat) {
    var n = 0;
    for (var i = 0; i < this.seats.length; i++) {
      if (i !== seat.index && !this.seats[i].folded && !this.seats[i].sittingOut) n++;
    }
    return Math.max(1, n);
  };

  /** 位置系数 0..1，按钮位最大 */
  Game.prototype.positionFactor = function (seat) {
    var n = this.seats.length;
    if (n <= 1) return 1;
    var d = (seat.index - this.button + n) % n; // 距按钮的距离
    return 1 - (d - 1) / (n - 1);
  };

  Game.prototype.streetCN = function (s) { return STREET_CN[s || this.street] || s; };

  // ============ 开始一手牌 ============
  Game.prototype.startHand = function () {
    // 比赛模式：轮末等待确认 / 已结束 / 只剩 1 人 → 拒绝开局（返回 false）
    if (this.match && this.match.enabled) {
      if (this.match.over) return false;
      if (this.match.pendingRoundEnd) return false;
      if (this.aliveCount() <= 1) { this.finishRound(true); return false; }
    }
    this.handNo++;
    this.isHandOver = false;
    this.board = [];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;
    this.aggressorIndex = -1;
    this.handLog = [];
    this.streetSnaps = [];
    this.lastResult = null;

    // 清理筹码归零的座位
    for (var i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      s.hole = [];
      s.bet = 0;
      s.committed = 0;
      s.allIn = false;
      s.lastAction = '';
      s.lastReason = '';
      // 关系随时间淡忘
      for (var rid in s.relations) {
        if (!Object.prototype.hasOwnProperty.call(s.relations, rid)) continue;
        var rv = Math.round(s.relations[rid] * 0.97);
        if (Math.abs(rv) < 5) delete s.relations[rid];
        else s.relations[rid] = rv;
      }
      // 情绪随时间回归平静
      if (s.mood) {
        s.mood = Math.round(s.mood * 0.82);
        // 极端情绪会随时间平复，避免永久上头
        if (s.mood < -40) s.mood += 7;
        else if (s.mood > 40) s.mood -= 5;
        if (Math.abs(s.mood) < 3) s.mood = 0;
        s.moodLabel = Personalities.moodLabel(s.mood);
      }
      var rebuy = this.config.autoRebuy !== false;
      if (s.chips <= 0) {
        // AI 破产自动补充筹码，保持牌桌满员（人类玩家破产 = 游戏结束）
        if (!s.isHuman && rebuy) {
          s.chips = this.initialChips;
          s.folded = false; s.sittingOut = false; s.stats.hands++;
        } else { s.folded = true; s.sittingOut = true; }
      } else if (!s.isHuman && rebuy && s.chips < this.bigBlind) {
        s.chips = this.initialChips;
        s.folded = false; s.sittingOut = false; s.stats.hands++;
      } else { s.folded = false; s.sittingOut = false; s.stats.hands++; }
    }

    this.button = (this.button + 1) % this.seats.length;
    // 若按钮位玩家已出局，顺延
    var guard = 0;
    while (this.seats[this.button].sittingOut && guard++ < this.seats.length) {
      this.button = (this.button + 1) % this.seats.length;
    }

    var n = this.seats.length;
    var sbIdx, bbIdx;
    if (this.match && this.match.enabled) {
      // 比赛模式：盲注只落在存活者上（跳过已淘汰座位）；剩 2 人按 heads-up 处理
      var aliveM = [];
      for (var ai = 0; ai < n; ai++) if (!this.seats[ai].sittingOut) aliveM.push(ai);
      var nxtAlive = function (from) {
        for (var k2 = 1; k2 <= n; k2++) {
          var ii = (from + k2) % n;
          if (aliveM.indexOf(ii) >= 0) return ii;
        }
        return from;
      };
      if (aliveM.length === 2) { sbIdx = this.button; bbIdx = nxtAlive(this.button); }
      else { sbIdx = nxtAlive(this.button); bbIdx = nxtAlive(sbIdx); }
    } else {
      sbIdx = n > 2 ? (this.button + 1) % n : this.button;
      bbIdx = n > 2 ? (this.button + 2) % n : (this.button + 1) % n;
    }

    this.deck = Cards.shuffle(Cards.buildDeck(), this.rng);
    var live = [];
    for (var k = 0; k < n; k++) if (!this.seats[k].sittingOut) live.push(k);

    for (var d = 0; d < 2; d++) {
      for (var j = 0; j < live.length; j++) {
        this.seats[live[j]].hole.push(this.deck.pop());
      }
    }

    this.postBlind(this.seats[sbIdx], this.smallBlind, 'small');
    this.postBlind(this.seats[bbIdx], this.bigBlind, 'big');

    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.raiseCount = 1;

    // 翻牌前从大盲下一位开始（heads-up 时小盲/按钮先行动）
    var first = n > 2 ? this.nextActiveFrom(bbIdx + 1) : this.nextActiveFrom(sbIdx);
    this.buildQueue(first >= 0 ? first : 0);
    this.streetSnaps.push({ street: 'preflop', board: [], pot: this.potTotal() });

    this.emit('handStart', { handNo: this.handNo, button: this.button, sb: sbIdx, bb: bbIdx });
    this.emit('deal', { board: [] });
    return this;
  };

  Game.prototype.postBlind = function (seat, amount, kind) {
    var cost = Math.min(amount, seat.chips);
    seat.chips -= cost;
    seat.bet += cost;
    seat.committed += cost;
    if (seat.chips <= 0) seat.allIn = true;
    this.emit('post', { seat: seat.index, amount: cost, kind: kind });
  };

  /** 从 from 开始找第一个还能行动的座位（跳过已弃牌/全下/出局） */
  Game.prototype.nextActiveFrom = function (from) {
    var n = this.seats.length;
    for (var i = 0; i < n; i++) {
      var idx = (from + i + n) % n;
      var s = this.seats[idx];
      if (!s.folded && !s.sittingOut && !s.allIn && s.chips > 0) return idx;
    }
    return -1;
  };

  /** 构建一轮的行动队列 */
  Game.prototype.buildQueue = function (startIndex) {
    var n = this.seats.length;
    this.queue = [];
    for (var i = 0; i < n; i++) {
      var idx = (startIndex + i) % n;
      var s = this.seats[idx];
      if (!s.folded && !s.sittingOut && !s.allIn && s.chips > 0) this.queue.push(idx);
    }
    this.advanceActor();
  };

  Game.prototype.advanceActor = function () {
    if (this.queue.length === 0) { this.currentActor = -1; return; }
    this.currentActor = this.queue.shift();
  };

  // ============ 行动合法性 ============
  Game.prototype.legalActions = function (seatIndex) {
    var s = this.seats[seatIndex];
    var toCall = Math.max(0, this.currentBet - s.bet);
    var pot = this.potTotal();
    return {
      canCheck: toCall === 0,
      canCall: toCall > 0,
      toCall: Math.min(toCall, s.chips),
      potOdds: toCall > 0 ? toCall / (pot + toCall) : 0,
      minRaiseTo: this.currentBet + Math.max(this.minRaise, this.bigBlind),
      maxTo: s.bet + s.chips,
      pot: pot,
      street: this.street
    };
  };

  // ============ 执行行动 ============
  /**
   * action: 'fold' | 'check' | 'call' | 'raise' | 'allin'
   * raiseTo: raise 时本轮下注目标总额
   */
  Game.prototype.act = function (seatIndex, action, raiseTo, reason) {
    var s = this.seats[seatIndex];
    if (!s || s.folded || s.allIn) return { ok: false, error: '该座位无法行动' };
    if (this.currentActor !== seatIndex) return { ok: false, error: '未轮到该座位行动' };

    var toCall = Math.max(0, this.currentBet - s.bet);
    var potBefore = this.potTotal();
    var cost = 0;
    var act = action;

    // 记录决策前的分析数据（复盘用）
    var equity = 0;
    try {
      equity = this.street === 'preflop'
        ? Equity.preflopEquity(s.hole, this.numOpponents(s))
        : Equity.handStrength(s.hole, this.board, this.numOpponents(s), 300);
    } catch (e) { equity = 0.5; }
    var potOdds = toCall > 0 ? toCall / (potBefore + toCall) : 0;

    if (act === 'fold') {
      s.folded = true;
      s.lastAction = '弃牌';
    } else if (act === 'check') {
      if (toCall > 0) act = 'call';
      else s.lastAction = '过牌';
    }

    if (act === 'call') {
      cost = Math.min(toCall, s.chips);
      s.chips -= cost;
      s.bet += cost;
      s.committed += cost;
      s.lastAction = '跟注 ' + cost;
      if (s.chips <= 0) s.allIn = true;
    } else if (act === 'raise' || act === 'allin') {
      var target;
      if (act === 'allin') target = s.bet + s.chips;
      else target = Math.max(raiseTo || 0, this.currentBet + this.minRaise);
      var maxTarget = s.bet + s.chips;
      if (target > maxTarget) target = maxTarget;
      if (target <= this.currentBet) {
        // 不够最小加注 → 视为 all-in 跟注
        cost = Math.min(toCall, s.chips);
        s.chips -= cost; s.bet += cost; s.committed += cost;
        s.lastAction = '跟注 ' + cost;
        act = 'call';
        if (s.chips <= 0) s.allIn = true;
      } else {
        cost = target - s.bet;
        s.chips -= cost;
        var raiseDelta = target - this.currentBet;
        s.bet = target;
        s.committed += cost;
        s.lastAction = '加注到 ' + target;
        if (raiseDelta >= this.minRaise) this.minRaise = raiseDelta;
        this.currentBet = target;
        this.raiseCount++;
        this.aggressorIndex = seatIndex;
        if (s.chips <= 0) { s.allIn = true; act = 'allin'; s.lastAction = '全下 ' + target; }
        // 加注后其他人需要重新行动
        this.requeue(seatIndex);
      }
    }

    s.lastReason = reason || '';

    // ---- 记录复盘快照 ----
    var log = {
      street: this.street,
      streetCN: this.streetCN(this.street),
      seatIndex: seatIndex,
      actorId: s.id,
      actorName: s.name,
      isHuman: s.isHuman,
      action: act,
      amount: cost,
      raiseTo: s.bet,
      potBefore: potBefore,
      toCall: toCall,
      equity: equity,
      potOdds: potOdds,
      board: this.board.slice(),
      hole: s.hole.slice(),
      position: this.positionFactor(s),
      numOpponents: this.numOpponents(s),
      bb: this.bigBlind,
      reason: reason || '',
      allIn: s.allIn
    };
    this.handLog.push(log);

    // ---- 玩家统计（HUD + Boss 建模）----
    var st = s.stats;
    st.hands = st.hands || 0;
    var facingBet = toCall > 0;
    if (s.isHuman) {
      if (facingBet) { st.facedBet++; if (act === 'fold') st.foldsToBet++; }
      if (this.street === 'preflop' && (act === 'call' || act === 'raise' || act === 'allin')) st.vpip++;
      if (this.street === 'preflop' && (act === 'raise' || act === 'allin')) st.pfr++;
    }
    if (act === 'fold') st.folds++;
    if (act === 'call') st.calls++;
    if (act === 'raise' || act === 'allin') st.raises++;

    this.emit('action', {
      seat: seatIndex, action: act, amount: cost, to: s.bet,
      reason: reason || '', pot: this.potTotal(), name: s.name, street: this.street
    });

    // ---- 推进 ----
    if (this.activeSeats().length <= 1) {
      this.finishHand();
      return { ok: true, done: true };
    }
    if (this.queue.length === 0) {
      this.endBettingRound();
      return { ok: true, done: this.isHandOver };
    }
    this.advanceActor();
    return { ok: true, done: false };
  };

  Game.prototype.requeue = function (exceptIndex) {
    var n = this.seats.length;
    this.queue = [];
    var start = (exceptIndex + 1) % n;
    for (var i = 0; i < n; i++) {
      var idx = (start + i) % n;
      var s = this.seats[idx];
      if (idx !== exceptIndex && !s.folded && !s.sittingOut && !s.allIn && s.chips > 0) this.queue.push(idx);
    }
  };

  // ============ 街推进 ============
  Game.prototype.endBettingRound = function () {
    if (this.activeSeats().length <= 1) { this.finishHand(); return; }
    // 只剩一个能行动的人（其余全下）→ 直接发完
    if (this.actableSeats().length <= 1) {
      while (this.street !== 'river') this.dealNextStreet(true);
      this.showdown();
      return;
    }
    if (this.street === 'river') { this.showdown(); return; }
    this.dealNextStreet(false);
  };

  Game.prototype.dealNextStreet = function (silent) {
    var idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    var need = this.street === 'flop' ? 3 : 1;
    for (var i = 0; i < need; i++) {
      this.deck.pop(); // 烧牌
      this.board.push(this.deck.pop());
    }
    // 新一轮下注
    for (var k = 0; k < this.seats.length; k++) this.seats[k].bet = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.raiseCount = 0;
    this.aggressorIndex = -1;
    this.streetSnaps.push({ street: this.street, board: this.board.slice(), pot: this.potTotal() });
    this.emit('street', { street: this.street, board: this.board.slice(), streetCN: this.streetCN(this.street) });
    if (!silent) {
      var st = this.nextActiveFrom(this.button + 1);
      this.buildQueue(st >= 0 ? st : 0);
    }
  };

  // ============ 边池 ============
  Game.prototype.buildPots = function () {
    var levels = [];
    var i, j;
    for (i = 0; i < this.seats.length; i++) {
      var c = this.seats[i].committed;
      if (c > 0 && levels.indexOf(c) < 0) levels.push(c);
    }
    levels.sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    for (i = 0; i < levels.length; i++) {
      var lv = levels[i], amount = 0, eligible = [];
      for (j = 0; j < this.seats.length; j++) {
        var s = this.seats[j];
        var upto = Math.min(s.committed, lv);
        if (upto > prev) amount += upto - prev;
        if (s.committed >= lv && !s.folded) eligible.push(s.index);
      }
      if (amount > 0) pots.push({ amount: amount, eligible: eligible });
      prev = lv;
    }
    return pots;
  };

  // ============ 摊牌 ============
  Game.prototype.showdown = function () {
    var active = this.activeSeats();
    var i;
    if (active.length <= 1) { this.awardTo(active); return; }

    var evals = [];
    for (i = 0; i < active.length; i++) {
      var s = active[i];
      var seven = s.hole.concat(this.board);
      var ev = HandEval.evaluate(seven);
      evals.push({ seatIndex: s.index, value: ev.value, rank: ev.rank, name: HandEval.describe(ev), hole: s.hole.slice() });
    }

    var pots = this.buildPots();
    var payouts = [];
    for (i = 0; i < this.seats.length; i++) payouts[i] = 0;

    var winnersInfo = [];
    for (i = 0; i < pots.length; i++) {
      var pot = pots[i];
      var elig = pot.eligible;
      if (!elig.length) continue;
      var best = -1, winners = [];
      for (var e = 0; e < evals.length; e++) {
        if (elig.indexOf(evals[e].seatIndex) < 0) continue;
        if (evals[e].value > best) { best = evals[e].value; winners = [evals[e].seatIndex]; }
        else if (evals[e].value === best) winners.push(evals[e].seatIndex);
      }
      var share = Math.floor(pot.amount / winners.length);
      var rem = pot.amount - share * winners.length;
      // 余数给按钮后第一个赢家
      if (rem > 0 && winners.length) {
        var n = this.seats.length, firstIdx = 0, bestDist = 99;
        for (var w = 0; w < winners.length; w++) {
          var dist = (winners[w] - this.button + n) % n;
          if (dist > 0 && dist < bestDist) { bestDist = dist; firstIdx = w; }
        }
        payouts[winners[firstIdx]] += rem;
      }
      for (var k = 0; k < winners.length; k++) payouts[winners[k]] += share;
      winnersInfo.push({ pot: pot.amount, seats: winners.slice() });
    }

    this.settle(payouts, evals, winnersInfo, true);
  };

  /** 只剩一名玩家（其余弃牌）：直接把底池判给他，不摊牌 */
  Game.prototype.awardTo = function (active) {
    var payouts = [], i;
    for (i = 0; i < this.seats.length; i++) payouts[i] = 0;
    var evals = [];
    if (active.length === 1) {
      payouts[active[0].index] = this.potTotal();
      var ev = HandEval.evaluate(active[0].hole.concat(this.board));
      evals.push({ seatIndex: active[0].index, value: ev.value, rank: ev.rank, name: HandEval.describe(ev), hole: active[0].hole.slice() });
    }
    this.settle(payouts, evals, active.length === 1 ? [{ pot: this.potTotal(), seats: [active[0].index] }] : [], false);
  };

  Game.prototype.finishHand = function () {
    var active = this.activeSeats();
    if (active.length <= 1) { this.awardTo(active); return; }
    this.showdown();
  };

  Game.prototype.settle = function (payouts, evals, winnersInfo, isShowdown) {
    var i;
    var playerDelta = 0;
    var winners = [];
    for (i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      var win = payouts[i] || 0;
      var delta = win - s.committed;
      s.chips += win;
      if (delta > 0) { s.consecutiveLosses = 0; if (isShowdown) s.stats.wins++; }
      else if (delta < 0 && s.committed > 0) s.consecutiveLosses++;
      if (isShowdown && s.committed > 0 && !s.folded) s.stats.showdowns++;

      // 情绪更新（仅 AI）
      if (!s.isHuman && s.personality) {
        var ev2 = null, k2;
        for (k2 = 0; k2 < evals.length; k2++) if (evals[k2].seatIndex === i) ev2 = evals[k2];
        var last2 = null;
        for (k2 = this.handLog.length - 1; k2 >= 0; k2--) {
          if (this.handLog[k2].seatIndex === i) { last2 = this.handLog[k2]; break; }
        }
        var wasAggr = !!last2 && (last2.action === 'raise' || last2.action === 'allin');
        if (s.committed > 0 || win > 0) {
          this.updateMood(s, delta, ev2 ? ev2.rank : -1, wasAggr, win > 0);
        }
      }
      if (win > 0) {
        var ev = null;
        for (var j = 0; j < evals.length; j++) if (evals[j].seatIndex === i) ev = evals[j];
        winners.push({ seatIndex: i, name: s.name, amount: win, handName: ev ? ev.name : '', hole: ev ? ev.hole : [] });
      }
      if (s.isHuman) playerDelta = delta;
    }

    // ---- 判定「诈唬赢家」：最后一击是加注/全下，成手牌却只有一对以下 ----
    // （仅用于内部情绪与关系计算，是否亮牌由玩家自己判断，不做强制展示）
    var bluffSeats = [];
    for (i = 0; i < winners.length; i++) {
      var wi = winners[i].seatIndex, lv = null, we = null, q1;
      for (q1 = this.handLog.length - 1; q1 >= 0; q1--) {
        if (this.handLog[q1].seatIndex === wi) { lv = this.handLog[q1]; break; }
      }
      for (q1 = 0; q1 < evals.length; q1++) if (evals[q1].seatIndex === wi) we = evals[q1];
      if (lv && (lv.action === 'raise' || lv.action === 'allin') && we && we.rank <= 1) bluffSeats.push(wi);
    }

    // ---- 对手关系（rivalry）：被偷会记仇，偷成功会觉得对方好欺负 ----
    this.updateRelations(winners, bluffSeats, evals);

    var result = {
      handNo: this.handNo,
      board: this.board.slice(),
      pot: (function (g) { var t = 0; for (var k = 0; k < g.seats.length; k++) t += g.seats[k].committed; return t; })(this),
      winners: winners,
      bluffSeats: bluffSeats,
      showdown: isShowdown,
      playerDelta: playerDelta,
      playerHole: this.seats[this.playerIndex] ? this.seats[this.playerIndex].hole.slice() : [],
      playerFolded: this.seats[this.playerIndex] ? this.seats[this.playerIndex].folded : true,
      street: this.street,
      handLog: this.handLog.slice(),
      streetSnaps: this.streetSnaps.slice(),
      evals: evals.slice()
    };
    this.lastResult = result;
    this.history.push(result);
    if (this.history.length > 30) this.history.shift();

    // 更新玩家模型（Boss 读牌用）
    var ps = this.seats[this.playerIndex];
    if (ps) {
      var st = ps.stats;
      this.playerModel = {
        hands: st.hands || this.handNo,
        vpip: st.hands ? (st.vpip / st.hands) : 0,
        foldToBet: st.facedBet ? (st.foldsToBet / st.facedBet) : 0,
        aggression: st.calls ? (st.raises / st.calls) : 1
      };
    }

    this.isHandOver = true;
    this.currentActor = -1;
    this.emit('handEnd', result);
    this.afterHandSettle();   // 比赛模式：结算淘汰 / 轮末 / 终局
  };

  // ============ 比赛模式（轮次制）辅助 ============
  /** 当前存活人数（未淘汰） */
  Game.prototype.aliveCount = function () {
    var n = 0;
    for (var i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      if (this.match && this.match.enabled) { if (!this.match.eliminated[i]) n++; }
      else if (s.chips > 0 && !s.sittingOut) n++;
    }
    return n;
  };

  /** 把某座位标记为淘汰（幂等）。真实对局在结算时自动调用；也可供测试/管理调用。 */
  Game.prototype.eliminateSeat = function (seatIndex) {
    var m = this.match, s = this.seats[seatIndex];
    if (!m || !m.enabled || !s || m.eliminated[seatIndex]) return false;
    s.chips = 0;
    m.eliminated[seatIndex] = true;
    s.eliminated = true;
    s.sittingOut = true;
    s.folded = true;
    m.bustOrder.push(seatIndex);
    m.bustRound[seatIndex] = m.roundNo;
    if (m.roundBustOrder.indexOf(seatIndex) < 0) m.roundBustOrder.push(seatIndex);
    this.emit('eliminate', { seat: seatIndex, name: s.name, roundNo: m.roundNo });
    return true;
  };

  /** 一手牌结算后的比赛推进：淘汰归零座位 → 手数累计 → 轮末/终局判定 */
  Game.prototype.afterHandSettle = function () {
    var m = this.match;
    if (!m || !m.enabled || m.over) return;
    for (var i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      if (!m.eliminated[i] && s.chips <= 0) this.eliminateSeat(i);
    }
    m.handsInRound++;
    if (this.aliveCount() <= 1) this.finishRound(true);
    else if (m.handsInRound >= m.roundHands) this.finishRound(false);
  };

  /**
   * 生成本轮结算榜单（按筹码排序），并结算名次积分：第1名+5 / 第2名+3 / 第3名+1。
   * 淘汰者按出局先后排底、记 0 分。调用前须保证 match 存在。
   */
  Game.prototype.computeRoundStandings = function () {
    var m = this.match;
    var arr = [], i;
    for (i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      arr.push({
        seatIndex: i, id: s.id, name: s.name, avatar: s.avatar || '', isHuman: s.isHuman,
        personality: s.personality ? s.personality.id : '',
        chips: s.chips, eliminated: !!m.eliminated[i],
        bustOrder: m.eliminated[i] ? m.bustOrder.indexOf(i) : -1,
        roundDelta: s.chips - (m.roundStartChips[i] || 0),
        roundPts: 0, totalPts: m.points[i] || 0
      });
    }
    arr.sort(function (a, b) {
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;   // 存活在前
      if (!a.eliminated) return (b.chips - a.chips) || (a.seatIndex - b.seatIndex);
      return b.bustOrder - a.bustOrder;                                  // 越晚出局排越高
    });
    var award = [5, 3, 1];
    for (var k = 0; k < arr.length; k++) {
      arr[k].rank = k + 1;
      if (!arr[k].eliminated && k < 3) arr[k].roundPts = award[k];
      arr[k].totalPts = (arr[k].totalPts || 0) + arr[k].roundPts;
      m.points[arr[k].seatIndex] = arr[k].totalPts;
      m.roundPts[arr[k].seatIndex] = arr[k].roundPts;
    }
    return arr;
  };

  /** 最终排名：按累计积分降序，同分按筹码降序、再按座位号 */
  Game.prototype.finalStandings = function () {
    var m = this.match;
    var arr = [], i;
    for (i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      arr.push({
        seatIndex: i, id: s.id, name: s.name, avatar: s.avatar || '', isHuman: s.isHuman,
        personality: s.personality ? s.personality.id : '',
        chips: s.chips, eliminated: m ? !!m.eliminated[i] : !!s.eliminated,
        roundPts: m ? (m.roundPts[i] || 0) : 0,
        totalPts: m ? (m.points[i] || 0) : 0
      });
    }
    arr.sort(function (a, b) {
      // 自然终局（只剩 1 人）：幸存者强制第一，其余按累计积分 desc（同分比筹码）
      if (m && m.enabled && m.over && a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      return (b.chips - a.chips) || (a.seatIndex - b.seatIndex);
    });
    for (var k = 0; k < arr.length; k++) arr[k].rank = k + 1;
    return arr;
  };

  /**
   * 轮末结算（自然轮满或终局）。over=true 时比赛结束。
   * @return {Array} standings
   */
  Game.prototype.finishRound = function (over) {
    var m = this.match;
    var standings = this.computeRoundStandings();
    m.lastStandings = standings;
    m.pendingRoundEnd = true;
    var survivors = 0, i;
    for (i = 0; i < standings.length; i++) if (!standings[i].eliminated) survivors++;
    var leader = standings[0];
    this.emit('roundEnd', {
      roundNo: m.roundNo, sb: this.smallBlind, bb: this.bigBlind,
      handsPlayed: m.handsInRound,
      standings: standings,
      over: !!over,
      eliminated: m.roundBustOrder.slice(),
      leader: { id: leader.id, name: leader.name, avatar: leader.avatar, chips: leader.chips },
      survivors: survivors
    });
    if (over) {
      m.over = true;
      var fin = this.finalStandings();
      var champ = fin[0];
      this.emit('matchEnd', {
        roundNo: m.roundNo,
        standings: fin,
        champion: { id: champ.id, name: champ.name, avatar: champ.avatar, totalPts: champ.totalPts, chips: champ.chips, eliminated: champ.eliminated }
      });
    }
    return standings;
  };

  /** 开始下一轮（轮末确认后调用）：轮次+1、盲注升级、手数清零。 */
  Game.prototype.startNextRound = function () {
    var m = this.match;
    if (!m || !m.enabled || m.over || !m.pendingRoundEnd) return false;
    m.roundNo++;
    m.handsInRound = 0;
    m.pendingRoundEnd = false;
    m.roundBustOrder = [];
    var lv = m.blindLevels[Math.min(m.roundNo - 1, m.blindLevels.length - 1)];
    this.smallBlind = lv.sb;
    this.bigBlind = lv.bb;
    for (var i = 0; i < this.seats.length; i++) m.roundStartChips[i] = this.seats[i].chips;
    this.emit('roundStart', { roundNo: m.roundNo, sb: this.smallBlind, bb: this.bigBlind });
    return true;
  };

  /**
   * 更新 AI 之间的「对手关系」。
   * 关系值 -100..100：负 = 记恨（对他更凶、更不愿弃牌），正 = 觉得好欺负（对他更爱偷）。
   * 人类玩家同样会被 AI 记住——你老偷他的盲，他会盯上你。
   */
  Game.prototype.updateRelations = function (winners, bluffSeats, evals) {
    if (!winners || !winners.length) return;
    var i, q;
    for (i = 0; i < this.seats.length; i++) {
      var s = this.seats[i];
      if (!s.personality) continue;             // 人类玩家不参与关系计算
      if (s.committed <= 0) continue;           // 没投入就不算过节
      var vol = s.personality.moodVolatility || 0.3;
      var myRank = -1;
      for (q = 0; q < evals.length; q++) if (evals[q].seatIndex === i) myRank = evals[q].rank;
      var iWon = false;
      for (q = 0; q < winners.length; q++) if (winners[q].seatIndex === i) iWon = true;

      for (q = 0; q < winners.length; q++) {
        var wi = winners[q].seatIndex;
        if (wi === i) continue;
        var wseat = this.seats[wi];
        var bluffed = bluffSeats.indexOf(wi) >= 0;   // 赢家是诈唬赢的
        var relDelta = 0;
        // 只记「特殊的过节」，普通输赢不往心里去，否则所有人都会互相记恨
        if (iWon) {
          if (bluffed) relDelta = 15;                // 我偷他成功 → 觉得他好欺负
          else if (myRank >= 5) relDelta = 6;        // 我大牌赢他 → 略占上风
        } else {
          if (bluffed) relDelta = -32;               // 被他偷了 → 记仇
          else if (myRank >= 5) relDelta = -28;      // 我大牌被反超（bad beat）→ 记仇
        }
        if (!relDelta) continue;
        var w = 0.5 + vol * 0.7;
        s.relations[wseat.id] = clampRel((s.relations[wseat.id] || 0) + relDelta * w);

        // 被偷的一方：当场发火（影响后续打法）
        if (bluffed && !iWon) {
          s.mood = Math.max(-100, Math.round((s.mood || 0) - 16 * (0.4 + vol)));
          s.moodLabel = Personalities.moodLabel(s.mood);
          s.moodEvent = '被' + wseat.name + '偷了一把，记下了';
          this.emit('mood', { seat: s.index, name: s.name, mood: s.mood, label: s.moodLabel, event: s.moodEvent });
        }
        // 偷成功的赢家：觉得对方好欺负
        if (bluffed && wseat.personality) {
          var wv = wseat.personality.moodVolatility || 0.3;
          wseat.relations[s.id] = clampRel((wseat.relations[s.id] || 0) + 13 * (0.5 + wv * 0.7));
        }
      }
    }
  };

  /** 某 AI 对另一个座位的关系值 */
  Game.prototype.relationOf = function (seatIndex, otherId) {
    var s = this.seats[seatIndex];
    return s && s.relations ? (s.relations[otherId] || 0) : 0;
  };

  /** 关系值 -> 中文描述（UI 用） */
  function relationWord(v) {
    if (v <= -60) return '死盯';
    if (v <= -25) return '记仇';
    if (v >= 60) return '拿捏';
    if (v >= 25) return '好欺负';
    return '';
  }

  function clampRel(v) { return Math.max(-100, Math.min(100, Math.round(v))); }

  /**
   * 情绪更新：输赢、bad beat、诈唬成败都会影响 AI 心态，
   * 进而通过 brain.js 改变其打法（上头 → 变松、更多诈唬）。
   */
  Game.prototype.updateMood = function (seat, delta, handRank, wasAggressor, won) {
    var vol = seat.personality ? (seat.personality.moodVolatility || 0.3) : 0.3;
    var before = seat.mood || 0;
    var ev = '';
    // 盲注级别的正常损耗不值得动情绪，只有真正的输赢大池才影响心态
    if (Math.abs(delta) <= this.bigBlind * 3) {
      seat.mood = Math.round((seat.mood || 0) * 0.9);
      seat.moodLabel = Personalities.moodLabel(seat.mood);
      return;
    }
    if (delta > 0) {
      seat.mood += (12 + Math.min(32, delta / 15)) * (0.4 + vol);
      if (won && wasAggressor && handRank >= 0 && handRank <= 1) { seat.mood += 14 * vol; ev = '偷鸡得手，飘了'; }
      else if (won && handRank >= 6) { seat.mood += 9 * vol; ev = '大牌收池，心情不错'; }
      if (!ev && delta > this.bigBlind * 8) ev = '赢下大池，士气大振';
    } else if (delta < 0) {
      seat.mood -= (12 + Math.min(32, -delta / 15)) * (0.4 + vol);
      if (handRank >= 5 && !won) { seat.mood -= 22 * vol; ev = '被 bad beat，心态炸了'; }
      else if (wasAggressor && handRank >= 0 && handRank <= 1) { seat.mood -= 11 * vol; ev = '诈唬被抓，恼火'; }
      else if (seat.consecutiveLosses >= 3) { seat.mood -= 12 * vol; ev = '连败不止，越打越急'; }
      if (!ev && -delta > this.bigBlind * 8) ev = '输掉大池，陷入低谷';
    }
    seat.mood = Math.max(-100, Math.min(100, Math.round(seat.mood)));
    seat.moodLabel = Personalities.moodLabel(seat.mood);
    // 只在情绪状态发生跨越时记录事件（供 UI 冒泡显示）
    if (ev && Personalities.moodLabel(before) !== seat.moodLabel) seat.moodEvent = ev;
    else if (!ev) seat.moodEvent = '';
    if (ev) this.emit('mood', { seat: seat.index, name: seat.name, mood: seat.mood, label: seat.moodLabel, event: ev });
  };

  // ============ 给 Brain 的上下文 ============
  Game.prototype.buildCtx = function (seatIndex) {
    var s = this.seats[seatIndex];
    var posF = this.positionFactor(s);
    var agg = this.aggressorIndex >= 0 ? this.seats[this.aggressorIndex] : null;
    return {
      seat: s,
      table: {
        board: this.board,
        pot: this.potTotal(),
        currentBet: this.currentBet,
        minRaise: this.minRaise,
        bigBlind: this.bigBlind,
        street: this.street,
        numOpponents: this.numOpponents(s),
        aggressorId: this.aggressorIndex >= 0 ? this.seats[this.aggressorIndex].id : null,
        raiseCount: this.raiseCount,
        positionFactor: posF,
        // 偷鸡情境：前位无人加注、我在后位 → 可以偷盲
        stealOpportunity: this.street === 'preflop' && this.raiseCount <= 1 && posF > 0.55,
        // 对手疑似在后位偷盲 → 我可以反偷
        stealAttempt: !!agg && this.street === 'preflop' && this.raiseCount === 2 && this.positionFactor(agg) > 0.6
      },
      playerModel: this.playerModel
    };
  };

  /** 让 AI 座位做出决策（需要 Poker.Brain 已加载） */
  Game.prototype.aiDecide = function (seatIndex) {
    var Brain = Poker.Brain || treq('./ai/brain.js');
    if (!Brain) return { action: 'check', raiseTo: 0, amount: 0, reason: '' };
    return Brain.decide(this.buildCtx(seatIndex));
  };

  Game.STREETS = STREETS;
  Game.STREET_CN = STREET_CN;
  Game.relationWord = relationWord;

  Poker.Game = Game;
  if (typeof module !== 'undefined' && module.exports) module.exports = Game;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
