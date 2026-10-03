import type React from 'react';
import type { Locale } from '../config/config.js';

// 英文说明: DiffViewHunk mirrors the protocol FileChangeHunk shape.
// 中文说明: DiffViewHunk 对齐 protocol 的 FileChangeHunk 结构；缺失的行内容字段解析为空数组。
// 不直接从 @suanlizi/protocol 导入是因为 web/desktop 的 tsconfig 限制了 rootDir=src，
// 跨包源码导入会触发 TS6059/TS6307。
export interface DiffViewHunk {
  path: string;
  startLine?: number;
  endLine?: number;
  addedLines: number;
  removedLines: number;
  /** 实际新增的行内容（不含 '+' 前缀）；缺失时为空数组 */
  addedLinesContent?: string[];
  /** 实际删除的行内容（不含 '-' 前缀）；缺失时为空数组 */
  removedLinesContent?: string[];
  summary?: string;
}

export interface DiffViewProps {
  hunks: DiffViewHunk[];
  locale?: Locale;
}

// 按文件路径分组 hunk，避免同一文件多次重复渲染路径标题
// — English: group hunks by file path to avoid rendering duplicate path headers
interface HunkGroup {
  path: string;
  hunks: DiffViewHunk[];
  added: number;
  removed: number;
}

function groupHunksByPath(hunks: DiffViewHunk[]): HunkGroup[] {
  const groups = new Map<string, HunkGroup>();
  for (const hunk of hunks) {
    const path = hunk.path ?? '';
    const existing = groups.get(path);
    if (existing) {
      existing.hunks.push(hunk);
      existing.added += hunk.addedLines ?? 0;
      existing.removed += hunk.removedLines ?? 0;
    } else {
      groups.set(path, {
        path,
        hunks: [hunk],
        added: hunk.addedLines ?? 0,
        removed: hunk.removedLines ?? 0,
      });
    }
  }
  return Array.from(groups.values());
}

// 判断 hunk 是否有真实行内容；缺失字段视为无内容
// — English: detect real line content; missing fields mean no content
function hasLineContent(hunk: DiffViewHunk): boolean {
  const added = (hunk.addedLinesContent ?? []);
  const removed = (hunk.removedLinesContent ?? []);
  return added.length > 0 || removed.length > 0;
}

export function DiffView({ hunks, locale = 'zh' }: DiffViewProps) {
  if (!hunks || hunks.length === 0) {
    return null;
  }
  const zh = locale === 'zh';
  const groups = groupHunksByPath(hunks);

  return (
    <div className="diffView">
      {groups.map((group) => (
        <div className="diffViewFile" key={group.path || 'unknown'}>
          <div className="diffViewHeader">
            <span className="diffViewPath">{group.path}</span>
            <span className="diffViewStats">
              <span className="diffViewStatsAdded">+{group.added}</span>{' '}
              <span className="diffViewStatsRemoved">-{group.removed}</span>
            </span>
          </div>
          {group.hunks.map((hunk, hunkIndex) => {
            const startLine = hunk.startLine ?? 1;
            const endLine = hunk.endLine ?? startLine;
            const removedContent = hunk.removedLinesContent ?? [];
            const addedContent = hunk.addedLinesContent ?? [];
            const hasContent = hasLineContent(hunk);
            return (
              <div className="diffViewHunk" key={`${group.path}-${hunkIndex}`}>
                <div className="diffViewHunkHeader">
                  @@ -{startLine},{endLine} +{startLine},{endLine} @@
                </div>
                {hasContent ? (
                  <div className="diffViewLines">
                    {removedContent.map((line, i) => (
                      <div className="diffViewLine diffViewLineRemoved" key={`r-${hunkIndex}-${i}`}>
                        <span className="diffViewLineMarker">-</span>
                        <span className="diffViewLineContent">{line}</span>
                      </div>
                    ))}
                    {addedContent.map((line, i) => (
                      <div className="diffViewLine diffViewLineAdded" key={`a-${hunkIndex}-${i}`}>
                        <span className="diffViewLineMarker">+</span>
                        <span className="diffViewLineContent">{line}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="diffViewFallback">
                    {hunk.addedLines > 0 || hunk.removedLines > 0
                      ? `${hunk.addedLines} ${zh ? '行新增' : 'lines added'}, ${hunk.removedLines} ${zh ? '行删除' : 'lines removed'}`
                      : (zh ? '无变更内容' : 'No changes')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
