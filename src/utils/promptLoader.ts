import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export async function loadSystemPrompt(): Promise<string> {
    // 优先级 1: 当前工作区根目录的 SYSTEM.md
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspacePath = vscode.Uri.joinPath(workspaceFolders[0].uri, '.opengravity', 'SYSTEM.md');
        try {
            const content = await vscode.workspace.fs.readFile(workspacePath);
            console.log('Using Workspace System Prompt');
            return content.toString();
        } catch {
            // 如果读取失败（文件不存在），则继续寻找全局配置
        }
    }

    // 优先级 2: 用户主目录下的全局配置 (~/.opengravity/SYSTEM.md)
    const homeDir = os.homedir();
    const globalPath = vscode.Uri.file(path.join(homeDir, '.opengravity', 'SYSTEM.md'));
    try {
        const content = await vscode.workspace.fs.readFile(globalPath);
        console.log('Using Global System Prompt');
        return content.toString();
    } catch {
        // 全局文件也不存在
    }

    // 优先级 3: 默认兜底提示词
    return "You are Opengravity, an AI assistant for developers. You are helpful, concise, and focused on providing practical solutions.";
}