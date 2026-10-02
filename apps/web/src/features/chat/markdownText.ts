export function normalizeMarkdownForDisplay(text: string): string {
  if (!text) return text;
  return splitByFencedCode(text)
    .map((part) => part.kind === 'code' ? part.text : normalizeMarkdownChunk(part.text))
    .join('');
}

function splitByFencedCode(text: string): Array<{ kind: 'text' | 'code'; text: string }> {
  const parts: Array<{ kind: 'text' | 'code'; text: string }> = [];
  const pattern = /```[^\n`]*(?:\n[\s\S]*?)?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    parts.push({ kind: 'code', text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ kind: 'text', text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}

function normalizeMarkdownChunk(text: string): string {
  const lines = stripTaggedReasoning(text).split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (isTableStart(lines, index)) {
      addBlankBefore(output);
      output.push(line);
      index++;
      output.push(lines[index] ?? '');
      while (index + 1 < lines.length && isTableRow(lines[index + 1] ?? '')) {
        index++;
        output.push(lines[index] ?? '');
      }
      addBlankAfter(output, lines[index + 1]);
      continue;
    }
    if (isStandaloneBlockMarker(line)) {
      addBlankBefore(output);
      output.push(line);
      addBlankAfter(output, lines[index + 1]);
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

/** Hide provider reasoning tags that may exist in older persisted messages. */
function stripTaggedReasoning(text: string): string {
  return text.replace(/<think\s*>[\s\S]*?<\/think\s*>/gi, '');
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index] ?? '') && isTableSeparator(lines[index + 1] ?? '');
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').length >= 3 && !isTableSeparator(trimmed);
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isStandaloneBlockMarker(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+\S/.test(trimmed)
    || /^-{3,}$/.test(trimmed)
    || /^\*{3,}$/.test(trimmed)
    || /^_{3,}$/.test(trimmed);
}

function addBlankBefore(output: string[]): void {
  if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
}

function addBlankAfter(output: string[], nextLine: string | undefined): void {
  if (nextLine !== undefined && nextLine.trim()) output.push('');
}
