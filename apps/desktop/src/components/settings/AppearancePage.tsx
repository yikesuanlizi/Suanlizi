// 设置面板：外观页（主题、语言、用户头像）
import React from 'react';
import type { Locale, RunConfig, ThemeMode } from '../../config/config.js';
import { t } from '../../shared/i18n.js';
import { DropdownSelect } from '../DropdownSelect.js';
import { CUSTOM_USER_AVATAR_ID, DEFAULT_USER_AVATAR_ID, USER_AVATAR_OPTIONS, UserAvatar, userAvatarLabel } from '../UserAvatar.js';
import { SettingsPageHeader } from './SettingsPageHeader.js';

export interface AppearancePageProps {
  locale: Locale;
  config: RunConfig;
  setConfig: React.Dispatch<React.SetStateAction<RunConfig>>;
  markDirty: (field: string, dirty: boolean) => void;
  // P2.2 dirty 跟踪：每个字段标记是否未保存
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
  const avatarDirty = dirtyFields.userAvatarId || dirtyFields.customUserAvatarDataUrl ? 'dirty' : '';

  return (
    <section className="settingsSection" id="settings-appearance">
      <SettingsPageHeader
        eyebrow={locale === 'zh' ? '界面' : 'Interface'}
        title={locale === 'zh' ? '外观' : 'Appearance'}
      />
      <div className="formGrid modelSettingsList">
        <label className={themeDirty ? 'fieldDirty' : ''}>
          {locale === 'zh' ? '主题' : 'Theme'}
          <DropdownSelect<ThemeMode>
            value={config.themeMode}
            onChange={(themeMode) => {
              setConfig((current) => ({ ...current, themeMode }));
              markDirty('themeMode', true);
            }}
            options={[{ value: 'dark', label: locale === 'zh' ? '深色' : 'Dark' }, { value: 'light', label: locale === 'zh' ? '浅色' : 'Light' }, { value: 'system', label: locale === 'zh' ? '跟随系统' : 'System' }]}
          />
        </label>
        <label className={localeDirty ? 'fieldDirty' : ''}>
          {t(locale, 'language')}
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
      <label className="settingLabel">
        <span>{locale === 'zh' ? '固定活动与智能体标签' : 'Pin activity and agents tabs'}</span>
        <input
          checked={config.workbenchPinnedTabs !== false}
          onChange={(event) => {
            setConfig((current) => ({ ...current, workbenchPinnedTabs: event.target.checked }));
            markDirty('workbenchPinnedTabs', true);
          }}
          type="checkbox"
        />
      </label>
      <div className={`avatarSettingsPanel ${avatarDirty ? 'panelDirty' : ''}`}>
        <div className="avatarSettingsHeader">
          <div>
            <strong>{locale === 'zh' ? '用户头像' : 'User avatar'}</strong>
          </div>
          <div className="avatarSettingsPreview">
            <UserAvatar avatarId={config.userAvatarId} customDataUrl={config.customUserAvatarDataUrl} size="lg" />
            <span>{userAvatarLabel(config.userAvatarId, locale)}</span>
          </div>
        </div>
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
        <div className="avatarSettingsActions">
          {config.customUserAvatarDataUrl ? (
            <button className="textButton" type="button" onClick={() => selectUserAvatar(CUSTOM_USER_AVATAR_ID)}>
              {locale === 'zh' ? '使用自定义头像' : 'Use custom avatar'}
            </button>
          ) : null}
          <button className="textButton" type="button" onClick={resetUserAvatar}>
            {locale === 'zh' ? '恢复默认头像' : 'Reset avatar'}
          </button>
        </div>
      </div>
    </section>
  );
}
