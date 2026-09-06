# 贡献指南 & 调参说明

感谢你想把这个项目改得更好。这是个**零依赖、零构建**的项目——没有 npm install，没有打包器，改完刷新浏览器就能看到效果。

## 本地跑起来

```bash
# 方式一：任意静态服务器（推荐）
python -m http.server 8790
# 然后打开 http://localhost:8790

# 方式二：直接双击 index.html（file:// 也能跑，因为所有 js 都是普通 script，没有 ES module）
```

跑引擎测试（Node 环境，不需要浏览器）：

```bash
node tests/sim.js
```

它会验证：11 项手牌评估正确性、筹码守恒、6 个人格的打法差异（VPIP / 诈唬频率 / 偷盲统计）、情绪与关系系统。

## 代码约定

- **不要引入 ES module**（`import` / `export`）。所有文件都是普通 `<script>`，靠全局对象 `window.Poker` 串联，这样 `file://` 直接打开也能玩。
- 每个 js 文件末尾挂 UMD 尾巴，保证 Node 下 `require()` 能跑测试。
- 新增模块请在 `index.html` 里按依赖顺序加 `<script>`：
  `cards → handEval → equity → ai/personalities → ai/brain → game → coach → review → ui → main`

## 怎么调 AI（最有趣的部分）

所有 AI 的性格都在 **`js/ai/personalities.js`** 里，是一张纯数据表。改数字就能造出全新的对手，不需要动决策逻辑。

| 字段 | 含义 | 调大之后会怎样 |
|------|------|---------------|
| `vpip` | 入池率 0..1 | 越大越松，什么牌都玩 |
| `pfr` | 翻前加注率 0..1 | 越大越爱主动开火 |
| `aggression` | 激进度 0..2 | 越大越倾向下注/加注而不是跟注 |
| `bluffFreq` | 诈唬频率 0..1 | 越大越爱偷鸡 |
| `callThreshold` | 跟注门槛系数 | 越大越爱跟（跟注站） |
| `foldToAggression` | 面对加注的弃牌倾向 0..1 | 越大越容易被打跑 |
| `tricky` | 慢打/设陷阱倾向 0..1 | 越大越会埋伏大牌 |
| `tiltFactor` | 连败后变松倾向 0..1 | 越大越容易上头乱打 |
| `stealFreq` | 偷盲频率 0..1 | 后位无人入池时的偷盲倾向 |
| `restealFreq` | 反偷频率 0..1 | 面对疑似偷盲时的 3-bet 反击倾向 |
| `bluffCatchFreq` | 抓诈唬倾向 0..1 | 面对大注敢跟的程度 |
| `moodVolatility` | 情绪波动 0..1 | 越大越容易被输赢影响心态 |
| `preflopTop` | 只玩前 X% 起手牌 | 调小 = 超紧（如 `0.20`） |
| `betSizing` | `{value, bluff, polarize}` | 下注尺度与是否极化 |
| `callStation` | 跟注站倾向 0..1 | 中等牌力就不弃牌 |
| `cbetFreq` / `threeBetFreq` | 持续下注 / 3-bet 频率 | 压迫感来源 |
| `noise` | 决策噪声 0..1 | 越大越不像机器（会犯错） |
| `adaptivity` | 玩家建模强度 0..1 | 越大越会针对你的习惯调整 |
| `positionAware` | 位置意识 0..1 | 越大越懂位置优势 |

### 造一个新对手

复制 `personalities.js` 里任意一个对象，改 `id` / `name` / `avatar` 和几个数值即可，UI 会自动出现在选桌界面（最多同时选 5 位）。

想让 AI 说自己的话，改 `moodLines`（不同心境下的思考气泡台词）。

### 改决策逻辑

- 单项决策（跟 / 弃 / 加多少）：`js/ai/brain.js` 的 `decideCore()`
- 情绪与关系如何调制决策：同一个文件的 `decide()` 包装层
- 牌局流程（边池、全下、摊牌）：`js/game.js`
- 教学建议 / 复盘点评：`js/coach.js`、`js/review.js`

改完建议跑一遍 `node tests/sim.js`，确认筹码守恒没被破坏。

## 提交 PR

1. Fork 本仓库，开分支
2. 改动请保持「零依赖、零构建」原则
3. 跑通 `node tests/sim.js`
4. 提 PR，简单说明改了什么、为什么

欢迎的方向：新 AI 人格、更好的教学点评规则、复盘可视化、移动端适配、翻译。

## 许可

本项目 MIT 许可，你的贡献默认同样以 MIT 发布。
