// BrowserEngineAdapter：通过 webContents.debugger（CDP）控制与用户相同的 WebContents。
// Phase 0 最小实现：Runtime.evaluate（读取/写入同一 DOM）+ Input 鼠标事件（用户可见的
// 真实交互）。Playwright connectOverCDP 仅作对比验证，不作为默认路径
// （Playwright 官方将 connectOverCDP 定义为低于原生协议的连接）。
// — English: BrowserEngineAdapter drives the SAME webContents the user sees via
//   webContents.debugger (CDP). Phase 0 minimal: Runtime.evaluate plus Input mouse
//   events. Playwright connectOverCDP is only a comparison probe, never the default.
import type { WebContentsView } from 'electron';
import type { BrowserEvaluateInput, BrowserClickInput } from '../contracts/browserTypes.js';

export interface CdpEvaluateResult {
  value?: unknown;
  // 由被评估脚本返回的对象（returnByValue=false 时用 objectId 后续引用）。
  // — English: object reference returned when returnByValue=false.
  objectId?: string;
}

interface CdpError {
  code: number;
  message: string;
}

export class BrowserEngineAdapter {
  private readonly view: WebContentsView;
  private attached = false;
  private attachPromise: Promise<void> | null = null;
  private agentInputDepth = 0;
  private lastAgentPointer: { x: number; y: number } | undefined;

  constructor(view: WebContentsView) {
    this.view = view;
    // webContents.debugger 可能因为页面销毁、DevTools 接管或 Chromium
    // target 重置而在本地状态未知的情况下 detach。若不清除 attached，
    // 后续新的 sidecar 会话会跳过 attach，连续得到“无标签页/动作失败”。
    // — English: keep the local attachment flag in sync with Chromium's
    // debugger lifecycle so a later sidecar session can reattach safely.
    this.view.webContents.debugger.on('detach', () => {
      this.attached = false;
    });
    this.view.webContents.on('destroyed', () => {
      this.attached = false;
    });
  }

  // 附着 CDP：同一 webContents 的 debugger Target。失败时抛出清晰错误。
  // — English: attach CDP to the same webContents debugger target.
  async attach(): Promise<void> {
    if (this.view.webContents.isDestroyed()) {
      throw new Error('CDP attach 失败：页面已销毁');
    }
    if (this.attached) return;
    if (this.attachPromise !== null) return this.attachPromise;
    this.attachPromise = (async () => {
      try {
        this.view.webContents.debugger.attach('1.3');
        this.attached = true;
      } catch (err) {
        this.attached = false;
        throw new Error(`CDP attach 失败：${formatCdpError(err)}`);
      } finally {
        this.attachPromise = null;
      }
    })();
    return this.attachPromise;
  }

