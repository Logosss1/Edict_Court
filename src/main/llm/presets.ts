// Connection presets. They only PREFILL protocol + base URL; nothing is hard-wired in the UI.
// Model ids are always typed (or fetched) by the user. Prices default to 0 (= unknown).
import type { Protocol } from '../../shared/types';

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  replayReasoning?: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'custom', name: '自定义（OpenAI 兼容）', protocol: 'openai-chat', baseUrl: '', hint: '任意兼容 Chat Completions 的服务，填写 base_url（通常以 /v1 结尾）' },
  { id: 'openai-responses', name: 'OpenAI Responses', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', hint: 'Responses API（/v1/responses）' },
  { id: 'openai-chat', name: 'OpenAI Chat', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', hint: 'Chat Completions（/v1/chat/completions）' },
  { id: 'anthropic', name: 'Anthropic Messages', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', hint: 'Messages API（/v1/messages），支持 prompt 缓存' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com', replayReasoning: true, hint: '思考模式工具调用需回传 reasoning_content（已默认开启）' },
  { id: 'glm', name: 'GLM（智谱）', protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: 'OpenAI 兼容接口' },
  { id: 'qwen', name: 'Qwen（阿里云百炼）', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: 'DashScope 兼容模式' },
  { id: 'kimi', name: 'Kimi（Moonshot）', protocol: 'openai-chat', baseUrl: 'https://api.moonshot.cn/v1', replayReasoning: true, hint: 'OpenAI 兼容接口' },
  { id: 'ollama', name: '本地 Ollama / LM Studio', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1', hint: '本机模型，无需 Key' },
];
