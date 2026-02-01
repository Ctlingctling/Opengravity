import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface McpConfig {
    mcpServers: {
        [key: string]: {
            command: string;
            args: string[];
            env?: Record<string, string>;
        };
    };
}

export class McpHost {
    private clients: Map<string, Client> = new Map();
    private isInitialized = false;

    async startup() {
        if (this.isInitialized) return;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return;

        const configPath = path.join(folders[0].uri.fsPath, '.opengravity', 'mcp_config.json');
        if (!fs.existsSync(configPath)) return;

        try {
            const configContent = fs.readFileSync(configPath, 'utf-8');
            const config: McpConfig = JSON.parse(configContent);

            for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
                await this.connectServer(serverName, serverConfig);
            }
            this.isInitialized = true;
        } catch (e: any) {
            console.error(`[MCP] Config error: ${e.message}`);
        }
    }

    private async connectServer(name: string, config: { command: string, args: string[], env?: any }) {
        try {
            // 【核心修复】：清洗环境变量，剔除所有 undefined 的值
            const cleanEnv: Record<string, string> = {};
            Object.entries(process.env).forEach(([k, v]) => {
                if (v !== undefined) cleanEnv[k] = v;
            });
            // 合并用户定义的 env
            const finalEnv = { ...cleanEnv, ...config.env };

            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: finalEnv // 👈 现在这里全是 string 了
            });

            const client = new Client(
                { name: "Opengravity-Host", version: "1.0.0" },
                { capabilities: {} }
            );

            await client.connect(transport);
            this.clients.set(name, client);
            vscode.window.showInformationMessage(`[MCP] ${name} 已连接`);
        } catch (e) {
            console.error(`[MCP] Connection error: ${name}`, e);
        }
    }

    async getToolsForAI() {
        const allTools: any[] = [];
        for (const [serverName, client] of this.clients) {
            try {
                const result = await client.listTools();
                allTools.push(...result.tools.map(tool => ({
                    type: "function",
                    function: {
                        name: `${serverName}__${tool.name}`,
                        description: tool.description || "",
                        parameters: tool.inputSchema,
                        strict: true
                    }
                })));
            } catch (e) { console.error(e); }
        }
        return allTools;
    }

    async executeTool(prefixedName: string, args: any): Promise<string> {
        const sep = prefixedName.indexOf("__");
        if (sep === -1) return "Error: Invalid format.";
        const serverName = prefixedName.substring(0, sep);
        const toolName = prefixedName.substring(sep + 2);
        const client = this.clients.get(serverName);
        if (!client) return `Error: Server ${serverName} inactive.`;

        const confirm = await vscode.window.showInformationMessage(
            `TARS 执行工具: [${serverName}] ${toolName}`, "允许", "拒绝"
        );
        if (confirm !== "允许") return "User denied.";

        try {
            const result = await client.callTool({ name: toolName, arguments: args });
            return JSON.stringify(result.content);
        } catch (e: any) { return `Error: ${e.message}`; }
    }
}