  /**
   * 通过统一入口发送 CDP 命令。
   *
   * 任何命令抛错都意味着当前 attachment 不能再被安全复用；主动清理
   * 本地状态并尝试 detach，让下一次 observe/navigate 能重新 attach。
   * 当前命令不自动重放，避免 click/type 等有副作用动作被执行两次。
   */
  async sendCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.attach();
    try {
      return await this.view.webContents.debugger.sendCommand(method, params) as T;
    } catch (err) {
      this.resetAttachment();
      throw err;
    }
  }

  private resetAttachment(): void {
    this.attached = false;
    if (this.view.webContents.isDestroyed()) return;
    try {
      this.view.webContents.debugger.detach();
    } catch {
      // 已经 detach 或 target 正在销毁；下一次命令仍会重新尝试 attach。
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get isDispatchingAgentInput(): boolean {
    return this.agentInputDepth > 0;
  }

  private async dispatchAgentInput(operation: () => Promise<void>): Promise<void> {
    this.agentInputDepth += 1;
    try {
      await operation();
    } finally {
      this.agentInputDepth -= 1;
    }
  }

  // 在用户可见的同页面执行脚本：读取输入值、获取 DOM 状态、执行点击等。
  // — English: evaluate on the user-visible page — read input values, DOM state, clicks.
  async evaluate(input: BrowserEvaluateInput): Promise<unknown> {
    await this.attach();
    const { expression } = input;
    const response = await this.sendCommand<{ exceptionDetails?: unknown; result?: unknown }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails !== undefined) {
      const detail = response.exceptionDetails as { text?: string; exception?: { description?: string } };
      throw new Error(`页面脚本异常：${detail.exception?.description ?? detail.text ?? 'unknown'}`);
    }
    const result = response.result as { type: string; value?: unknown; objectId?: string };
    if (result.type === 'object' && result.objectId !== undefined) {
      // returnByValue 无法序列化（如函数/循环引用）：返回 objectId 供后续引用。
      // — English: un-serializable values fall back to an objectId for later use.
      const out: CdpEvaluateResult = { objectId: result.objectId };
      return out;
    }
    return result.value;
  }

  // CDP Input 事件驱动真实点击（用户在同一 View 立即可见）。虚拟指针只是对
  // Agent 输入的可见反馈；最终仍由同一个 CDP 鼠标事件完成点击。
  // — English: real clicks via CDP Input events. The cursor is a visible
  // indicator for agent input; the actual click remains a CDP mouse event.
  async click(input: BrowserClickInput): Promise<void> {
    await this.attach();
    const { x, y } = input;
    await this.dispatchAgentInput(async () => {
      await this.moveAgentPointer(x, y);
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      });
      await this.flashAgentPointer(x, y);
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      });
    });
  }

  private async moveAgentPointer(x: number, y: number): Promise<void> {
    const from = this.lastAgentPointer ?? {
      x: Math.max(16, x - 96),
      y: Math.max(16, y - 64),
    };
    const distance = Math.hypot(x - from.x, y - from.y);
    const durationMs = Math.max(110, Math.min(260, Math.round(90 + distance * 0.45)));
    const steps = Math.max(5, Math.min(14, Math.round(durationMs / 20)));

    await this.renderAgentPointer(from.x, from.y, false);
    await delay(16);
    await this.renderAgentPointer(x, y, false);

    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      // Ease-out keeps the pointer readable near the target without delaying the click.
      const eased = 1 - Math.pow(1 - progress, 3);
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (x - from.x) * eased,
        y: from.y + (y - from.y) * eased,
      });
      if (step < steps) await delay(Math.max(8, Math.round(durationMs / steps)));
    }
    this.lastAgentPointer = { x, y };
  }

  private async flashAgentPointer(x: number, y: number): Promise<void> {
    await this.renderAgentPointer(x, y, true);
    await delay(44);
  }

  private async renderAgentPointer(x: number, y: number, clicked: boolean): Promise<void> {
    const expression = `(() => {
      const id = '__suanlizi_agent_pointer__';
      let pointer = document.getElementById(id);
      if (!pointer) {
        pointer = document.createElement('div');
        pointer.id = id;
        pointer.setAttribute('aria-hidden', 'true');
        pointer.style.cssText = [
          'position:fixed', 'left:0', 'top:0', 'width:18px', 'height:18px',
          'margin:-3px 0 0 -3px', 'border:2px solid #2463da', 'border-radius:50%',
          'background:rgba(255,255,255,.92)', 'box-shadow:0 3px 12px rgba(20,53,114,.28)',
          'pointer-events:none', 'z-index:2147483647',
          'transition:transform 220ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease',
          'will-change:transform,opacity', 'opacity:1'
        ].join(';');
        const dot = document.createElement('i');
        dot.style.cssText = 'display:block;width:5px;height:5px;margin:4.5px;border-radius:50%;background:#2463da';
        pointer.appendChild(dot);
        (document.documentElement || document.body).appendChild(pointer);
      }
      pointer.style.transform = 'translate3d(' + ${JSON.stringify(x)} + 'px,' + ${JSON.stringify(y)} + 'px,0)';
      pointer.dataset.lastAgentMove = String(Date.now());
      if (${clicked ? 'true' : 'false'}) {
        pointer.animate([
          { transform: pointer.style.transform + ' scale(1)' },
          { transform: pointer.style.transform + ' scale(.72)', offset: .28 },
          { transform: pointer.style.transform + ' scale(1.7)', opacity: .12 }
        ], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      window.clearTimeout(Number(pointer.dataset.hideTimer || 0));
      pointer.dataset.hideTimer = String(window.setTimeout(() => { pointer.style.opacity = '0'; }, 1250));
      return true;
    })()`;
    try {
      await this.evaluate({ tabId: 'agent-pointer', expression });
    } catch {
      // A hostile page or a navigation may reject DOM injection. Input still proceeds.
    }
  }

  // 文本输入（真实键盘事件，用户在页面可见）。
  // — English: text insertion via CDP (visible to the user).
  async insertText(text: string): Promise<void> {
    await this.attach();
    await this.dispatchAgentInput(() => this.sendCommand('Input.insertText', { text }).then(() => undefined));
  }

  async pressKey(key: string, modifiers: string[] = []): Promise<void> {
    await this.attach();
    const modifierMask = modifiers.reduce((mask, modifier) => {
      switch (modifier.toLowerCase()) {
        case 'alt': return mask | 1;
        case 'control':
        case 'ctrl': return mask | 2;
        case 'meta':
        case 'command': return mask | 4;
        case 'shift': return mask | 8;
        default: return mask;
      }
    }, 0);
    const specialKeyCodes: Record<string, number> = {
      Backspace: 8,
      Tab: 9,
      Enter: 13,
      Escape: 27,
      Space: 32,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Delete: 46,
    };
    const keyCode = specialKeyCodes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
    const payload = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      modifiers: modifierMask,
      ...(keyCode !== undefined ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}),
    };
    await this.dispatchAgentInput(async () => {
      await this.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...payload });
      await this.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
    });
  }

  detach(): void {
    this.resetAttachment();
  }

  isCdpError(err: unknown): err is CdpError {
    return typeof err === 'object' && err !== null && 'code' in err && 'message' in err;
  }
}

function formatCdpError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
  }
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
