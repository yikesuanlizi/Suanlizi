import type {
  RuntimeMiddleware,
  RuntimeModelRequest,
  RuntimeModelResponse,
} from './middleware.js';

/**
 * 强制无工具收尾：请求层清空工具并拒绝绕过；响应层发现仍返回工具调用则硬停止。
 * Strict no-tool finalization: strip tools from the request, protect that decision
 * from wrappers, and hard-stop any response that still emits tool calls.
 */
export function createStrictToolFinalizationMiddleware(): RuntimeMiddleware {
  let noToolRequested = false;
  let protectedOnce = false;
  return {
    beforeModel: (_ctx, request: RuntimeModelRequest) => {
      if (request.tool_choice !== 'none') return;
      noToolRequested = true;
      return {
        ...request,
        tools: [],
        tool_choice: 'none',
      };
    },
    wrapModel: async (ctx, request, next) => {
      if (noToolRequested && protectedOnce) {
        request = { ...request, tools: [], tool_choice: 'none' };
      }
      const response: RuntimeModelResponse = await next(noToolRequested ? { ...request, tools: [], tool_choice: 'none' } : request);
      if (
        noToolRequested &&
        (response.message.tool_calls?.length ?? 0) > 0
      ) {
        protectedOnce = true;
        throw new Error('TOOL_GOVERNANCE_FINAL_RESPONSE_REJECTED');
      }
      return response;
    },
  };
}
