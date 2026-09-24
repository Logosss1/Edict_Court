// Start the MOCK LLM server standalone (for manual UI testing / script smoke tests).
import { startMockLlm } from './mockLlm';
startMockLlm({ delayMs: Number(process.env.MOCK_DELAY ?? 10) }).then((m) => console.log(`MOCK LLM listening: ${m.url}`));
