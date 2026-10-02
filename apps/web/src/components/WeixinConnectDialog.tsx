import type { Locale } from '../config/config.js';
import type { WeixinLoginState } from '../api/botClient.js';
import { Icon } from './Icon.js';

export function WeixinConnectDialog({
  locale,
  state,
  onClose,
}: {
  locale: Locale;
  state: WeixinLoginState;
  onClose(): void;
}) {
  const qr = state.qr;
  const connected = !state.polling && !state.error && Boolean(state.message);
  const dialogTitle = state.dialogTitle ?? (locale === 'zh' ? '连接微信远程助手' : 'Connect WeChat assistant');
  const successTitle = state.successTitle ?? (locale === 'zh' ? '微信已连接' : 'WeChat connected');
  const resultClass = state.error ? 'weixinLoginResult error' : connected ? 'weixinLoginResult ok' : 'weixinLoginResult pending';
  return (
    <div className="dialogLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="appDialog weixinConnectDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weixin-connect-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialogHeader">
          <h2 id="weixin-connect-title">{dialogTitle}</h2>
          <button className="iconButton" title={locale === 'zh' ? '关闭' : 'Close'} aria-label={locale === 'zh' ? '关闭' : 'Close'} onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {qr && state.polling ? (
          <div className="weixinQrBox large">
            <img src={qr.startsWith('data:image/') ? qr : qrImageSrc(qr)} alt={locale === 'zh' ? '微信登录二维码' : 'WeChat login QR'} />
            <span>{locale === 'zh' ? '请用手机微信扫码，Suanlizi 会自动确认。' : 'Scan with WeChat. Suanlizi will confirm automatically.'}</span>
          </div>
        ) : (
          <div className={resultClass}>
            <strong>{state.error
              ? (locale === 'zh' ? '连接失败' : 'Connection failed')
              : connected
                ? successTitle
                : (locale === 'zh' ? '正在连接' : 'Connecting')}</strong>
            <span>{state.error || state.message || (locale === 'zh' ? '正在生成二维码...' : 'Generating QR code...')}</span>
            {connected ? (
              <button className="solidButton" onClick={onClose}>{locale === 'zh' ? '完成' : 'Done'}</button>
            ) : null}
          </div>
        )}
        {state.error && qr ? <p className="dialogMessage errorText">{state.error}</p> : null}
      </section>
    </div>
  );
}

function qrImageSrc(value: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(value)}`;
}
