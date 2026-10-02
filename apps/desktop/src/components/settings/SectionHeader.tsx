// 设置面板 section 标题：标题 + 右侧 chip / 操作按钮
import React from 'react';

export interface SectionHeaderProps {
  title: string;
  help?: string;
  chip?: React.ReactNode;
  chipTone?: 'ok' | 'neutral';
  action?: {
    label: string;
    title?: string;
    onClick: () => void;
  };
}

export function SectionHeader({ title, help, chip, chipTone, action }: SectionHeaderProps) {
  return (
    <div className="settingsSectionHeader">
      <h3 className="settingsSectionHeaderTitle">{title}</h3>
      <div className="settingsSectionHeaderExtras">
        {help ? <span className="settingsHelpBadge" title={help} aria-label={help}>?</span> : null}
        {chip ? <span className={`settingsSectionHeaderChip ${chipTone === 'ok' ? 'ok' : ''}`}>{chip}</span> : null}
        {action ? (
          <button type="button" className="settingsSectionHeaderAction" title={action.title} onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
