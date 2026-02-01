import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatViewProvider } from './chatViewProvider';
import { AIProvider, DeepSeekProvider, GeminiProvider } from './provider';
import { McpHost } from './mcp/mcpHost';
import { loadSystemPrompt } from './utils/promptLoader';

// 1. 定义全局变量
let mcpHost: McpHost | undefined;

async function initializeWorkspace() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const rootPath = workspaceFolders[0].uri.fsPath;
    const configDir = path.join(rootPath, '.opengravity');

    if (!fs.existsSync(configDir)) {
        const selection = await vscode.window.showInformationMessage(
            'Opengravity: 是否初始化工作区结构?', '初始化', '忽略'
        );
        if (selection === '初始化') {
            try {
                ['.opengravity','daily','codes','notes','todo','brainstorm','reviews'].forEach(f => {
                    const p = path.join(rootPath, f);
                    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
                });
                
                // 写入初始 MCP 配置
                const mcpPath = path.join(configDir, 'mcp_config.json');
                const defaultMcp = {
                    "mcpServers": {
                        "filesystem": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-filesystem", rootPath]
                        }
                    }
                };
                fs.writeFileSync(mcpPath, JSON.stringify(defaultMcp, null, 2));

                const sysPromptPath = path.join(configDir, 'SYSTEM.md');
                fs.writeFileSync(sysPromptPath, "# SYSTEM PROMPT\nYou are TARS.");
                vscode.window.showInformationMessage('Initialized! 🚀');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Init failed: ${error.message}`);
            }
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('[CHECK] Opengravity is now active!');
    await initializeWorkspace();

    // 2. 初始化并启动 MCP Host
    mcpHost = new McpHost();
    await mcpHost.startup();

    const getAIProvider = (): AIProvider | null => {
        const config = vscode.workspace.getConfiguration('opengravity');
        const apiKey = config.get<string>('apiKey');
        if (!apiKey) return null;
        return new DeepSeekProvider(apiKey);
    };

    // 3. 【核心修复】：传入 mcpHost! 确保三个参数完整
    const sidebarProvider = new ChatViewProvider(context.extensionUri, getAIProvider, mcpHost!);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, sidebarProvider)
    );

    // 4. 注册 Diff 命令
    context.subscriptions.push(vscode.commands.registerCommand('opengravity.showDiff', async (aiCode: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const aiDoc = await vscode.workspace.openTextDocument({ content: aiCode, language: editor.document.languageId });
        await vscode.commands.executeCommand('vscode.diff', editor.document.uri, aiDoc.uri, 'Diff View');
    }));
}

export function deactivate() {
    // 插件关闭时可以清理 MCP 连接（可选）
}