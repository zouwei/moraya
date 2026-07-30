# Picora 侧待办（Moraya Typst 多文件文档模型）

> 提给 Picora 仓的需求清单。决策依据：[004-typst-multi-file-document-model.md](../decisions/004-typst-multi-file-document-model.md)
>
> 结论基于**阅读 Moraya 侧适配器实现**得出（`moraya-web/src/lib/storage/picora/picora-adapter.ts`）。带「待确认」的条目我无法从客户端代码判定，需要 Picora 侧核对。

## 0. 一句话

**只有写路径需要改。** 读路径已经是字节干净的，`sourceHash` 已按字节计算，嵌套路径已在用。

---

## P0 — 阻塞项：二进制写入

### 现状

写：`POST /v1/kbs/:kbId/sync`，op 形如

```ts
{ op: 'upsert', relativePath, content: <string>, sourceHash }
```

客户端把 body 一律 `TextDecoder` 解码后填 `content`：

```ts
// picora-adapter.ts:49
return { text: new TextDecoder().decode(body), bytes: body }
```

文本安全；PNG / TTF 经这一趟 UTF-8 解码 → 服务端再编码存储，**不可逆损坏**。

读：`GET /v1/docs/:docId/raw` → `res.arrayBuffer()` → `Uint8Array`。**已经字节干净，无需任何改动。**

### 需要

sync 的 upsert op 增加编码标记：

| 字段 | 取值 | 说明 |
|---|---|---|
| `encoding` | `"utf8"`（缺省）/ `"base64"` | 缺省视为 `utf8`，旧客户端与旧数据完全不受影响 |
| `content` | 文本 或 base64 | 按 `encoding` 解释 |

`/raw` 原样回吐字节即可（现在就是这样），无需在响应里回传 `encoding`。

**为什么不用独立的二进制上传端点**：`media.read` / `media.write` scope 虽已存在，但那样 Moraya 侧要区分两条存储路径，而兄弟文件在模型上就是"文档旁边的文件"，走同一条 sync 通道语义最直。若后续出现 MB 级字体再考虑分流。

### 不需要改的

- **`sourceHash`**：客户端已经用 `sha256Hex(bytes)` 按**字节**算，二进制天然正确，冲突检测与同步逻辑原样复用
- **嵌套路径**：`charged-ieee/main.typ` 这类多级 `relativePath` 已在用（`notes/.ai-conversations/…`）
- **manifest**：`relativePath` / `sizeBytes` 语义不变

---

## P1 — 待确认：非文档扩展名是否被拦

Typst 兄弟文件的 `relativePath` 会出现 `refs.bib`、`chapter.typ`、`data.csv`、`logo.png`。

**待确认**：服务端 upsert 是否对扩展名做校验？客户端不做任何过滤，所以这条只有 Picora 侧能回答。

若有白名单，需要放开到至少：`.typ .bib .csv .json .yaml .toml .xml .txt .md`，二进制上线后再加 `.png .jpg .svg .ttf .otf`。

---

## P1 — 待确认：批量 upsert 是否原子

`/sync` 的签名本来就接受**数组**：

```ts
private async postSync(ops: unknown[], context: string)
```

但适配器目前每次只发一条。模板脚手架要一次写入多个文件（`main.typ` + `refs.bib` + 资源），Moraya 侧现在的做法是**顺序写、入口文件最后写、失败回滚**——因为不能假设服务端原子。

**待确认**：一个请求里的多条 op 是否 all-or-nothing？

- **是** → Moraya 侧改为单请求批量提交，客户端回滚退居兜底，半成品项目彻底不可能出现
- **否** → 维持现状（已可用，只是回滚依赖客户端不崩）

---

## P2 — 二进制大小上限

建议对单个附件设上限（如 10 MB）并返回**明确错误码**，而不是截断或 500。Moraya 侧会把它转成可读提示。

参考量级：Typst Universe 里最大的模板包约 460 KB，单个缩略图约 500 KB。

---

## P2 — CORS 暴露同步元数据头

`/v1/docs/:docId/raw` 不回传 `X-Source-Hash` / `X-Updated-At`，且 CORS 未把它们放进 `Access-Control-Expose-Headers`，浏览器读不到。

