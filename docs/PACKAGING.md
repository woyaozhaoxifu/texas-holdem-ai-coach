# 打包运行指南（桌面壳 / 手机 / 小程序）

本游戏是 **零依赖纯前端**（HTML+CSS+JS，无 npm 无构建），引擎全部挂在 `window.Poker` 的 UMD 模块上、可在 Node 直接跑。因此"打包"的本质是**换一个壳来加载同一个 `index.html`**。

## 1. 桌面小应用（pywebview + 本机 Python 3.13）

思路：用 pywebview 起一个原生窗口，直接加载项目里的 `index.html`。参照同机其它本地小工具的 venv 做法：

```bat
@echo off
REM start-desktop.bat —— 桌面壳（首次运行会自动装 pywebview）
cd /d %~dp0
if not exist .venv (
  py -3.13 -m venv .venv
)
call .venv\Scripts\activate
python -m pip install --quiet pywebview
python -m app_desktop
```

配套 `app_desktop.py`（约 15 行，放项目根目录即可）：

```python
import webview, os
webview.create_window("德州扑克 AI 对战",
                      os.path.abspath("index.html"),
                      width=1180, height=860)
webview.start()
```

要点：文件全在本地、无服务器、无跨域请求；`file://` 直开即可跑（游戏本身就是这么设计的）。若个别系统 `file://` 受限，可加一个零依赖 http.server 兜底（见第 2 节）。

## 2. 手机/平板同 WiFi 访问（纯 H5）

起一个零依赖静态服务器，手机浏览器访问同一局域网 IP 即可：

```bat
@echo off
cd /d %~dp0
py -3 -m http.server 8080 --bind 0.0.0.0
echo 同一 WiFi 下手机访问 http://<本机IP>:8080
```

要点：点击类/触摸类交互都已按 DOM 原生实现，移动端浏览器可直接玩；窗口宽度窄时界面会收缩（顶栏/操作区为响应式布局）。若要手感更好，后续可加 `@media` 触控优化与 viewport 微调。

## 3. 微信小程序 / 其它平台注意点

- **引擎可移植**：`js/cards.js` `handEval.js` `equity.js` `icm.js` `game.js` `ai/*` 是纯 UMD、无 DOM 依赖，理论上可直接搬到小程序逻辑层或 Worker。
- **UI 不可直接搬**：`js/ui.js`/`index.html` 是浏览器 DOM 版。进小程序两条路：
  1. 套 `web-view` 组件加载已部署的 H5（最快，但需域名备案与业务域名白名单）；
  2. 重写 view 层为小程序 WXML（引擎层基本不动，工作量集中在牌桌渲染与事件转发）。
- 小程序要求所有请求走合法域名；纯本地单机玩法可打包成"不用网络的单机版"避开该限制。

## 4. 零第三方运行时依赖说明

- 运行期 **0 个第三方库**：所有逻辑是手写 UMD JS，没有 CDN、没有 npm 包。
- 桌面壳的 `pywebview` 与 Python 只是"壳"，不进入游戏逻辑；游戏本身仍可完全脱离它运行（双击 `index.html`）。
- 自动化测试全部 `node` 直接跑（`node tests/sim.js`），无需安装任何依赖。
