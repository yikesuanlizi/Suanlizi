import React from 'react';
import type { Locale } from '../../config/config.js';

function text(locale: Locale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

function SettingsPageHeader({
  eyebrow,
  title,
}: {
  eyebrow?: string;
  title: string;
}) {
  return (
    <header className="settingsPageHeader">
      <div className="settingsPageHeaderTitles">
        {eyebrow ? <span className="settingsPageHeaderEyebrow">{eyebrow}</span> : null}
        <h2 className="settingsPageHeaderTitle">{title}</h2>
      </div>
    </header>
  );
}

export function AboutPage({ locale }: { locale: Locale }) {
  return (
    <section className="settingsSection" id="settings-about">
      <SettingsPageHeader
        eyebrow={text(locale, '关于', 'About')}
        title={text(locale, '关于 Suanlizi', 'About Suanlizi')}
      />
      <div className="settingsCard settingsCardCompact">
        <div className="aboutRow">
          <span className="aboutLabel">{text(locale, '版本', 'Version')}</span>
          <span className="aboutValue">{text(locale, '开发版', 'Development build')}</span>
        </div>
        <div className="aboutRow">
          <span className="aboutLabel">{text(locale, '构建时间', 'Build time')}</span>
          <span className="aboutValue">—</span>
        </div>
        <div className="aboutRow">
          <span className="aboutLabel">{text(locale, '运行模式', 'Runtime mode')}</span>
          <span className="aboutValue">desktop</span>
        </div>
      </div>
    </section>
  );
}