Moraya 侧已有兜底（用 manifest 快照里缓存的值），但那是权宜——注释里写得很直白：

> 没有真实的 `updatedAt`，autosave 的第一次 putObject 就会漏掉 `baseUpdatedAt` → `BASE_MISSING` 冲突。

把这两个头加进 `Access-Control-Expose-Headers` 即可去掉这层兜底。不阻塞任何功能。

---

## 实测结论（2026-07-30，对 `api.picora.me` 线上实跑）

用 [scripts/verify-picora-binary.mjs](../../scripts/verify-picora-binary.mjs) + 定向诊断跑的结果。服务端 `version: 0.71.0`。

| 项 | 结论 | 证据 |
|---|---|---|
| **P0 二进制写入** | ❌ **未实施** | 见下 |
| P1a 辅助扩展名 | ✅ 已可用 | `.bib` / `.csv` / `.toml` 写入并读回，字节一致 |
| P1b 批量原子性 | ❌ **非原子** | 见下 |
| P2 CORS 暴露头 | ⚠️ 一半 | `Access-Control-Expose-Headers` 已含 `X-Source-Hash, X-Updated-At`，但 `/raw` **实际不发** `X-Source-Hash` |

### P0：`encoding` 被忽略，内容按字符串原样存

决定性的一组对照：

| 请求 | 结果 |
|---|---|
| `encoding:'base64'` + `sourceHash` = sha256(**解码后字节**) | `LOCAL_HASH_MISMATCH` |
| `encoding:'base64'` + `sourceHash` = sha256(**base64 字符串**) | applied |

读回 `probe.png`：**97 字节**，内容是 `iVBORw0KGgoA…`（base64 文本本身），PNG 魔数 `89 50 4e 47` 不存在；原始 PNG 是 70 字节。

即：服务端既没有解码，也没有按字节计算哈希 —— `encoding` 字段被静默丢弃，`content` 仍当纯文本存。**这正是本契约要防的那种损坏**，且客户端拿不到任何报错。

### P1b：非原子

一个批次里放 [合法 op, 哈希非法 op]：

```
applied   = [__moraya_probe4__/g.typ]
conflicts = [__moraya_probe4__/bad.typ : LOCAL_HASH_MISMATCH]
```

直接按响应给的 docId 读 `/v1/docs/<id>/raw` → `HTTP 200`，内容 `= Good`。**邻居被拒，这一条仍然落库了。**

⇒ Moraya 侧模板脚手架的「顺序写 + 入口最后 + 失败回滚」**必须保留**。

### 顺带测出的两条行为（不在契约里，但影响客户端）

- **manifest 有延迟**：刚写入的文档约 1 分钟内不出现在 `/manifest`，用它做「写入是否成功」的判据会误判（应改用 sync 响应里的 `applied[].id`）
- **delete 必须带 `baseUpdatedAt`**：否则静默不生效（适配器注释里已记录：缺省会被判 `BASE_MISSING`）

### 结论

`supportsBinary` **保持 `false`**。过渡期行为（文本辅助文件可用、二进制模板创建前拒绝并说明）继续有效。

---

## 验收

Picora P0 上线后，Moraya 侧**无需改动**即应通过：

1. 云 KB 中放 `paper.typ` + `logo.png`，文档 `#image("logo.png")` → 预览与导出正常
2. 上传前后 `sha256` 一致（字节级往返无损）
3. 旧版本客户端读到二进制文档时不会拿到损坏内容而不自知

Moraya 侧对应开关是一个字面量：

```ts
// picora-adapter.ts
readonly capabilities: AdapterCapabilities = {
  supportsBinary: false,   // ← 上线后改 true
  …
}
```

## 过渡期行为（Moraya 侧已实现）

- 文本辅助文件（`.bib` `.typ` `.csv` `.json` `.yaml` `.toml` `.xml`）在云 KB 下**正常工作** —— 覆盖 thesis / paper / report 类模板的主要需求
- 带二进制的模板在云 KB 下**创建前就被拒绝并说明原因**（不会写出损坏文件）；本地 KB 不受限
- 编译器找不到文件时由 Typst 自己报诊断，不会静默出空白页
