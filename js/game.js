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

  // 共享模块（UMD：浏览器用 window.Poker.*，Node 用 require 回退）。
  // makeRng 已抽到 js/ai/rng.js，避免 drift.js 与 game.js 循环依赖；
  // Mood / Relations / Drift 为本次抽出的人格情绪 / 关系 / 策略漂移系统。
  var Mood = Poker.Mood || treq('./ai/mood.js');
  var Relations = Poker.Relations || treq('./ai/relations.js');
  var Drift = Poker.Drift || treq('./ai/drift.js');

  var Cards = Poker.Cards || treq('./cards.js');
  var HandEval = Poker.HandEval || treq('./handEval.js');
  var Equity = Poker.Equity || treq('./equity.js');
  var Personalities = Poker.Personalities || treq('./ai/personalities.js');
  var Structures = Poker.Structures || treq('./structure.js');

  var STREETS = ['preflop', 'flop', 'turn', 'river'];
  var STREET_CN = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };

  function Game(config) {
    this.config = config || {};
    this.smallBlind = this.config.smallBlind || 10;
    this.bigBlind = this.config.bigBlind || 20;
    this.initialChips = this.config.initialChips || 1000;
    this.rng = this.config.rng || Math.random;
    // 策略漂移流：抽到 Drift.setup（内部用独立 PRNG，不碰牌局主 rng）。
    var driftState = (Drift && typeof Drift.setup === 'function')
      ? Drift.setup(this.config)
      : { enabled: this.config.drift !== false, seed: 20250821, rng: null };
    this.driftEnabled = driftState.enabled;
    this.driftSeed = driftState.seed;
    this.driftRng = driftState.rng;

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
        // 策略漂移的「锚」：人格出厂基准，永不被篡改。
        // seat.personality 每手会被替换为围绕它的派生对象（见 applyPersonalityDrift），
        // 所有需要读「这个人本来是谁」的地方请用 basePersonality。
        basePersonality: isHuman ? null : (typeof d.personality === 'string' ? Personalities.get(d.personality) : (d.personality || Personalities.get('tag'))),
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
        _trap: false,      // B3 慢打陷阱线：本手内是否已跟注慢打，等下一街收网
        _trapDone: false,  // B3 每座位每手至多慢打一次
        _allinStreet: '',  // C1 AIV：本手该座全下时所在的街（''=尚未全下）
        stats: { hands: 0, vpip: 0, pfr: 0, folds: 0, calls: 0, raises: 0, showdowns: 0, wins: 0, facedBet: 0, foldsToBet: 0, threeBet: 0, steal: 0, cBetFaced: 0, foldToCBet: 0 },
        // C1 AIV 累计（座位级，不进 seat.stats——stats 是「每手一次」整数计数口径，
        // AIV 是带符号浮点期望/运气，放 seat 顶层避免破坏该口径的断言）
        cumAiv: 0,
        cumLuck: 0
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
    // C1 AIV：全下 EV 段事件（整 session 累积；换桌 new Game 清零）
    this.aivEvents = [];
    // 人类玩家模型（供 Boss 读牌 + HUD）
    this.playerModel = { hands: 0, vpip: 0, foldToBet: 0, aggression: 0 };

    // ---- 比赛模式（轮次制）：match.enabled === true ----
    // roundHands: 每轮手数；blindLevels: 盲注按轮升级 + Ante（第 6 档起）；不补筹，出局即淘汰
    this.match = null;
    this.ante = 0;   // 每手每人额外缴纳的 Ante（比赛第 6 轮起 > 0；练习模式恒 0）
    if (this.config.match && this.config.match.enabled) {
      var mOpt = this.config.match;
      // Ante 归一化：旧表/自定义表未显式带 ante 时，第 6 档（index≥5）起自动按 BB×10% 向上取整到 5
      var normLv = function (lv, idx) {
        var ante = (lv.ante != null) ? lv.ante : (idx >= 5 ? Math.ceil((lv.bb || 20) * 0.10 / 5) * 5 : 0);
        return { sb: lv.sb, bb: lv.bb, ante: ante };
      };
      // 赛制结构（单一数据源 js/structure.js）：未显式指定时用内置结构表
      var st = (Structures && Structures.get) ? Structures.get(mOpt.structure) : null;
      if (!st) {
        st = { id: 'fast', startStack: 2000, handsPerLevel: 15, payoutPct: 0.5,
          allowReentry: false, reentryUntilLevel: 0, reentryMax: 0, awardRule: [5, 3, 1],
          levels: [{ sb: 10, bb: 20, ante: 0 }] };
      }
      // 显式传入的 blindLevels 仍优先（老调用方/测试大量使用），缺 ante 时走上面的归一化
      var rawLevels = (mOpt.blindLevels && mOpt.blindLevels.length) ? mOpt.blindLevels : st.levels;
      var levels = [];
      for (var li = 0; li < rawLevels.length; li++) levels.push(normLv(rawLevels[li], li));
      var lv0 = levels[0] || { sb: 10, bb: 20, ante: 0 };
      this.smallBlind = lv0.sb;
      this.bigBlind = lv0.bb;
      this.ante = lv0.ante || 0;
      this.config.autoRebuy = false;   // 比赛永不补筹
      var m = {
        enabled: true,
        roundHands: mOpt.roundHands || st.handsPerLevel,
        blindLevels: levels,
        // ---- 赛制结构（来自 js/structure.js）----
        structureId: st.id,
        startStack: st.startStack,
        allowReentry: (mOpt.allowReentry != null) ? !!mOpt.allowReentry : !!st.allowReentry,
        reentryUntilLevel: (mOpt.reentryUntilLevel != null) ? mOpt.reentryUntilLevel : (st.reentryUntilLevel || 0),
        reentryMax: (mOpt.reentryMax != null) ? mOpt.reentryMax : (st.reentryMax || 0),
        reentryCount: [],         // 每个座位已重入次数
        inMoney: (Structures && Structures.inMoneyCount) ? Structures.inMoneyCount(st, this.seats.length) : 3, // 进圈人数
        isBubble: false,          // 泡沫期：存活人数 == 进圈人数 + 1
        pendingReentry: {},       // 待玩家确认重入（仅人类；放弃则在下一手开局前判淘汰）
        payouts: (mOpt.payouts && mOpt.payouts.length) ? mOpt.payouts.slice() : null, // B2 奖金结构（如 [50,30,20]）；null=不启用 ICM
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
        m.reentryCount[mi] = 0;
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

  /**
   * 每手开局为所有 AI 座位生成「本手临时人格」。
   *
   * 锚点是 seat.basePersonality（构造时固定，永不被写），seat.personality 被替换为
   * 围绕它做有界摆动的派生对象。derive 保证 id 不变，因此排行榜序列化
   * （computeRoundStandings / finalStandings）、复盘 review.js、关系系统
   * 读到的身份与写入 result 的 `personality` 字段都不受影响。
   *
   * 人类座位 personality 恒为 null，跳过。
   */
  Game.prototype.applyPersonalityDrift = function () {
    if (!Personalities || typeof Personalities.derive !== 'function') return;
    var n = this.seats.length;
    for (var i = 0; i < n; i++) {
      var s = this.seats[i];
      if (s.isHuman) continue;
      if (!s.personality) continue;
      // 兜底：从外部绕过构造函数塞进来的座位，第一次把当前人格认作锚点
      if (!s.basePersonality) s.basePersonality = s.personality;
      if (!this.driftEnabled) continue;
      var next = Drift.derive(s.basePersonality, this.driftRng);
      if (next && next.id === s.basePersonality.id) s.personality = next;
    }
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
      s._trap = false;
      s._trapDone = false;
      s._allinStreet = '';
      // 情绪随时间回归平静（抽到 Mood.decay）
      Mood.decay(s);
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

    // 关系随时间淡忘（抽到 Relations.decay，整桌一次性衰减，等价于原每座位内循环）
    Relations.decay(this.seats);

    // ---- 策略漂移：AI 不严格执行单一策略，围绕基准小幅摆动 ----
    // 必须在任何发牌 / 读决策之前执行，否则本手会用到上一手的人格。
    this.applyPersonalityDrift();

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

    // 角色标记（庄/小盲/大盲，UI 用 committed 已被前面的清理块重置）
    for (var ri = 0; ri < n; ri++) this.seats[ri].role = '';
    this.seats[this.button].role = 'D';
    this.seats[sbIdx].role = 'SB';
    this.seats[bbIdx].role = 'BB';

    this.deck = Cards.shuffle(Cards.buildDeck(), this.rng);
    var live = [];
    for (var k = 0; k < n; k++) if (!this.seats[k].sittingOut) live.push(k);

    for (var d = 0; d < 2; d++) {
      for (var j = 0; j < live.length; j++) {
        this.seats[live[j]].hole.push(this.deck.pop());
      }
    }

    // 比赛 Ante：所有存活座位先交 Ante（淘汰/坐出座不交），再收大小盲
    if (this.match && this.match.enabled && this.ante > 0) {
      for (var ai3 = 0; ai3 < live.length; ai3++) {
        this.postAnte(this.seats[live[ai3]], this.ante);
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
    if (seat.chips <= 0 && !seat.allIn) { seat.allIn = true; seat._allinStreet = 'preflop'; }
    // 给盲注打上动作标签，让座位徽章显示「大盲 20 / 小盲 10」而不是裸数字
    var cn = kind === 'big' ? '大盲' : (kind === 'small' ? '小盲' : '盲注');
    seat.lastAction = cn + ' ' + cost;
    this.emit('post', { seat: seat.index, amount: cost, kind: kind });
  };

  /** 缴纳 Ante：只计入 committed 进底池、不计入 bet（跟注仍需补满当前下注额） */
  Game.prototype.postAnte = function (seat, amount) {
    var cost = Math.min(amount, seat.chips);
    seat.chips -= cost;
    seat.committed += cost;
    if (seat.chips <= 0 && !seat.allIn) { seat.allIn = true; seat._allinStreet = 'preflop'; }
    seat.lastAction = '前注 ' + cost;
    this.emit('post', { seat: seat.index, amount: cost, kind: 'ante' });
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

    // 若本行动把玩家推成全下，记录全下街（C1 AIV 计算锁定街用；盲注/ante 已在 post 阶段记 preflop）
    if (s.allIn && !s._allinStreet) s._allinStreet = this.street;

    // 弃牌连击计数（残局 AI 用：连续弃牌会让范围放宽，专治“一直弃牌”观感）
    if (s.folded) s._foldStreak = (s._foldStreak || 0) + 1;
    else s._foldStreak = 0;

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
    // vpip/pfr/threeBet/steal/foldToCBet 改由手末 updateSeatStats() 按「每手一次」口径统一统计；
    // facedBet/foldsToBet 保持逐次动作口径（Boss 读人用）
    var st = s.stats;
    st.hands = st.hands || 0;
    var facingBet = toCall > 0;
    if (s.isHuman) {
      if (facingBet) { st.facedBet++; if (act === 'fold') st.foldsToBet++; }
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
    for (var k = 0; k < this.seats.length; k++) { this.seats[k].bet = 0; this.seats[k].lastAction = ''; }
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

  /** 街名 -> 该街时点已发的公共牌张数（preflop=0/flop=3/turn=4/river=5） */
  Game.prototype.boardLenAtStreet = function (street) {
    if (street === 'flop') return 3;
    if (street === 'turn') return 4;
    if (street === 'river') return 5;
    return 0;
  };

  /**
   * C1 AIV（All-in EV）：摊牌结算时把「≥2 名玩家筹码全入的同一底池/边池」拆成零和 AIV 段。
   * 每段 ev_i = equity_i × pot − contributed_i（已弃牌者 equity=0），Σev=0；
   * actual_i = 赢下该段份额 − contributed_i；luck_i = actual_i − ev_i。
   * 权益：河牌全下 = 精确（1/0/平局分拆，公共牌已齐直接比牌）；
   *       翻前/翻牌/转牌 = Equity.allinEquity 蒙特卡洛（只发剩余公共牌，各对手底牌已知）。
   * 事件 push 进 this.aivEvents（整桌 session 累积）；风险承担者座位 cumAiv/cumLuck 累计。
   * @param {Array} evals 摊牌成手评估 [{seatIndex,value,...}]（完整河牌公共牌口径）
   * @return {Array} 本手生成的 AIV 段（已同时挂进 this.aivEvents）
   */
  Game.prototype.recordAiv = function (evals) {
    var seats = this.seats;
    var n = seats.length;
    var EquityM = Poker.Equity || Equity;
    var CardsM = Poker.Cards || Cards;
    var handEvents = [];
    if (!EquityM || typeof EquityM.allinEquity !== 'function') return handEvents;
    var i, k;
    var levels = [];
    for (i = 0; i < n; i++) {
      var c = seats[i].committed;
      if (c > 0 && levels.indexOf(c) < 0) levels.push(c);
    }
    levels.sort(function (a, b) { return a - b; });
    var prev = 0;
    for (k = 0; k < levels.length; k++) {
      var lv = levels[k];
      var S = 0;
      var slice = new Array(n);
      var elig = [];
      for (i = 0; i < n; i++) {
        slice[i] = 0;
        var upto = Math.min(seats[i].committed, lv);
        if (upto > prev) { slice[i] = upto - prev; S += slice[i]; }
        if (seats[i].committed >= lv && !seats[i].folded) elig.push(i);
      }
      prev = lv;
      if (S <= 0) continue;
      // 该池至少 2 名全下玩家才算 AIV 段
      var allInElig = [];
      for (i = 0; i < elig.length; i++) if (seats[elig[i]].allIn) allInElig.push(elig[i]);
      if (allInElig.length < 2) continue;
      // 锁定街 = 该池全下玩家中最早全下的那条街（最短码先锁池）
      var street = 'river';
      for (i = 0; i < allInElig.length; i++) {
        var s2 = seats[allInElig[i]]._allinStreet || 'preflop';
        if (STREETS.indexOf(s2) < STREETS.indexOf(street)) street = s2;
      }
      // 权益：对池内可赢家按各自底牌 + 锁定街时点的公共牌模拟发牌
      var holes = [];
      for (i = 0; i < elig.length; i++) holes.push(seats[elig[i]].hole);
      var boardAt = this.board.slice(0, this.boardLenAtStreet(street));
      var eqArr = EquityM.allinEquity(holes, boardAt, 400, this.rng);
      // 赢家（按完整河牌口径的最终成手比大小）
      var winners = [];
      var best = -1;
      for (i = 0; i < evals.length; i++) {
        var ei = evals[i];
        if (elig.indexOf(ei.seatIndex) < 0) continue;
        if (ei.value > best) { best = ei.value; winners = [ei.seatIndex]; }
        else if (ei.value === best && winners.indexOf(ei.seatIndex) < 0) winners.push(ei.seatIndex);
      }
      var share = S / (winners.length || 1);
      // 段描述：池内可赢家的底牌文本（复盘「大冤家牌」用）
      var descParts = [];
      for (i = 0; i < elig.length; i++) descParts.push(CardsM.cardsText(seats[elig[i]].hole));
      var evs = [];
      var players = [];
      for (i = 0; i < n; i++) {
        if (slice[i] <= 0) continue;
        var eiPos = elig.indexOf(i);
        var eqI = eiPos >= 0 ? (eqArr[eiPos] || 0) : 0;
        var ev = eqI * S - slice[i];
        var isWin = winners.indexOf(i) >= 0;
        var actual = (isWin ? share : 0) - slice[i];
        var luck = actual - ev;
        var risk = eiPos >= 0; // 没弃牌且仍有赢池资格 = 风险承担者
        if (risk) {
          seats[i].cumAiv = (seats[i].cumAiv || 0) + ev;
          seats[i].cumLuck = (seats[i].cumLuck || 0) + luck;
        }
        evs.push(ev);
        players.push({ idx: i, name: seats[i].name, allIn: seats[i].allIn, contributed: slice[i], equity: eqI, ev: ev, actual: actual, luck: luck, risk: risk });
      }
      var evt = {
        handNo: this.handNo,
        street: street,
        streetCN: STREET_CN[street] || street,
        pot: S,
        desc: descParts.join(' vs '),
        players: players,
        evs: evs
      };
      this.aivEvents.push(evt);
      handEvents.push(evt);
    }
    return handEvents;
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

  // B1：手末按「每手一次」口径把客观历史挂进 seat.stats（供 Boss 翻前读人/HUD）。
  // vpip/pfr 语义：这手有没有主动入池/翻前加注（同一手无论加多少次只记 1）；
  // threeBet/steal/cBetFaced/foldToCBet 同理按手标记。逐次动作（folds/calls/raises、
  // facedBet/foldsToBet）仍在 act() 即时累计，两套口径互不干扰。
  Game.prototype.updateSeatStats = function () {
    var log = this.handLog;
    var n = this.seats.length;
    if (!log || !log.length || n === 0) return;
    var i;
    var flags = new Array(n);
    for (i = 0; i < n; i++) flags[i] = { vpip: false, pfr: false, threeBet: false, steal: false, cBetFaced: false, foldToCBet: false };

    var firstRaiseSeat = -1;
    var raiserCount = 0;
    for (i = 0; i < log.length; i++) {
      var e = log[i];
      if (e.street !== 'preflop') continue;
      var si = e.seatIndex;
      var aggr = e.action === 'raise' || e.action === 'allin';
      if (aggr) {
        if (firstRaiseSeat < 0) firstRaiseSeat = si;
        if (raiserCount > 0) flags[si].threeBet = true;
        raiserCount++;
      }
      if (e.action === 'call' || aggr) flags[si].vpip = true;
      if (aggr) flags[si].pfr = true;
    }
    if (firstRaiseSeat >= 0) flags[firstRaiseSeat].steal = true;

    var flopBettor = -1, flopBettorSeen = false;
    for (i = 0; i < log.length; i++) {
      var e3 = log[i];
      if (e3.street !== 'flop') continue;
      if (!flopBettorSeen && (e3.action === 'raise' || e3.action === 'allin')) {
        flopBettorSeen = true;
        flopBettor = e3.seatIndex;
        continue;
      }
      if (flopBettorSeen && e3.seatIndex !== flopBettor && e3.toCall > 0) {
        flags[e3.seatIndex].cBetFaced = true;
        if (e3.action === 'fold') flags[e3.seatIndex].foldToCBet = true;
      }
    }

    for (i = 0; i < n; i++) {
      var st = this.seats[i].stats;
      if (!st) continue;
      var f = flags[i];
      if (f.vpip) st.vpip++;
      if (f.pfr) st.pfr++;
      if (f.threeBet) st.threeBet++;
      if (f.steal) st.steal++;
      if (f.cBetFaced) st.cBetFaced++;
      if (f.foldToCBet) st.foldToCBet++;
    }
  };

  Game.prototype.settle = function (payouts, evals, winnersInfo, isShowdown) {
    var i;
    var playerDelta = 0;
    var winners = [];
    // C1 AIV：先按「全下段」记账（需要 committed/全下状态未被清掉），本手段返回给 result
    var aivHand = isShowdown ? this.recordAiv(evals) : [];
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
          Mood.applyHandResult(s, {
            won: win > 0,
            wasAggressor: wasAggr,
            handRank: ev2 ? ev2.rank : -1,
            delta: delta,
            vol: s.personality ? (s.personality.moodVolatility || 0.3) : 0.3,
            bigBlind: this.bigBlind,
            emit: this.emit.bind(this)
          });
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
      evals: evals.slice(),
      aiv: aivHand.length ? { count: aivHand.length, events: aivHand } : null
    };
    this.lastResult = result;
    this.history.push(result);
    if (this.history.length > 30) this.history.shift();

    // B1 手末客观历史挂账（须在 playerModel 计算之前）
    this.updateSeatStats();

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

  /** 当前盲注级别（从 1 起；非比赛模式恒为 1） */
  Game.prototype.currentLevel = function () {
    if (!this.match || !this.match.enabled) return 1;
    return this.match.roundNo || 1;
  };

  /** 该座位现在还能不能重入（级别未过截止线 + 重入次数未用完 + 赛制允许） */
  Game.prototype.canReenter = function (seatIndex) {
    var m = this.match, s = this.seats[seatIndex];
    if (!m || !m.enabled || !s) return false;
    if (!m.allowReentry) return false;
    if (this.currentLevel() > (m.reentryUntilLevel || 0)) return false;
    if ((m.reentryCount[seatIndex] || 0) >= (m.reentryMax || 0)) return false;
    return true;
  };

  /** 执行重入：筹码重置为起始筹码，重入次数 +1（本轮积分不变） */
  Game.prototype.reenter = function (seatIndex) {
    var m = this.match, s = this.seats[seatIndex];
    if (!this.canReenter(seatIndex)) return false;
    s.chips = m.startStack || this.initialChips;
    s.sittingOut = false;
    s.folded = false;
    s.eliminated = false;
    s.bet = 0;
    s.committed = 0;
    m.reentryCount[seatIndex] = (m.reentryCount[seatIndex] || 0) + 1;
    if (m.pendingReentry) delete m.pendingReentry[seatIndex];
    this.emit('reenter', {
      seat: seatIndex, name: s.name, level: this.currentLevel(),
      count: m.reentryCount[seatIndex], chips: s.chips
    });
    // AI 重入也冒一句，让牌桌对话更鲜活
    if (!s.isHuman && typeof this.emit === 'function') {
      this.emit('tableTalk', {
        seatIndex: seatIndex, name: s.name,
        text: '筹码归零又如何？满血复活，再来！', kind: 'reentry'
      });
    }
    this.refreshBubble();
    return true;
  };

  /** 放弃重入（或超期未确认）→ 走正常淘汰 */
  Game.prototype.declineReentry = function (seatIndex) {
    var m = this.match;
    if (!m || !m.enabled) return false;
    if (!m.pendingReentry || !m.pendingReentry[seatIndex]) return false;
    delete m.pendingReentry[seatIndex];
    return this.eliminateSeat(seatIndex);
  };

  /** 刷新泡沫期：存活人数 == 进圈人数 + 1 */
  Game.prototype.refreshBubble = function () {
    var m = this.match;
    if (!m || !m.enabled) return false;
    var inMoney = m.inMoney || 0;
    m.isBubble = (inMoney > 0 && this.aliveCount() === inMoney + 1);
    return m.isBubble;
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
      if (m.eliminated[i] || s.chips > 0) continue;
      // 重入：AI 自动重入；人类交给 UI 的「重入」按钮确认（逾期未确认 → 下一手开局前判淘汰）
      if (this.canReenter(i)) {
        if (s.isHuman) {
          s.sittingOut = true;
          s.folded = true;
          m.pendingReentry[i] = true;
          this.emit('reentryOffer', { seat: i, name: s.name, level: this.currentLevel() });
          continue;
        }
        this.reenter(i);
        continue;
      }
      this.eliminateSeat(i);
    }
    this.refreshBubble();
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
    // 名次积分：由赛制结构的 awardRule 按进圈人数截断生成（fast 3 人 → [5,3,1]）
    var award = [5, 3, 1];
    if (Structures && Structures.awardFor && m && m.structureId) {
      var aw = Structures.awardFor(Structures.get(m.structureId), this.seats.length);
      if (aw && aw.length) award = aw;
    }
    for (var k = 0; k < arr.length; k++) {
      arr[k].rank = k + 1;
      if (!arr[k].eliminated && k < award.length) arr[k].roundPts = award[k];
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
      roundNo: m.roundNo, sb: this.smallBlind, bb: this.bigBlind, ante: this.ante || 0,
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
    this.ante = lv.ante || 0;
    for (var i = 0; i < this.seats.length; i++) m.roundStartChips[i] = this.seats[i].chips;
    this.refreshBubble();
    this.emit('roundStart', { roundNo: m.roundNo, sb: this.smallBlind, bb: this.bigBlind, ante: this.ante });
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
        Relations.update(s, wseat, relDelta * w);

        // 被偷的一方：当场发火（影响后续打法）
        if (bluffed && !iWon) {
          s.mood = Math.max(-100, Math.round((s.mood || 0) - 16 * (0.4 + vol)));
          s.moodLabel = Mood.label(s.mood);
          s.moodEvent = '被' + wseat.name + '偷了一把，记下了';
          this.emit('mood', { seat: s.index, name: s.name, mood: s.mood, label: s.moodLabel, event: s.moodEvent });
        }
        // 偷成功的赢家：觉得对方好欺负
        if (bluffed && wseat.personality) {
          var wv = wseat.personality.moodVolatility || 0.3;
          Relations.update(wseat, s, 13 * (0.5 + wv * 0.7));
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

  // ============ 给 Brain 的上下文 ============
  Game.prototype.buildCtx = function (seatIndex) {
    var s = this.seats[seatIndex];
    var posF = this.positionFactor(s);
    var agg = this.aggressorIndex >= 0 ? this.seats[this.aggressorIndex] : null;
    // B1：仍存活（未弃牌/未坐出/未淘汰）对手的客观历史快照（Boss 读牌用）
    var opponents = [];
    var i2;
    for (i2 = 0; i2 < this.seats.length; i2++) {
      var os = this.seats[i2];
      if (i2 === seatIndex || os.folded || os.sittingOut) continue;
      var ost = os.stats;
      opponents.push({
        id: os.id, name: os.name,
        hands: ost.hands || 0,
        vpip: ost.hands ? (ost.vpip || 0) / ost.hands : 0,
        pfr: ost.hands ? (ost.pfr || 0) / ost.hands : 0,
        threeBet: ost.threeBet || 0,
        steal: ost.steal || 0,
        cBetFaced: ost.cBetFaced || 0,
        foldToCBet: ost.foldToCBet || 0,
        showdowns: ost.showdowns || 0
      });
    }
    // B2 ICM 上下文：比赛 + 奖金结构 + 至少 2 名存活者才提供。
    // 只传「仍在争夺名次」的存活座位筹码（已淘汰/0 筹码出局者不参与未来名次），
    // payouts 截到存活人数（缺失名次奖金在 icm.js 内部按 0 处理），meIndex 为座次在存活列表中的位置。
    var m = this.match;
    var icmCtx = null;
    if (m && m.enabled && m.payouts && this.aliveCount() >= 2) {
      var liveIdx = [];
      var stacks = [];
      var i2b;
      for (i2b = 0; i2b < this.seats.length; i2b++) {
        if (m.eliminated[i2b] || this.seats[i2b].sittingOut) continue;
        liveIdx.push(i2b);
        stacks.push(this.seats[i2b].chips);
      }
      var mePos = liveIdx.indexOf(seatIndex);
      icmCtx = {
        payouts: m.payouts.slice(0, stacks.length),
        stacks: stacks,
        meIndex: Math.max(0, mePos),
        bubble: !!m.isBubble,        // 泡沫期：存活 == 进圈+1，ICM 压力自然放大
        inMoney: m.inMoney || 0
      };
    }
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
        aggressorStats: agg ? (function (os2) {
          var ost2 = os2.stats;
          return { id: os2.id, hands: ost2.hands || 0, vpip: ost2.hands ? (ost2.vpip || 0) / ost2.hands : 0, cBetFaced: ost2.cBetFaced || 0, foldToCBet: ost2.foldToCBet || 0 };
        })(agg) : null,
        opponents: opponents,
        icm: icmCtx,
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
    var r = Brain.decide(this.buildCtx(seatIndex));
    // 牌桌对话：把带「人格味道」的 AI 决策（记仇/诈唬/偷盲/上头）广播到对话面板
    if (r && r.talk && typeof this.emit === 'function') {
      var seat = this.seats[seatIndex];
      this.emit('tableTalk', {
        seatIndex: seatIndex,
        name: seat ? seat.name : '',
        text: r.reason || '',
        kind: r.talk
      });
    }
    return r;
  };

  Game.STREETS = STREETS;
  Game.STREET_CN = STREET_CN;
  Game.relationWord = relationWord;

  Poker.Game = Game;
  if (typeof module !== 'undefined' && module.exports) module.exports = Game;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
