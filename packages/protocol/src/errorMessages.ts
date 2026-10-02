import type { SuanliziErrorInfo } from './types.js';

export type SuanliziErrorLocale = 'zh' | 'en';

/**
 * 将运行时错误转换为用户可操作的短提示。底层 provider 文案只应保留在
 * 监控元数据中；历史条目即使没有新版 reason，也会按原文兜底识别超时。
 */
export function formatSuanliziErrorMessage(
  info: SuanliziErrorInfo | undefined,
  rawMessage: string | undefined,
  locale: SuanliziErrorLocale = 'zh',
): string {
  const raw = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  const inferred = inferErrorInfo(raw);
  const effectiveInfo = info?.kind && info.kind !== 'Other' ? info : inferred ?? info;
  const operational = formatOperationalError(raw, locale);
  if (operational) return operational;
  const isTimeout = effectiveInfo?.reason === 'timeout'
    || /timeout|aborted\s+due\s+to\s+timeout|timed\s+out/i.test(raw);
  if (isTimeout) {
    const seconds = effectiveInfo?.timeoutMs && effectiveInfo.timeoutMs >= 1000
      ? `（${Math.round(effectiveInfo.timeoutMs / 1000)} 秒）`
      : '';
    const operational = /\b(tool|command|mcp|skill|terminal|browser|operation)\b/i.test(raw)
      && !/\b(model|provider|response|completion|chat|gateway)\b/i.test(raw);
    return locale === 'zh'
      ? `${operational ? '操作超时' : '模型响应超时'}${seconds}：在设定时间内未完成。可以重试${operational ? '，或检查工具/服务是否仍在运行' : '，或在运行参数中提高模型响应超时'}。`
      : `${operational ? 'The operation' : 'The model response'} timed out${seconds}: it did not finish within the configured limit. Retry${operational ? ' or check the tool/service' : ' or increase the model response timeout'}.`;
  }

  const messages: Record<string, [string, string]> = {
    ContextWindowExceeded: ['上下文超过当前模型窗口，请先压缩上下文或降低输出上限。', 'The context exceeds this model window. Compact the context or lower the output limit.'],
    UsageLimitExceeded: ['模型服务已达到限流或配额上限，请稍后重试或检查用量。', 'The model service reached a rate or usage limit. Retry later or check usage.'],
    ServerOverloaded: ['模型服务暂时过载，请稍后重试。', 'The model service is temporarily overloaded. Retry shortly.'],
    HttpConnectionFailed: ['无法连接模型服务，请检查地址、网络和服务状态。', 'The model service could not be reached. Check the endpoint, network, and service status.'],
    ResponseTooManyFailedAttempts: ['模型请求多次失败，已停止重试；请检查服务状态后重试。', 'The model request failed repeatedly and retries were exhausted. Check the service and retry.'],
    Unauthorized: ['模型服务未授权，请检查 API 密钥和权限。', 'The model service rejected authorization. Check the API key and permissions.'],
    BadRequest: ['模型服务拒绝了请求，请检查模型、参数或工具协议。', 'The model service rejected the request. Check the model, parameters, or tool protocol.'],
    ResponseStreamDisconnected: ['模型响应连接中断，已保留当前已生成内容；可以重试。', 'The model response connection was interrupted. Generated content was kept; you can retry.'],
    ResponseStreamConnectionFailed: ['模型响应连接失败，请检查服务状态后重试。', 'The model response connection failed. Check the service and retry.'],
    InternalServerError: ['模型服务内部错误，请稍后重试。', 'The model service returned an internal error. Retry shortly.'],
    SandboxError: ['本地执行被安全策略阻止，请检查权限或工作区范围。', 'Local execution was blocked by the security policy. Check permissions or workspace scope.'],
  };
  const mapped = effectiveInfo?.kind ? messages[effectiveInfo.kind] : undefined;
  if (mapped) return locale === 'zh' ? mapped[0] : mapped[1];
  return raw || (locale === 'zh' ? '执行过程中出现错误，请重试。' : 'An error occurred while running the turn.');
}

export interface PresentableSuanliziError {
  /** 面向用户的短提示。 */
  summary: string;
  /** provider 或工具返回的原始信息；与短提示相同时不重复返回。 */
  detail?: string;
}

