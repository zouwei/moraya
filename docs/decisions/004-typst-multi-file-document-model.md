# 004 — Typst 多文件文档模型

> 状态：**已定稿**（2026-07-29）
>
> 背景：Typst 模板需求评估（P1/P2 的前置决策）。相关：[v1.28.0-pc-typst-outline.md](../iterations/v1.28.0-pc-typst-outline.md) §5、[v1.29.0-web-typst-packages.md](../iterations/v1.29.0-web-typst-packages.md)

## 1. 问题

Moraya 的文档模型是**单文件**：一个文档 = 一份内容 = 一个可编辑标签页。

Typst 的项目模型是**多文件**。`typst init @preview/charged-ieee` 产出的不是一个文件：

```
charged-ieee/
├── main.typ      ← 文档
└── refs.bib      ← 参考文献，被 bibliography("refs.bib") 引用
```

更复杂的模板还会带 logo 图片、字体、`chapter.typ` 分章。749 个官方模板包里，只有约六成是纯单文件。

**不解决这个模型问题，模板功能就只能做六成。**

## 2. 现状盘点（已核实，非推断）

### 2.1 PC —— 其实已经支持了

| 事实 | 依据 |
|---|---|
| KB 就是磁盘目录，文档就是文件 | — |
| 目录遍历**已按扩展名过滤**：只显示 `.md/.markdown/.mdown/.mkd/.typ` 与目录 | `file.rs:518` `show_all \|\| is_dir \|\| is_document_file()` |
| 同目录的 `refs.bib` 因此**不会污染文件树**，但确实躺在磁盘上 | 同上 |
| Typst 以文档目录为 `--root` 编译，兄弟文件可解析 | v1.28.0 §5，已端到端验证 |

**结论：PC 缺的只是"创建"这一步**（没有 `typst init` 等价物），读写与渲染都已通。

### 2.2 Web / App —— 存储够用，产品层缺概念

| 事实 | 依据 | 影响 |
|---|---|---|
| 存储是对象形态 `putObject(key, body)`，key 即路径 | `storage/adapter.ts` | ✅ 目录是隐式的，任意 key 都能存 |
| 本地 KB（IndexedDB）支持 `Uint8Array \| Blob` | `local-storage-adapter.ts` | ✅ 二进制可存 |
| **Picora 云 KB 是纯文本的** —— `bodyToText()` 一律 `TextDecoder` 解码后按 `content` 提交 | `picora-adapter.ts:49` | ❌ **二进制会被破坏** |
| KB 列举**没有扩展名过滤**，除点号开头的路径段外全部显示 | `kb-browse.ts:424` | ❌ `refs.bib` 会当成文档出现在侧栏 |
| 已有隐藏约定：点号开头的路径段（`.ai-conversations`） | 同上 | 可复用的机制 |
| typst.ts 需要每个辅助文件经 `addSource`（文本）/ `mapShadow`（二进制）注入 | 已验证：`addSource('/refs.bib', …)` 后官方模板编译出 4 页 | 需要在编译前喂给编译器 |

## 3. 被否决的方案

### 3.1 隐藏附件目录（`.assets/<doc>/refs.bib`）

复用现成的点号隐藏约定，侧栏零改动。**但会破坏与 Typst 生态的兼容**：

模板脚手架里写的是 `bibliography("refs.bib")` —— 相对当前文件。挪进 `.assets/` 就必须重写成 `bibliography(".assets/main/refs.bib")`，于是：

- 用户从 Universe 拷来的代码片段贴进 Moraya 不能用
- Moraya 导出的 `.typ` 拿到别处（typst CLI、typst.app）也不能用
- 往返转换必须双向改写路径，任何遗漏都是静默失效

**Typst 的项目约定就是"文件放在文档旁边"**。任何搬走它们的模型都要付出与整个生态失配的代价，不值得。

### 3.2 打包成单文件（把辅助内容内联进 `.typ`）

