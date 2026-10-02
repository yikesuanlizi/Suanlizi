import { useState } from 'react';
import { presentSuanliziError } from '@suanlizi/protocol';
import type { SuanliziErrorInfo } from '@suanlizi/protocol';
import type { Locale } from '../../config/config.js';
import { Icon } from '../../components/Icon.js';

interface ErrorNoticeProps {
  info?: SuanliziErrorInfo;
  message?: string | null;
  detail?: string | null;
  locale: Locale;
  className: string;
}

/** 一级给用户可操作说明，二级保留模型或工具返回的原始响应。 */
export function ErrorNotice({ info, message, detail: explicitDetail, locale, className }: ErrorNoticeProps) {
  const [open, setOpen] = useState(false);
  const presented = presentSuanliziError(info, message ?? undefined, locale);
  const rawDetail = explicitDetail ?? presented.detail;

  return (
    <div className={className} role="alert">
      <Icon name="alert" />
      <span>{presented.summary}</span>
      {rawDetail ? (
        <button className="errorNoticeToggle" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
          {locale === 'zh' ? (open ? '收起详情' : '详情') : (open ? 'Hide detail' : 'Detail')}
        </button>
      ) : null}
      {open && rawDetail ? <pre className="errorNoticeRaw">{rawDetail}</pre> : null}
    </div>
  );
}
