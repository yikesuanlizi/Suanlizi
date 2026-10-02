// 设置面板页面标题：eyebrow + 标题 + 右上角操作按钮
import React from 'react';

export interface SettingsPageHeaderAction {
  label: string;
  /** 图标按钮：提供后只渲染图标，label 仅用于 title/aria-label。 */
  icon?: React.ReactNode;
  title?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface SettingsPageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: SettingsPageHeaderAction[];
}

export function SettingsPageHeader({ eyebrow, title, description, actions }: SettingsPageHeaderProps) {
  return (
    <header className="settingsPageHeader">
      <div className="settingsPageHeaderTitles">
        {eyebrow ? <span className="settingsPageHeaderEyebrow">{eyebrow}</span> : null}
        <h2 className="settingsPageHeaderTitle">{title}</h2>
        {description ? <p className="settingsPageHeaderDesc">{description}</p> : null}
      </div>
      {actions && actions.length > 0 ? (
        <div className="settingsPageHeaderActions">
          {actions.map((action, index) => (
            <button
              key={index}
              type="button"
              className={[
                'settingsPageHeaderAction',
                action.primary ? 'primary' : 'ghost',
                action.danger ? 'danger' : '',
                action.icon ? 'iconOnly' : '',
              ].filter(Boolean).join(' ')}
              title={action.title ?? action.label}
              aria-label={action.label}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.icon ?? action.label}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  );
}
