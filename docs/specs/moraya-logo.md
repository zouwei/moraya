# 功能规格：Moraya 品牌 LOGO（2026-07 重设计）

> 类型：品牌视觉规格（已定稿、已落地）
> 平台：moraya（PC/Tauri）、moraya-web（PWA）、moraya-mobile（iOS/iPad/Android）、moraya-site（官网）
> 状态：2026-07-31 定稿（4 概念比选 → C1「墨痕」方案（用户选定，去墨点）→ 全端资产落地完成）

## 1. 背景与品牌要求

旧主标为近黑深蓝底（`#0a0e1a`）+ 5 层 feGaussianBlur 发光丝带 M：

- 深色底在浅色环境（浅色 Dock/桌面/官网导航）中突兀 —— 本次重设计的直接动因
- 与 iOS/Android 的另一套浅色几何 M 图标互相割裂（一个产品两副面孔）
- blur 滤镜在 16px 下必糊；且圆角烘焙进资产，与 PWA maskable / Android adaptive 的平台裁切互相冲突

新标要求：告别深底、纯矢量零滤镜（`<filter>`/`<text>`/CSS 均禁用，兼容 resvg 与 librsvg 双渲染管线）、16px 实测可读、一套主标统一全端、圆角一律不烘焙（由各平台蒙版/派生层提供）。

## 2. 设计定稿：概念 C1「墨痕 M」（Ink Stroke）

宽笔尖书法的单笔 M：**细笔上行、重笔下按**——两条粗下行笔画与细骨架线叠加（共享同一
userSpace 渐变，圆头端帽无缝融合），暖纸白底。墨（ink）与雅（elegance）两个词源直接落形；
暖纸白底向官网 `--color-cream #f0efe8`（历史 logo 前景色）致意。

> 用户定稿修改：去掉原概念稿右下角的墨点（mora「片刻」句读），保留纯 M。

### 比选记录（2026-07-31，4 概念，预览页 Artifact 存档）

| 概念 | 结论 |
|---|---|
| **C1 墨痕 M** | **定稿（去墨点）**。墨雅词源落形最完整，文人气最重 |
| C2 丝带 M 2.0 晨光 | 备选。延续性最强，但叙事较弱、粗边圆拱有快餐联想风险 |
| C3 双语纽带 | 淘汰。双色在极小尺寸/单色场景需额外规则 |
| C4 墨印 | 淘汰。家族体系最强但底色仍为四案最深 |

### 视觉规范

- **几何**（512 viewBox，master 坐标）：
  - 细骨架（全 M，stroke 26）：`M 100 404 C 116 300 144 180 168 118 C 192 190 224 292 244 338 C 264 282 296 180 328 118 C 352 190 382 310 396 400`
  - 粗下行笔画 ×2（stroke 58）：`M 168 118 C 192 190 224 292 244 338` 与 `M 328 118 C 352 190 382 310 396 400`
  - 全部 `stroke-linecap="round"`；内容包围盒 (87,89)–(425,429)，光学居中于 x=256
- **色板**：
  - 纸白底：`#fcfbf7 → #f2efe4`（对角渐变）
  - 墨渐变（icon/master）：`#1b3350 → #1E3A5F(40%) → #2d7dd2`，方向 (112,100)→(412,410)
  - glyph 提亮渐变（透明版，浅深底通用）：`#2b5a8c → #2d7dd2(50%) → #4a9eff`
  - small 单色：`#2d7dd2`
- **四变体制度**：
  - **master** —— 全出血方形带底，≥48px 应用图标（各平台自行加蒙版）
  - **glyph** —— 透明纯标记，应用内 UI / 官网页眉 / 启动屏
  - **small** —— 16–32px 直线化简化版（favicon 16/32、ico 小帧），骨架 44 / 粗笔 80
  - **maskable** —— 全出血底 + 标记 ×0.78 内缩，全部内容进 80% 安全圆（实测 maxR 178 < 204.8）

## 3. 资产清单与接入点（四仓库）

### moraya（PC/Tauri）

| 资产 | 说明 |
|---|---|
| `src-tauri/icons/moraya-logo-master.svg` | 唯一生成源（master） |
| `src-tauri/icons/moraya-logo-small.svg` | small 变体 |
| `src-tauri/icons/moraya-logo.svg` | glyph |
| `src-tauri/icons/icon.{png,icns,ico}` + Tauri/Square PNGs | 全部由脚本生成 |
| `static/favicon.png` | glyph 128px 透明版 |

