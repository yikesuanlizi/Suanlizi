---
name: knowledge-ingestion
description: 将个人知识库来源按文件类型安全地解析、脱敏并写入不可变知识快照
version: 1.0.0
tags: knowledge, ingestion, document, pdf, docx, xlsx, pptx
---

# 知识库入库路由

知识库入库必须先使用用户明确授权的来源目录。不得把当前工作区、当前项目或请求参数中的任意路径当作知识库来源。

## 文件路由

- 纯文本与源码文件直接读取：`.md`、`.mdx`、`.txt`、`.log`、`.csv`、`.json`、`.yaml`、`.yml`、`.ts`、`.tsx`、`.js`、`.jsx`、`.py`、`.go`、`.java`、`.rs`、`.html`、`.css`、`.sql` 等。
- Word 使用 `docx` 提取器，读取正文文本后再进入统一脱敏和切块流程。
- PDF 使用 `pdf` 提取器；文本型 PDF 直接提取，扫描型 PDF 在没有 OCR 能力时必须记录为 `extraction_failed`，不得把二进制内容直接送入模型。
- Excel 使用 `xlsx` 提取器，按工作表转换为带工作表标题的文本。
- PowerPoint 使用 `pptx` 提取器，按幻灯片转换为带幻灯片标题的文本。
- 其他二进制类型必须记录 `unsupported_extension`，除非后续提供受控提取器。

## 安全约束

提取结果与纯文本一样必须经过统一 `SecretRedactor`。脱敏失败的文件不得写入 catalog、FTS、快照或模型上下文，只能写入跳过原因和统计。

提取器必须是预置或受信任的 Suanlizi Skill。启动或同步时如果预置 Skill 不在配置的 Skill 目录，应先安装/恢复对应内置 Skill；安装失败则让该文件进入可追踪的 `extraction_failed`，不能悄悄回退为乱码或原始二进制。

每个来源文件要记录原文件大小、提取器名称、提取器版本、内容哈希和跳过原因。快照完成后不可变，后续同步生成新快照。
