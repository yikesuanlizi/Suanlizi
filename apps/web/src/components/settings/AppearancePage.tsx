// 设置面板：外观页（主题、语言、用户头像）
import React from 'react';
import type { Locale, RunConfig, ThemeMode } from '../../config/config.js';
import { t } from '../../shared/i18n.js';
import { DropdownSelect } from '../DropdownSelect.js';
import { CUSTOM_USER_AVATAR_ID, DEFAULT_USER_AVATAR_ID, USER_AVATAR_OPTIONS, UserAvatar, userAvatarLabel } from '../UserAvatar.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';
import { SectionHeader } from './SectionHeader.js';

export interface AppearancePageProps {
  locale: Locale;
  config: RunConfig;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  markDirty: (field: string, dirty: boolean) => void;
  dirtyFields: Record<string, boolean>;
}

export function AppearancePage({ locale, config, setConfig, markDirty, dirtyFields }: AppearancePageProps) {
  function selectUserAvatar(userAvatarId: RunConfig['userAvatarId']) {
    setConfig((current) => ({ ...current, userAvatarId }));
    markDirty('userAvatarId', true);
  }

  function resetUserAvatar() {
    setConfig((current) => ({
      ...current,
      userAvatarId: DEFAULT_USER_AVATAR_ID,
      customUserAvatarDataUrl: '',
    }));
    markDirty('userAvatarId', true);
    markDirty('customUserAvatarDataUrl', true);
  }

  function handleUserAvatarUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) return;
      setConfig((current) => ({
        ...current,
        userAvatarId: CUSTOM_USER_AVATAR_ID,
        customUserAvatarDataUrl: result,
      }));
      markDirty('userAvatarId', true);
      markDirty('customUserAvatarDataUrl', true);
    };
    reader.readAsDataURL(file);
  }

  const themeDirty = dirtyFields.themeMode ? 'dirty' : '';
  const localeDirty = dirtyFields.locale ? 'dirty' : '';

  return (
    <section className="settingsSection" id="settings-appearance">
      <SettingsPageHeader
        eyebrow={locale === 'zh' ? '界面' : 'Interface'}
        title={locale === 'zh' ? '外观' : 'Appearance'}
      />

      <div className="settingsSectionBlock">
        <SectionHeader title={locale === 'zh' ? '界面' : 'Interface'} />
        <div className="settingsFormGrid">
          <label className={`settingsField ${themeDirty}`}>
            <span className="settingsFieldLabel">{locale === 'zh' ? '主题' : 'Theme'}</span>
            <DropdownSelect<ThemeMode>
              value={config.themeMode}
              onChange={(themeMode) => {
                setConfig((current) => ({ ...current, themeMode }));
                markDirty('themeMode', true);
              }}
              options={[{ value: 'dark', label: locale === 'zh' ? '深色' : 'Dark' }, { value: 'light', label: locale === 'zh' ? '浅色' : 'Light' }, { value: 'system', label: locale === 'zh' ? '跟随系统' : 'System' }]}
            />
          </label>
          <label className={`settingsField ${localeDirty}`}>
            <span className="settingsFieldLabel">{t(locale, 'language')}</span>
            <DropdownSelect<Locale>
              value={config.locale}
              onChange={(nextLocale) => {
                setConfig((current) => ({ ...current, locale: nextLocale }));
                markDirty('locale', true);
              }}
              options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]}
            />
          </label>
        </div>
      </div>

      <div className="settingsSectionBlock">
        <SectionHeader title={locale === 'zh' ? '右侧栏' : 'Right panel'} />
        <label className="settingsField">
          <span className="settingsFieldLabel">{locale === 'zh' ? '固定活动与智能体标签' : 'Pin activity and agents tabs'}</span>
          <input
            checked={config.workbenchPinnedTabs !== false}
            onChange={(event) => {
              setConfig((current) => ({ ...current, workbenchPinnedTabs: event.target.checked }));
              markDirty('workbenchPinnedTabs', true);
            }}
            type="checkbox"
          />
        </label>
      </div>

      <div className="settingsSectionBlock">
        <SectionHeader
          title={locale === 'zh' ? '用户头像' : 'User avatar'}
          action={{
            label: locale === 'zh' ? '恢复默认' : 'Reset',
            title: locale === 'zh' ? '恢复默认头像' : 'Reset to default avatar',
            onClick: resetUserAvatar,
          }}
        />
        <div className="userAvatarGrid" aria-label={locale === 'zh' ? '选择用户头像' : 'Choose user avatar'}>
          {USER_AVATAR_OPTIONS.map((option) => (
            <button
              className={config.userAvatarId === option.id ? 'userAvatarOption active' : 'userAvatarOption'}
              key={option.id}
              onClick={() => selectUserAvatar(option.id)}
              type="button"
            >
              <UserAvatar avatarId={option.id} size="md" />
              <span>{locale === 'zh' ? option.labelZh : option.labelEn}</span>
            </button>
          ))}
          <label className={config.userAvatarId === CUSTOM_USER_AVATAR_ID ? 'userAvatarOption userAvatarUploadOption active' : 'userAvatarOption userAvatarUploadOption'}>
            <input className="userAvatarUploadInput" accept="image/*" type="file" onChange={handleUserAvatarUpload} />
            <UserAvatar avatarId={CUSTOM_USER_AVATAR_ID} customDataUrl={config.customUserAvatarDataUrl} size="md" />
            <span>{config.customUserAvatarDataUrl ? (locale === 'zh' ? '更换自定义' : 'Replace custom') : (locale === 'zh' ? '上传自定义' : 'Upload custom')}</span>
          </label>
        </div>
      </div>
    </section>
  );
}