/**
 * 活动流和错误条使用两级展示：一级保持普通人可操作，二级保留原始响应。
 */
export function presentSuanliziError(
  info: SuanliziErrorInfo | undefined,
  rawMessage: string | undefined,
  locale: SuanliziErrorLocale = 'zh',
): PresentableSuanliziError {
  const raw = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  const summary = formatSuanliziErrorMessage(info, raw, locale);
  const detail = raw && normalizeErrorFingerprint(raw) !== normalizeErrorFingerprint(summary)
    ? raw
    : undefined;
  return { summary, detail };
}

/** 合并重复错误时用于识别同一底层响应，不区分空白大小写和超长尾随内容。 */
export function normalizeErrorFingerprint(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
}

/**
 * 运行时保护和工具治理错误不是 provider 错误，不能把内部 code 原样丢给用户。
 * 监控仍保留原始 code；对话、Toast、活动流统一显示可操作的短提示。
 */
function formatOperationalError(raw: string, locale: SuanliziErrorLocale): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const messages: Array<[RegExp, string, string]> = [
    [/(?:\b(?:aborterror|cancelled|canceled|turn cancelled)\b|\baborted\b(?!\s+due\s+to\s+timeout)|\babort\b(?![^\n]*timeout))/i, '当前操作已停止。', 'The current operation was stopped.'],
    [/tool_error_limit_reached|连续工具失败已达到/i, '工具连续失败已达到保护上限，已停止继续调用。请检查工具错误或换一种方式。', 'Tool calls were stopped after the consecutive-failure limit. Check the tool error or try another approach.'],
    [/tool_loop_detected|检测到重复调用同一工具/i, '检测到重复工具调用，已停止继续执行。请检查参数或换一种方式。', 'Repeated tool calls were detected and stopped. Check the arguments or try another approach.'],
    [/tool_governance_final_response_rejected|工具循环保护已触发.*仍返回工具调用/i, '工具治理已阻断本轮：模型在工具被禁用后仍请求工具。请重试或调整模型工具协议。', 'Tool governance stopped this turn because the model requested tools after they were disabled. Retry or adjust the tool protocol.'],
    [/subagent_limit_reached|maximum open subagents reached/i, '并行智能体已达到上限，未创建新的子智能体。', 'The parallel-agent limit was reached; no new subagent was created.'],
    [/guardian_denied|guardian_circuit_open/i, '安全策略拒绝了这次工具调用。请检查权限范围或审批状态。', 'The safety policy denied this tool call. Check the permission scope or approval state.'],
    [/ops_task_timeout|ops task exceeded its wall-time budget/i, '运维任务超过时间预算，已停止。可以缩小范围后重试。', 'The operations task exceeded its time budget and was stopped. Retry with a narrower scope.'],
    [/ops_knowledge_required|knowledge base.*required|select at least one personal knowledge base/i, '运维任务需要先选择个人知识库。请在设置中选择至少一个已就绪的知识库。', 'Select at least one ready personal knowledge base before starting the operations task.'],
    [/ops_knowledge_not_ready|selected snapshots? .*not ready|fixed knowledge query receipt is unavailable/i, '所选知识库没有可用快照，请先完成同步或重新选择知识库。', 'The selected knowledge base has no ready snapshot. Sync it or choose another knowledge base.'],
    [/ops_knowledge_sync_failed|knowledge sync failed/i, '知识库同步失败，请检查来源目录和读取权限后重试。', 'Knowledge-base sync failed. Check the source directory and permissions, then retry.'],
    [/ops_scope_required|workspace scope.*(?:match|changed)|canonical root/i, '工作区范围已变化或无效，任务已停止。请重新选择当前工作区后重试。', 'The workspace scope changed or is invalid. Select the current workspace and retry.'],
    [/ops_version_conflict|version conflict/i, '任务状态已被更新，请刷新后再执行这项操作。', 'The task changed meanwhile. Refresh and try the action again.'],
    [/ops_idempotency_conflict|idempotency-key.*different/i, '请求标识已用于另一组参数，请换一个请求标识后重试。', 'This request key was already used with different parameters. Retry with a new key.'],
    [/ops_invalid_transition|ops_terminal_state|cannot transition/i, '任务当前状态不允许这项操作，请刷新任务状态后重试。', 'The task state does not allow this action. Refresh the task and retry.'],
    [/max_active_tasks_reached|maximum active top-level tasks reached/i, '当前活动任务已达到上限，请等待已有任务完成后再试。', 'The active-task limit was reached. Wait for a task to finish and retry.'],
    [/request_body_too_large|request body exceeds/i, '请求内容过大，请减少附件或文本后重试。', 'The request is too large. Reduce the attachments or text and retry.'],
    [/plain_text_tool_call_repeated/i, '模型反复输出无效的工具文本，已停止本轮。请重试或更换模型。', 'The model repeatedly emitted an invalid plain-text tool call. This turn was stopped; retry or switch models.'],
    [/model\.output\.rejected|输出违反工具协议|tool protocol/i, '模型输出格式不符合工具协议，已停止这次调用并保留已有结果。', 'The model output did not match the tool protocol. The call was stopped and existing results were kept.'],
    [/middleware(?:_blocked| blocked)|runtime policy denied/i, '运行时策略拒绝了这次工具调用。请检查权限或工具配置。', 'The runtime policy denied this tool call. Check permissions or tool configuration.'],
    [/enoent|not found|no such file or directory/i, '找不到目标文件或工具，请检查路径和安装状态。', 'The target file or tool was not found. Check the path and installation.'],
    [/eacces|eperm|permission denied|access denied/i, '没有权限执行这项操作，请检查授权范围。', 'Permission was denied for this operation. Check the authorization scope.'],
  ];
  for (const [pattern, zh, en] of messages) {
    if (pattern.test(lower)) return locale === 'zh' ? zh : en;
  }
  return undefined;
}

