/* global window, global */
/**
 * cards.js —— 牌组定义、洗牌、发牌、牌面格式化。
 * 零依赖。浏览器挂 window.Poker.Cards，Node 下 module.exports = Poker.Cards。
 */
(function (root) {
  'use strict';

  var Poker = root.Poker || (root.Poker = {});

  // 花色：0=黑桃♠ 1=红桃♥ 2=方块♦ 3=梅花♣
  var SUITS = [0, 1, 2, 3];
  var SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663']; // ♠ ♥ ♦ ♣
  var SUIT_NAMES = ['黑桃', '红桃', '方块', '梅花'];
  var RANK_NAMES = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
    9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
  };

  /** 创建一张牌对象。r: 2..14（14=A），s: 0..3 */
  function makeCard(r, s) {
    return { r: r, s: s };
  }

  /** 由 0..51 整数编码解出牌对象：index = (r-2)*4 + s */
  function fromIndex(idx) {
    return { r: Math.floor(idx / 4) + 2, s: idx % 4 };
  }

  /** 牌对象 -> 0..51 整数编码 */
  function toIndex(card) {
    return (card.r - 2) * 4 + card.s;
  }

  /** 生成一副 52 张标准牌 */
  function buildDeck() {
    var deck = [];
    for (var r = 2; r <= 14; r++) {
      for (var i = 0; i < 4; i++) {
        deck.push(makeCard(r, SUITS[i]));
      }
    }
    return deck;
  }

  /**
   * Fisher-Yates 洗牌（原地）。
   * @param {Array} deck 牌数组
   * @param {Function=} rng 随机数生成器，默认 Math.random
   * @return {Array} 同一数组引用
   */
  function shuffle(deck, rng) {
    var rand = rng || Math.random;
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    return deck;
  }

  /** 牌的可读文本，如 "A♠" */
  function cardText(card) {
    if (!card) return '--';
    return RANK_NAMES[card.r] + SUIT_SYMBOLS[card.s];
  }

  /** 牌的完整中文名，如 "黑桃A" */
  function cardName(card) {
    if (!card) return '';
    return SUIT_NAMES[card.s] + RANK_NAMES[card.r];
  }

  /** 一组牌的文本，如 "A♠ K♥" */
  function cardsText(cards) {
    if (!cards || !cards.length) return '';
    var out = [];
    for (var i = 0; i < cards.length; i++) out.push(cardText(cards[i]));
    return out.join(' ');
  }

  /** 判断是否为红色花色（用于 UI 上色） */
  function isRed(card) {
    return card.s === 1 || card.s === 2;
  }

  // 花色 UI 类名：四花色各一种颜色（♠黑 ♥红 ♦蓝 ♣绿），小牌也容易分辨
  var SUIT_CLS = ['spade', 'heart', 'diamond', 'club'];

  /** 返回花色对应的 CSS 类名（spade/heart/diamond/club） */
  function suitClass(card) {
    return card && card.s >= 0 && card.s <= 3 ? SUIT_CLS[card.s] : 'spade';
  }

  var Cards = {
    SUITS: SUITS,
    SUIT_SYMBOLS: SUIT_SYMBOLS,
    SUIT_NAMES: SUIT_NAMES,
    RANK_NAMES: RANK_NAMES,
    makeCard: makeCard,
    fromIndex: fromIndex,
    toIndex: toIndex,
    buildDeck: buildDeck,
    shuffle: shuffle,
    cardText: cardText,
    cardName: cardName,
    cardsText: cardsText,
    isRed: isRed,
    SUIT_CLS: SUIT_CLS,
    suitClass: suitClass
  };

  Poker.Cards = Cards;
  if (typeof module !== 'undefined' && module.exports) module.exports = Cards;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