`.bib` 可以内联（Typst 支持 `bibliography(bytes(...))`），但图片、字体不行；且内联后用户无法再用外部工具编辑参考文献。放弃。

## 4. 采用的模型：**兄弟文件（Sibling Files）**

> 一个 Typst 文档 = 一个 `.typ` 文件 + 与它**同目录**的若干辅助文件。目录本身不是实体，"项目"不是新的一等概念。

理由：这与 PC 的磁盘现实、Typst 的项目约定、以及 web 存储的 key 前缀语义**三者天然一致**，不需要任何一方做映射。

### 4.1 三端落地

| 端 | 存储 | 渲染时如何喂给编译器 |
|---|---|---|
| PC | 磁盘同目录（已有） | `--root <文档目录>`，编译器自己读盘（已有）|
| Web / App | KB 中同 key 前缀的对象 | 编译前列举同前缀对象，逐个 `addSource` / `mapShadow` |

### 4.2 需要补的三处

**① Web KB 列举加扩展名过滤**（补齐三端不一致）

PC 早就只显示文档与目录；web 显示一切。补上同一套判定（复用 `@moraya/core/typst` 的 `isDocumentFile`），辅助文件即从侧栏消失、但仍在存储里。

这条**独立于模板需求**也该做 —— 今天用户往 KB 里放任何非文档文件，侧栏就已经会把它显示成一个打不开的"文档"。

**② 编译前注入兄弟文件（Web/App）**

`wasmTypstCompiler.compile()` 目前只 `addSource(MAIN_FILE, source)`。需要在其之前列举同前缀对象并注入。与 v1.29.0 的包预热是同一个位置、同一种模式（编译前把编译器同步需要的东西准备好）。

**③ 原子的"多文件新建"**

从模板创建 = 写入 `main.typ` + N 个兄弟文件 + 打开前者。需要一个不会中途失败留下半个项目的操作。

## 5. 硬约束：Picora 云 KB 不支持二进制

这是本设计唯一无法在本仓解决的问题。

| 辅助文件类型 | 本地 KB | Picora 云 KB |
|---|---|---|
| 文本（`.bib` `.typ` `.csv` `.yaml` `.json`）| ✅ | ✅ |
| 二进制（`.png` `.jpg` `.otf` `.ttf`）| ✅ | ❌ 会被 `TextDecoder` 破坏 |

**影响面**：带图片/字体的模板在云 KB 下不可用。按 Universe 的构成，受影响的主要是 presentation / layout 类中带 logo 的那部分。

三个选项：

| 选项 | 代价 | 结果 |
|---|---|---|
| **A. 云 KB 只支持文本辅助文件** | 无 | 二进制模板在云 KB 下拒绝创建并说明原因；本地 KB 不受限 |
| **B. Base64 内联进文本** | 体积 +33%、与外部工具失配、Picora 侧看到的是乱码文档 | 能用但脏 |
| **C. 推动 Picora 支持二进制** | 跨仓迭代，需要 Picora 侧排期 | 干净且一劳永逸 |

倾向 **A 先行 + C 排期**：A 零成本且诚实（明确告诉用户为什么不行），C 是正解但不该阻塞 P1。

## 6. 决策（已拍板 2026-07-29）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 文档模型 | **采用兄弟文件模型**（§4）|
| 2 | Picora 二进制 | **走 C —— Picora 是自有项目，定制支持二进制**。Moraya 侧按「支持二进制」实现，Picora 侧未上线前文本辅助文件即可用，二进制自动降级并告知用户（即 A 的行为作为过渡态）|
| 3 | P1 边界 | **单文件 + 文本辅助文件**（覆盖约八成模板）|

Picora 侧所需改动另见 [`docs/specs/picora-binary-attachments.md`](../specs/picora-binary-attachments.md)。

## 7. 定稿后的实施顺序

1. Web KB 扩展名过滤（独立缺陷，可先行）
2. Web/App 编译前注入兄弟文件
3. 原子多文件新建 + 模板选择器（P1）
4. 完整模板浏览器 + 缩略图（P2）