- **macOS icns**：脚本内将 master 包进 1024 画布的 824×824 圆角矩形（rx 185）+ 透明边距（Big Sur 规格，修复旧版 Dock 偏大 ~24%）；≤32px 帧改用 small 的 M
- **Windows ico**：16/24/32 帧来自 small（透明），48+ 来自 master
- 旧 `moraya-logo-concept.svg` / `moraya-logo-square.svg` 已删除

### moraya-web（PWA）

| 资产 | 说明 |
|---|---|
| `static/favicon.svg` | small（透明，浅深标签页通吃） |
| `static/moraya-logo.svg` | glyph（登录页 48px 引用） |
| `static/icons/icon-{192,512}.png` | master，manifest `purpose:"any"` |
| `static/icons/icon-maskable-{192,512}.png` | maskable 变体，`purpose:"maskable"`（修复旧 `any maskable` 合并声明 bug） |
| `static/apple-touch-icon.png` | master 180px，`app.html` 已加 `<link rel="apple-touch-icon">`（旧版缺失） |

### moraya-mobile（Capacitor）

| 资产 | 说明 |
|---|---|
| `resources/icon-master.svg` | 1024 版 master（坐标 ×2） |
| `resources/icon-adaptive-{fg,bg}.svg` | Android 自适应分层：fg = glyph ×0.13 进 30dp 安全半径；bg = 纸白渐变 |
| `resources/splash-master.svg` | 白底 + glyph ×1.5 + "Moraya" 字标（已去旧 softShadow 滤镜） |
| iOS appiconset 18 变体 / Android mipmap 22 文件 / splash ×3 | 全部已重生 |

注意：`moraya-mobile/web/` 是 moraya-web 构建产物的打包拷贝，将在下次
`pnpm build`（moraya-web）→ `pnpm sync` 时自动带入新资产，无需手改。

### moraya-site（官网）

| 资产 | 说明 |
|---|---|
| `public/logo.svg` | glyph；`Header.astro` / `Footer.astro` 已由 favicon.png 改指此文件 |
| `public/favicon.svg` + `public/favicon.png` | small SVG + glyph 128 PNG（`BaseLayout.astro` 双 link） |
| `public/apple-touch-icon.png` | master 180px（新增 link） |
| `public/og-image.{svg,png}` | 重制：纸白底 + glyph + Moraya/墨雅/tagline/motto（svg 含 `<text>`，只能浏览器栅格化，勿进 resvg） |
| `src/components/Icons.astro` `#icon-logo` | 内联 symbol 已替换为新 glyph（旧霓虹 defs/filters 全部移除） |
| `src/utils/schema.ts` | JSON-LD logo 仍指 `/favicon.png`（内容已更新，无需改代码） |

## 4. 再生成方法

```bash
# PC（也是唯一改 SVG 源后必跑的）：
cd moraya && node scripts/generate-icons.mjs
#   （pngquant/oxipng 可选：brew install pngquant oxipng，仅影响体积）

# 移动端：
cd moraya-mobile
node scripts/gen-icons.mjs && node scripts/gen-android-icons.mjs && node scripts/gen-splash.mjs

# web / site 的 PNG 为一次性生成（resvg 渲染 master/maskable/glyph 到对应尺寸）；
# og-image.png 用无头 Chrome 截 og-image.svg（1200×630）。
```

规则：**不要手改任何生成出的 PNG/ICNS/ICO**；改设计 = 改 SVG 源 + 重跑脚本。

## 5. 验证清单（已执行）

- [x] resvg 渲染 512/180/64/48/32/16 全部无报错；librsvg（sharp）渲染 iOS/Android/splash 正确（渐变 + transform + text 均核验）
- [x] 16px small 实测可读（M 剪影可辨、笔画间隙 ≥1px）
- [x] maskable 几何校验：内容 maxR 178 < 204.8（80% 安全圆）；adaptive fg 进 30dp 半径
- [x] macOS icns 抽帧目检：824/1024 圆角 + 透明边距正确
- [x] 全仓库 grep 无 `moraya-logo-concept` / `ribbonGrad` / `#0a0e1a` 残留引用
- [ ] 下次 moraya-web `pnpm build` 后，mobile `pnpm sync` 带入新 web 资产（随日常构建完成）

## 6. 后续可选项（未做，需单独决策）

- **品牌蓝 token 统一**：PC/官网 UI accent `#4a90d9` vs Web/移动 `#4a9eff` 仍并存；若统一为
  `#4a9eff` 需动三端 `variables.css` / `themes.ts`，影响整体 UI 观感，建议单独迭代
- iOS 18 dark/tinted 图标变体、Android 13+ monochrome themed icon
- `manifest.json` `theme_color #1a1a1a` 是否随浅色品牌调整（属 PWA UI 决策，非 logo 范畴）