/**
 * API/插件错误有时只携带 message，没有 SuanliziErrorInfo。这里仅做保守的
 * 表层归类，让 Toast、活动流和历史条目保持同一套用户提示；安全判定和
 * 重试策略仍以运行时携带的结构化 info 为准。
 */
function inferErrorInfo(raw: string): SuanliziErrorInfo | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const status = parseHttpStatus(raw);
  if (/context(?:\s+window|\s+length)?|maximum\s+(?:context|prompt)\s+length|prompt\s+is\s+too\s+long|too\s+many\s+tokens|token\s+limit/.test(lower)) {
    return { kind: 'ContextWindowExceeded' };
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid\s+api\s*key|api\s*key.*invalid/.test(lower)) {
    return { kind: 'Unauthorized', httpStatusCode: status };
  }
  if (status === 429 || /rate\s*limit|too\s+many\s+requests|quota|usage\s+limit/.test(lower)) {
    return { kind: 'UsageLimitExceeded', httpStatusCode: status };
  }
  if (status === 503 || /overloaded|temporarily\s+unavailable|service\s+unavailable/.test(lower)) {
    return { kind: 'ServerOverloaded', httpStatusCode: status };
  }
  if (status === 400 || status === 422 || /bad\s+request|invalid\s+(?:parameter|request|json)|schema\s+validation/.test(lower)) {
    return { kind: 'BadRequest', httpStatusCode: status };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'InternalServerError', httpStatusCode: status };
  }
  if (/econnreset|econnrefused|enotfound|fetch\s+failed|network|socket|connection\s+(?:refused|reset|closed|failed)/.test(lower)) {
    return { kind: 'HttpConnectionFailed', reason: 'network', httpStatusCode: status };
  }
  if (/stream\s+(?:disconnected|closed|ended)|connection\s+.*stream/.test(lower)) {
    return { kind: 'ResponseStreamDisconnected', httpStatusCode: status };
  }
  if (/too\s+many\s+failed\s+attempts|retries?\s+exhausted/.test(lower)) {
    return { kind: 'ResponseTooManyFailedAttempts', httpStatusCode: status };
  }
  return undefined;
}

function parseHttpStatus(raw: string): number | undefined {
  const match = /(?:\b(?:HTTP|status|code)\s*[:=]?|\()\s*(\d{3})\b/i.exec(raw);
  return match ? Number(match[1]) : undefined;
}
