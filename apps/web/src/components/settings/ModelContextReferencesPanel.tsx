import React from 'react';
import type { Locale } from '../../config/config.js';
import { DEFAULT_MODEL_CONTEXT_REFERENCES, validateModelContextReferences, type ModelContextReference } from '@suanlizi/protocol';
import { fetchModelContextReferences } from '../../api/modelContextReferencesClient.js';
import { Icon } from '../Icon.js';

type Row = { id: number; model: string; contextTokens: string };

async function saveModelContextReferences(entries: ModelContextReference[]): Promise<ModelContextReference[]> {
  const response = await fetch('/api/model-context-references', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }),
  });
  const body = await response.json() as { entries?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? '保存上下文参考列表失败');
  return validateModelContextReferences(body.entries);
}

export function ModelContextReferencesPanel({ locale, onClose, onSaved }: {
  locale: Locale;
  onClose: () => void;
  onSaved: (entries: ModelContextReference[]) => void;
}) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [serverReady, setServerReady] = React.useState(false);
  const rowId = React.useRef(0);
  const lock = React.useRef(false);
  const zh = locale === 'zh';
  React.useEffect(() => {
    const controller = new AbortController();
    void fetchModelContextReferences(controller.signal).then((entries) => {
      if (!controller.signal.aborted) {
        setRows(entries.map((entry) => ({ id: ++rowId.current, model: entry.model, contextTokens: String(entry.contextTokens) })));
        setServerReady(true);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setRows(DEFAULT_MODEL_CONTEXT_REFERENCES.map((entry) => ({ id: ++rowId.current, model: entry.model, contextTokens: String(entry.contextTokens) })));
        setServerReady(false);
        setError(zh ? '无法读取已保存列表，当前仅展示内置参考值。重新打开后再试。' : 'Unable to read the saved list. Built-in values are view-only; reopen to retry.');
      }
    });
    return () => controller.abort();
  }, []);

  function updateRow(id: number, field: 'model' | 'contextTokens', value: string) {
    setRows((current) => current?.map((row) => row.id === id ? { ...row, [field]: value } : row) ?? null);
    setError('');
  }
  async function submit() {
    if (lock.current || rows === null || !serverReady) return;
    let entries: ModelContextReference[];
    try {
      entries = validateModelContextReferences(rows.map((row) => ({ model: row.model, contextTokens: Number(row.contextTokens) })));
      // Number('') 为 0；协议验证会拒绝空长度。
    } catch {
      setError(zh ? '请填写不重复的模型名称和大于 0 的整数长度。' : 'Enter unique model names and positive integer lengths.');
      return;
    }
    lock.current = true;
    setSaving(true);
    try {
      onSaved(await saveModelContextReferences(entries));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="modelEditorLayer" role="presentation">
      <button className="modelEditorScrim" type="button" aria-label={zh ? '取消' : 'Cancel'} onClick={onClose} disabled={saving} />
      <div className="modelEditorPanel modelContextReferencesPanel" role="dialog" aria-modal="true" aria-label={zh ? '上下文参考' : 'Context references'}>
        <header className="modelEditorHeader">
          <h3>{zh ? '上下文参考' : 'Context references'}</h3>
          <button className="miniIconButton" type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose} disabled={saving}><Icon name="x" /></button>
        </header>
        <div className="modelContextReferencesToolbar">
          <span>{zh ? '识别失败时预填；数值仅供参考，不会修改已配置模型。' : 'Fallback values are estimates; changes do not update configured models.'}</span>
          <button className="miniIconButton" type="button" aria-label={zh ? '添加参考模型' : 'Add reference model'} title={zh ? '添加参考模型' : 'Add reference model'} disabled={rows === null || !serverReady || saving || rows.length >= 200} onClick={() => setRows((current) => current ? [...current, { id: ++rowId.current, model: '', contextTokens: '' }] : null)}><Icon name="plus" /></button>
        </div>
        {rows === null ? <p className="modelIconEmpty">{error || (zh ? '读取中…' : 'Loading…')}</p> : (
          <div className="modelContextReferencesList">
            {rows.length === 0 ? <p className="modelIconEmpty">{zh ? '列表为空，点击加号添加。' : 'Empty list. Use plus to add.'}</p> : null}
            {rows.map((row) => (
              <div className="modelContextReferenceRow" key={row.id}>
                <input aria-label={zh ? '模型名称' : 'Model name'} placeholder={zh ? '模型名称' : 'Model name'} maxLength={200} value={row.model} onChange={(event) => updateRow(row.id, 'model', event.target.value)} disabled={saving || !serverReady} />
                <input aria-label={zh ? '上下文长度' : 'Context length'} placeholder="tokens" type="number" min="1" max="100000000" step="1" value={row.contextTokens} onChange={(event) => updateRow(row.id, 'contextTokens', event.target.value)} disabled={saving || !serverReady} />
                <button className="miniIconButton danger" type="button" aria-label={(zh ? '删除参考模型 ' : 'Delete reference model ') + row.model} title={zh ? '删除' : 'Delete'} disabled={saving || !serverReady} onClick={() => setRows((current) => current?.filter((item) => item.id !== row.id) ?? null)}><Icon name="trash" /></button>
              </div>
            ))}
          </div>
        )}
        {rows !== null && error ? <p className="settingsNotice" role="alert">{error}</p> : null}
        <div className="modelEditorActions">
          <button className="textButton" type="button" onClick={onClose} disabled={saving}>{zh ? '取消' : 'Cancel'}</button>
          <button className="solidButton" type="button" onClick={() => void submit()} disabled={rows === null || !serverReady || saving}>{zh ? '保存列表' : 'Save list'}</button>
        </div>
      </div>
    </div>
  );
}
