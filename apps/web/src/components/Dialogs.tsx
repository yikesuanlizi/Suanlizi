// 对话框组件：确认框 / 文本输入框
// Dialog components: confirm dialog / text-input dialog

import React, { useEffect, useRef, useState } from 'react';
import type { Locale } from '../config/config.js';
import { t } from '../shared/i18n.js';
import type { SkillDraft } from '../shared/types.js';
import { Icon } from './Icon.js';

export type AppDialogState =
  | {
      kind: 'decision';
      title: string;
      message?: string;
      actionLabel: string;
      cancelLabel: string;
      tone?: 'danger' | 'default';
      resolve: (value: boolean) => void;
    }
  | {
      kind: 'text';
      title: string;
      message?: string;
      value: string;
      actionLabel: string;
      cancelLabel: string;
      resolve: (value: string | null) => void;
    };
// AppDialogState 可区分确认框与文本输入框，resolve 用于返回结果给调用方
// AppDialogState distinguishes between confirm and text-input dialogs; resolve returns the result to the caller

export function AppDialog({ dialog, onClose }: { dialog: AppDialogState; onClose(): void }) {
  const [value, setValue] = useState(dialog.kind === 'text' ? dialog.value : '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 打开后自动聚焦文本输入框（仅在文本输入类型时需要）
  // Autofocus the text input when opened (only needed for text-input type)
  useEffect(() => {
    if (dialog.kind === 'text') {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [dialog.kind]);

  function cancel() {
    // 取消分支：decision 返回 false，text 返回 null
    // Cancel branch: decision returns false, text returns null
    if (dialog.kind === 'decision') {
      dialog.resolve(false);
    } else {
      dialog.resolve(null);
    }
    onClose();
  }

  function submit() {
    // 提交分支：decision 返回 true，text 返回输入值
    // Submit branch: decision returns true, text returns the input value
    if (dialog.kind === 'decision') {
      dialog.resolve(true);
    } else {
      dialog.resolve(value);
    }
    onClose();
  }

  return (
    <div className="dialogLayer" role="presentation" onMouseDown={cancel}>
      <section
        className="appDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialogHeader">
          <h2 id="app-dialog-title">{dialog.title}</h2>
        </header>
        {dialog.message ? <p className="dialogMessage">{dialog.message}</p> : null}
        {dialog.kind === 'text' ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
          />
        ) : null}
        <div className="dialogActions">
          <button className="textButton" onClick={cancel}>
            {dialog.cancelLabel}
          </button>
          <button className={dialog.kind === 'decision' && dialog.tone === 'danger' ? 'solidButton danger' : 'solidButton'} onClick={submit}>
            {dialog.actionLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function SettingsHelpDialog({ locale, onClose }: { locale: Locale; onClose(): void }) {
  const zh = locale === 'zh';
  type HelpSection = { num: number; title: string; body?: string; items?: Array<string | { name: string; desc: string }> };
  const sections: HelpSection[] = [
    {
      num: 1,
      title: zh ? '运行配置说明' : 'Run Configuration',
      items: [
        zh
          ? {
              name: '思考程度',
              desc: '快速关闭思考；均衡、深度、更深和最高逐级增强推理；动态工作流固定使用最高档。',
            }
          : {
              name: 'Reasoning effort',
              desc: 'Fast disables reasoning; Balanced, Deep, Deeper and Max increase reasoning step by step; Dynamic Workflow always uses Max.',
            },
        zh
          ? {
              name: '权限模式',
              desc: '只读禁止写入；默认允许工作区内读写并按策略审批；自主权限更宽，适合你明确要让 Agent 连续执行的场景。',
            }
          : {
              name: 'Permission mode',
              desc: 'Read-only blocks writes; Default allows workspace changes with policy checks; Autonomous is broader for hands-off runs.',
            },
        zh
          ? {
              name: '联网搜索',
              desc: '自动模式只在问题明显需要最新或外部信息时提示使用搜索；开启会一直提供搜索工具；关闭会完全隐藏搜索工具。',
            }
          : {
              name: 'Web search',
              desc: 'Auto recommends search only for current/external info; On always exposes it; Off hides it completely.',
            },
        zh
          ? {
              name: '上下文压缩',
              desc: '压缩会把旧轮次写成可追踪摘要，释放上下文窗口。压缩阈值在“运行参数”里按模型上下文窗口的百分比设置。',
            }
          : {
              name: 'Context compaction',
              desc: 'Rewrites old turns into a traceable summary. Set the threshold as a share of the model context window under Runtime settings.',
            },
      ],
    },
    {
      num: 2,
      title: zh ? 'GitNexus 代码分析' : 'GitNexus Code Analysis',
      items: [
        zh
          ? {
              name: '概览',
              desc: '展示项目整体架构概览，包括代码统计、依赖关系力导向图、模块分布。支持文件级和符号级两种视图。',
            }
          : {
              name: 'Overview',
              desc: 'Shows overall project architecture with code statistics, force-directed dependency graph, and module distribution. File-level and symbol-level views.',
            },
        zh
          ? {
              name: '智能搜索',
              desc: '用自然语言搜索相关代码，基于语义理解找到匹配的代码片段。适合想找某个功能但不知道具体文件名的场景。',
            }
          : {
              name: 'Smart Search',
              desc: 'Search code using natural language. Finds matching snippets based on semantic understanding. Great for locating features by description.',
            },
        zh
          ? {
              name: '符号上下文',
              desc: '查看某个符号（类/方法/函数）的完整上下文，包括定义位置、所有引用点、依赖关系和调用链。',
            }
          : {
              name: 'Symbol Context',
              desc: 'View complete context of a symbol (class/method/function): definition, all references, dependencies, and call chains.',
            },
        zh
          ? {
              name: '影响分析',
              desc: '分析修改某个符号可能影响的范围，包括上游调用者和下游依赖，帮助评估改动风险。',
            }
          : {
              name: 'Impact Analysis',
              desc: 'Analyze the impact scope of changing a symbol, including upstream callers and downstream dependencies, to assess change risk.',
            },
        zh
          ? {
              name: '调用路径',
              desc: '查找从入口函数到目标符号的调用路径，或两个符号之间的调用链路，帮助理解代码执行流程。',
            }
          : {
              name: 'Call Trace',
              desc: 'Find call paths from entry functions to target symbols, or between two symbols, helping understand code execution flow.',
            },
      ],
    },
    {
      num: 3,
      title: zh ? '使用小贴士' : 'Tips & Tricks',
      items: zh
        ? [
            '项目首次使用 GitNexus 需要先点击"开始分析"构建代码索引',
            '索引构建完成后会自动缓存，源码未改动时无需重新分析',
            '力导向图支持节点拖拽，点击节点可查看详细信息',
            '点击图右上角的"放大"按钮可全屏查看依赖关系图',
            '每个功能标签右侧的问号图标可查看该功能的详细说明',
          ]
        : [
            'First time using GitNexus? Click "Analyze" to build the code index',
            'Index is cached automatically — no re-analysis needed if source is unchanged',
            'Drag nodes on the force graph; click to see details',
            'Click the expand button for a full-screen dependency graph view',
            'The question mark icon next to each tab shows detailed feature info',
          ],
    },
  ];

  return (
    <div className="dialogLayer settingsHelpLayer" role="presentation" onMouseDown={onClose}>
      <section className="appDialog settingsHelpDialog" role="dialog" aria-modal="true" aria-labelledby="settings-help-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialogHeader">
          <h2 id="settings-help-title">{zh ? '使用说明' : 'Usage Guide'}</h2>
          <button className="iconButton" onClick={onClose} title={zh ? '关闭' : 'Close'} aria-label={zh ? '关闭' : 'Close'}><Icon name="x" /></button>
        </header>
        <div className="settingsHelpGuide">
          {sections.map((section) => (
            <div key={section.num} className="settingsHelpSection">
              <div className="settingsHelpSectionHeader">
                <span className="settingsHelpSectionNum">{section.num}</span>
                <h3 className="settingsHelpSectionTitle">{section.title}</h3>
              </div>
              <div className="settingsHelpSectionBody">
                {'body' in section && section.body ? (
                  <p className="settingsHelpParagraph">{section.body}</p>
                ) : null}
                {'items' in section && section.items && section.items.length > 0 ? (
                  <ul className="settingsHelpList">
                    {section.items.map((item, idx) => {
                      const isObject = typeof item === 'object' && item !== null;
                      const name = isObject && 'name' in item ? (item as { name?: string }).name : undefined;
                      const desc = isObject && 'desc' in item
                        ? (item as { desc?: string }).desc
                        : String(item);
                      return (
                        <li key={idx} className="settingsHelpListItem">
                          {name ? (
                            <strong className="settingsHelpItemName">{name}：</strong>
                          ) : null}
                          <span className="settingsHelpItemDesc">{desc}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SkillDraftDialog({
  draft,
  locale,
  onCancel,
  onSave,
}: {
  draft: SkillDraft;
  locale: Locale;
  onCancel(): void;
  onSave(draft: SkillDraft): Promise<void>;
}) {
  // 编辑并保存 Skill 草稿（名字、描述、SKILL.md 正文）
  // Edit and save a skill draft (name, description, SKILL.md body)
  const [current, setCurrent] = useState(draft);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await onSave(current);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialogLayer" role="presentation" onMouseDown={onCancel}>
      <section
        className="appDialog skillDraftDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-draft-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialogHeader">
          <h2 id="skill-draft-title">{locale === 'zh' ? '确认 Skill' : 'Confirm Skill'}</h2>
          <button className="iconButton" title={t(locale, 'cancel')} aria-label={t(locale, 'cancel')} onClick={onCancel}>
            <Icon name="x" />
          </button>
        </header>
        {draft.source === 'template' && draft.error ? (
          <p className="dialogMessage">
            {locale === 'zh' ? '模型草稿生成失败，已先给出模板草稿：' : 'Model drafting failed, using a template draft: '}
            {draft.error}
          </p>
        ) : null}
        <div className="mcpPanelForm">
          <label>
            {t(locale, 'name')}
            <input value={current.name} onChange={(event) => setCurrent({ ...current, name: event.target.value })} />
          </label>
          <label>
            {t(locale, 'description')}
            <input value={current.description} onChange={(event) => setCurrent({ ...current, description: event.target.value })} />
          </label>
          <label>
            SKILL.md
            <textarea value={current.body} onChange={(event) => setCurrent({ ...current, body: event.target.value })} />
          </label>
        </div>
        <div className="dialogActions">
          <button className="textButton" onClick={onCancel} disabled={saving}>{t(locale, 'cancel')}</button>
          <button className="solidButton" onClick={() => void submit()} disabled={saving || !current.name.trim() || !current.body.trim()}>
            {t(locale, 'save')}
          </button>
        </div>
      </section>
    </div>
  );
}
