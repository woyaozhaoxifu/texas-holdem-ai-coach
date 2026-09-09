/* hu_scene_probe: 3 人桌逐手现场 —— 看清"太紧"是拿强牌弃(疑似bug)还是拿垃圾弃(正常) */
'use strict';
var path = require('path');
var D = path.join(__dirname, '..');
require(path.join(D, 'js/cards.js'));
require(path.join(D, 'js/handEval.js'));
require(path.join(D, 'js/equity.js'));
require(path.join(D, 'js/icm.js'));
require(path.join(D, 'js/ai/personalities.js'));
require(path.join(D, 'js/ai/brain.js'));
var Game = require(path.join(D, 'js/game.js'));
var P = global.Poker.Personalities;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

var ids = ['tag', 'rock', 'boss'];
var BB = 200;
var seats = ids.map(function(id){var p=P.get(id);return{id:id,name:p.name,avatar:p.avatar,isHuman:false,personality:p,chips:4000};});
var g = new Game({ seats: seats, smallBlind: 100, bigBlind: BB, playerIndex: 0, initialChips: 4000, rng: mulberry32(2024) });

function playHand(g) {
  if (g.startHand() === false) return false;
  var guard = 0;
  while (!g.isHandOver && guard++ < 400) {
    if (g.currentActor < 0) { g.isHandOver = true; break; }
    var d = g.aiDecide(g.currentActor);
    g.act(g.currentActor, d.action, d.raiseTo || 0, d.reason || '');
  }
  if (guard >= 400) throw new Error('死循环');
  return true;
}

var totalEnter = 0, totalDealt = 0;
for (var h = 1; h <= 16; h++) {
  playHand(g);
  var folds = {};
  var acts = [];
  (g.handLog || []).forEach(function (l) {
    if (l.street !== 'preflop') return;
    acts.push(l.actorId + ':' + l.action + (l.raiseTo ? '(' + l.raiseTo + ')' : ''));
    if (l.action === 'fold') folds[l.seatIndex] = l.hole;
  });
  var alive = g.seats.filter(function(s){return s.chips>0;});
  var foldTxt = [];
  alive.forEach(function(s){
    if (folds[s.index]) foldTxt.push(s.id + '弃[' + global.Poker.Cards.cardsText(folds[s.index]) + ']');
    else foldTxt.push(s.id + '入池');
  });
  var entered = alive.length - Object.keys(folds).length;
  totalEnter += entered; totalDealt += alive.length;
  console.log('#' + h + ' bb=' + BB + ' 入池' + entered + '/' + alive.length + ' | ' + acts.join(' ') + ' | ' + foldTxt.join(' '));
  g.drainEvents();
}
console.log('avg 入池 = ' + (totalEnter / 16).toFixed(2) + '  | avg 翻前弃牌率 = ' + (1 - totalEnter / totalDealt).toFixed(2));
