import type { Locale } from '../../config/config.js';
export function AboutPage({ locale }: { locale: Locale }) {
  return (
    <section className="settingsSection" id="settings-about">
      <SettingsPageHeader
        eyebrow={locale === 'zh' ? '关于' : 'About'}
        title={locale === 'zh' ? '关于' : 'About'}
      />
      <div className="settingsSectionBlock">
        <div className="settingsFormGrid">
          <div className="settingsField">
            <span className="settingsFieldLabel">{locale === 'zh' ? '版本' : 'Version'}</span>
            <span className="settingsValue">Suanlizi</span>
          </div>
          <div className="settingsField">
            <span className="settingsFieldLabel">{locale === 'zh' ? '构建' : 'Build'}</span>
            <span className="settingsValue">local-dev</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsPageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <header className="settingsPageHeader">
      <div className="settingsPageHeaderTitles">
        <span className="settingsPageHeaderEyebrow">{eyebrow}</span>
        <h1 className="settingsPageHeaderTitle">{title}</h1>
      </div>
    </header>
  );
}
