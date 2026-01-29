import * as vscode from 'vscode';
// 1. 导入新写的侧边栏 Provider
import { ChatViewProvider } from './chatViewProvider';
// 导入 AI 引擎逻辑
import { AIProvider, DeepSeekProvider, GeminiProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Opengravity is now active!');

    /**
     * 辅助函数：统一从配置中获取当前的 AI 引擎实例
     */
    const getAIProvider = (): AIProvider | null => {
        const config = vscode.workspace.getConfiguration('opengravity');
        const providerType = config.get<string>('provider', 'deepseek');
        const apiKey = config.get<string>('apiKey');

        if (!apiKey) {
            return null;
        }

        return providerType === 'gemini' 
            ? new GeminiProvider(apiKey) 
            : new DeepSeekProvider(apiKey);
    };

    // --- 2. 注册侧边栏聊天视图 ---
    const sidebarProvider = new ChatViewProvider(context.extensionUri, getAIProvider);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType, 
            sidebarProvider
        )
    );

    // --- 3. 保留并优化原有的 opengravity.ask 命令 ---
    let askCommand = vscode.commands.registerCommand('opengravity.ask', async () => {
        const provider = getAIProvider();

        if (!provider) {
            vscode.window.showErrorMessage('API Key is not configured. Please set it in your settings.');
            return;
        }

        const userInput = await vscode.window.showInputBox({
            prompt: "Ask Opengravity anything..."
        });

        if (!userInput) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Opengravity is thinking...",
            cancellable: true
        }, async () => {
            try {
                const response = await provider.generateContent(userInput);
                const doc = await vscode.workspace.openTextDocument({
                    content: response,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } catch (error: any) {
                vscode.window.showErrorMessage(`AI Error: ${error.message}`);
            }
        });
    });

    context.subscriptions.push(askCommand);
}

export function deactivate() {}