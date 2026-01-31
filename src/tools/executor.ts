/**
 * executor.ts - TARS 指令的执行者
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ToolExecutor {
    private static getRootPath(): string {
        const folders = vscode.workspace.workspaceFolders;
        return folders ? folders[0].uri.fsPath : "";
    }

    /**
     * 读取文件逻辑
     */
    static async read_file(args: { path: string }): Promise<string> {
        const fullPath = path.join(this.getRootPath(), args.path);
        
        // 1. 权限请求
        const confirm = await vscode.window.showInformationMessage(
            `TARS 想要读取: ${args.path}`, '允许', '拒绝'
        );
        if (confirm !== '允许') return "Error: User denied read access.";

        // 2. 执行读取
        try {
            if (!fs.existsSync(fullPath)) return "Error: File not found.";
            return fs.readFileSync(fullPath, 'utf-8');
        } catch (e: any) {
            return `Error: ${e.message}`;
        }
    }

    /**
     * 写入文件逻辑
     */
    static async write_file(args: { path: string, content: string }): Promise<string> {
        const fullPath = path.join(this.getRootPath(), args.path);

        // 1. 权限请求 (警告级别)
        const confirm = await vscode.window.showWarningMessage(
            `TARS 想要写入/修改: ${args.path}. 是否允许？`, '允许写入', '取消'
        );
        if (confirm !== '允许写入') return "Error: User denied write access.";

        // 2. 执行写入
        try {
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            
            fs.writeFileSync(fullPath, args.content, 'utf-8');
            
            // 自动打开文件
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
            
            return "Success: File written and opened.";
        } catch (e: any) {
            return `Error: ${e.message}`;
        }
    }

    /**
     * 执行命令逻辑
     */
    static async run_command(args: { command: string }): Promise<string> {
        // 1. 权限请求
        const confirm = await vscode.window.showErrorMessage(
            `警告：TARS 想要运行系统命令: \n> ${args.command}`, '允许运行', '拒绝'
        );
        if (confirm !== '允许运行') return "Error: User blocked command execution.";

        // 2. 在终端执行
        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal("TARS Terminal");
        terminal.show();
        terminal.sendText(args.command);
        
        return "Success: Command sent to terminal.";
    }
}