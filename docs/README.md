# Moraya 文档中心

## 迭代需求

| 版本 | 阶段 | 状态 | 文档 |
|------|------|------|------|
| v0.1.0 | Phase 1 — 核心编辑器 | 已完成 | WYSIWYG Markdown 编辑、数学公式、文件操作、侧栏、设置、导出、主题 |
| v0.1.1 | Phase 2 — AI 集成 | 已完成 | 多 Provider LLM API、流式输出、AI 聊天面板、AI 指令 |
| v0.1.2 | Phase 3 — MCP 生态 | 已完成 | MCP 客户端（stdio/SSE/HTTP 三种传输）、服务管理 |
| v0.1.3 | Phase 4 — 编辑器增强 | 已完成 | 源码/可视/分屏模式、表格工具栏、原生菜单、国际化、滚动同步 |
| v0.2.0 | Phase 5 — 创作发布工作流 | 规划中 | [详细需求](iterations/v0.2.0-publish-workflow.md) |

## 目录结构

```
docs/
├── README.md              ← 本文件（文档索引）
├── iterations/            ← 增量需求迭代（每次需求独立一个文档）
├── specs/                 ← 功能规格书（按功能拆分）
├── changelog/             ← 版本变更记录
└── decisions/             ← 架构决策记录 (ADR)
```

## 文档规范

- **增量迭代文档**: `iterations/v{版本号}-{描述}.md` — 独立完整，包含需求、交互、技术方案、文件清单、验证方案
- **功能规格书**: `specs/{功能名}.md` — 从迭代文档中拆分的独立功能详细设计
- **架构决策**: `decisions/{序号}-{主题}.md` — ADR 格式，记录重要技术决策
- **变更记录**: `changelog/CHANGELOG.md` — Keep a Changelog 格式
