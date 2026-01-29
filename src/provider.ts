import OpenAI from "openai"; // 【修改】引入 openai 库

export interface AIProvider {
    generateContent(prompt: string, systemPrompt?: string): Promise<string>;
}

export class DeepSeekProvider implements AIProvider {
    private openai: OpenAI;

    constructor(apiKey: string) {
        // 【修改】在构造函数里初始化 openai 客户端
        this.openai = new OpenAI({
            baseURL: 'https://api.deepseek.com/v1', // 注意：官方路径通常是 /v1
            apiKey: apiKey,
        });
    }

    async generateContent(prompt: string, systemPrompt?: string): Promise<string> {
        try {
            // 【修改】使用 openai.chat.completions.create
            const completion = await this.openai.chat.completions.create({
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemPrompt || "You are a helpful assistant." },
                    { role: "user", content: prompt }
                ]
            });

            // 从返回结果中解析出内容
            return completion.choices[0].message.content || "No content returned.";

        } catch (error) {
            console.error(error);
            // 错误处理更具体
            if (error instanceof OpenAI.APIError) {
                return `DeepSeek API Error: ${error.status} - ${error.message}`;
            }
            return `An unexpected error occurred: ${error}`;
        }
    }
}
// --- (3) 预留“Gemini 引擎”的位置 (现在先不写) ---
export class GeminiProvider implements AIProvider {
    constructor(apiKey: string) {
        // ...
    }

    async generateContent(prompt: string, systemPrompt?: string): Promise<string> {
        // TODO: 在这里实现调用 Gemini API 的逻辑
        return "Gemini provider is not implemented yet.";
    }
}