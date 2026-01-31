import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AIProvider, ApiMessage } from './provider';
import { loadSystemPrompt } from './utils/promptLoader';
import { TARS_TOOLS } from './tools/definitions'; // 👈 引入说明书
import { ToolExecutor } from './tools/executor';    // 👈 引入执行者

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'opengravity.chatView';
    private _view?: vscode.WebviewView;
    
    // 核心：真实的 API 上下文记忆
    private _apiMessages: ApiMessage[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getAIProvider: () => AIProvider | null
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        // --- 【新增】启动时加载历史 ---
        this.loadSessionFromDisk(); 

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webviewLoaded':
                    // 解决切换页面还原：将现有记忆同步给 UI
                    this.restoreUIHistory();
                    break;
                case 'userInput':
                    await this.handleUserMessage(data.value);
                    break;
                case 'linkActiveFile':
                    await this.handleLinkActiveFile();
                    break;
                case 'saveAndClear':
                    await this.handleSaveAndClear();
                    break;
                case 'insertCode':
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        editor.edit(editBuilder => editBuilder.insert(editor.selection.active, data.value));
                    }
                    break;
            }
        });
    }

    private async handleUserMessage(content: string) {
        if (!this._view) return;
        const provider = this._getAIProvider();
        if (!provider) return;

    // A. 基础上下文维护
        if (this._apiMessages.length === 0) {
            const sys = await loadSystemPrompt();
            this._apiMessages.push({ role: 'system', content: sys });
        }
        if (content) { // 只有用户输入时才 push，自动递归时 content 为空
            this._apiMessages.push({ role: 'user', content });
        }

        try {
            this._view.webview.postMessage({ type: 'streamStart' });

        // B. 调用 AI (注意我们将 tools 传递给 provider)
            const aiResponse = await provider.generateContentStream(
                this._apiMessages, 
                (update) => {
                    this._view?.webview.postMessage({ type: 'streamUpdate', dataType: update.type, value: update.delta });
                }
            // 这里记得修改你的 provider.ts，让它在 API 调用时带上 TARS_TOOLS
            );

            this._apiMessages.push(aiResponse);
            this._view.webview.postMessage({ type: 'streamEnd' });
            this.saveSessionToDisk();

        // C. 【关键】处理工具调用逻辑
            if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
                for (const toolCall of aiResponse.tool_calls) {
                    const name = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);

                    let result = "";
                // 分发执行
                    if (name === 'read_file') result = await ToolExecutor.read_file(args);
                    else if (name === 'write_file') result = await ToolExecutor.write_file(args);
                    else if (name === 'run_command') result = await ToolExecutor.run_command(args);

                // D. 回传结果给 AI
                    this._apiMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: result
                    });
                }

            // E. 【自循环】工具执行完后，不需要用户说话，AI 自动根据结果继续回复
                await this.handleUserMessage(""); 
            }

        } catch (err: any) {
            this._view.webview.postMessage({ type: 'error', value: err.message });
        }
    }
    
    private async processAgentCommands(aiResponse: string) {
        if (!vscode.workspace.workspaceFolders) return;
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;

        // READ 指令解析: [[READ: path]]
        const readRegex = /\[\[READ:\s*(.*?)\]\]/g;
        let readMatch;
        while ((readMatch = readRegex.exec(aiResponse)) !== null) {
            const relPath = readMatch[1].trim();
            const fullPath = path.join(rootPath, relPath);
            const selection = await vscode.window.showInformationMessage(`TARS 请求读取文件: ${relPath}`, '允许', '拒绝');
            if (selection === '允许' && fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                await this.handleUserMessage(`[SYSTEM_READ]: ${relPath}\n内容如下:\n\`\`\`\n${content}\n\`\`\``);
            }
        }

        // WRITE 指令解析: [[WRITE: path]] ... [[END]]
        const writeRegex = /\[\[WRITE:\s*(.*?)\]\]([\s\S]*?)\[\[END\]\]/g;
        let writeMatch;
        while ((writeMatch = writeRegex.exec(aiResponse)) !== null) {
            const relPath = writeMatch[1].trim();
            let newContent = writeMatch[2].trim().replace(/^```[a-z]*\n/, '').replace(/\n```$/, '');
            const selection = await vscode.window.showWarningMessage(`TARS 请求写入文件: ${relPath}`, '允许写入', '拒绝');
            if (selection === '允许写入') {
                const fullPath = path.join(rootPath, relPath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, newContent, 'utf-8');
                vscode.window.showInformationMessage(`✅ 文件 ${relPath} 已同步`);
            }
        }
    }

    private restoreUIHistory() {
        // 将 _apiMessages 转换为 UI 需要的格式并发送
        const uiHistory = this._apiMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role === 'assistant' ? 'ai' : 'user',
                content: m.content
            }));
        this._view?.webview.postMessage({ type: 'restoreHistory', value: uiHistory });
    }

    private async handleLinkActiveFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("ERR: NO ACTIVE FILE OPEN");
            return;
        }

        const fileName = path.basename(editor.document.fileName);
        const fileContent = editor.document.getText();
        
        // 【关键修改】：不再直接发消息，而是把构造好的 Prompt 发回给前端输入框
        // 让用户觉得是“我引用了这个文件，现在我要问...”
        const contextPrompt = `[CONTEXT: ${fileName}]\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
        
        // 我们需要通知前端：把这段话填进输入框，但不要发送！
        this._view?.webview.postMessage({ 
            type: 'fillInput', 
            value: contextPrompt 
        });
    }

    private async handleSaveAndClear() {
        if (this._apiMessages.length <= 1) return; // 只有位系统提示词时不处理
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const savePath = path.join(workspaceFolders[0].uri.fsPath, 'reviews', `chat_${Date.now()}.md`);
        let log = "# Chat Archive\n\n";
        this._apiMessages.forEach(m => log += `### ${m.role}\n${m.content}\n\n`);
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, log, 'utf-8');
        this._apiMessages = [];
        this._view?.webview.postMessage({ type: 'clearView' });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        :root {
            --bg: var(--vscode-sideBar-background);
            --fg: var(--vscode-terminal-foreground);
            --user-c: var(--vscode-terminal-ansiCyan);
            --ai-c: var(--vscode-terminal-ansiGreen);
            --border: var(--vscode-panel-border);
        }
        body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; background-color: var(--bg); color: var(--fg); font-family: 'JetBrains Mono', monospace; font-size: 12px; }
        #chat-box { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 20px; }
        .msg { border-left: 2px solid transparent; padding-left: 10px; }
        .user { border-left-color: var(--user-c); color: var(--user-c); }
        .ai { border-left-color: var(--ai-c); }
        .reasoning { margin: 10px 0; padding: 8px; border: 1px dashed #666; background: rgba(255,255,255,0.03); color: #888; font-size: 0.9em; display: none; white-space: pre-wrap; }
        .reasoning::before { content: ":: THOUGHT_PROCESS"; display: block; font-weight: bold; margin-bottom: 5px; opacity: 0.5; }
        pre { background: rgba(0,0,0,0.3); border: 1px solid #333; padding: 10px; position: relative; cursor: pointer; overflow-x: auto; }
        pre:hover::after { content: "CLICK TO INSERT"; position: absolute; top: 2px; right: 5px; font-size: 9px; color: var(--ai-c); }
        #bottom-container { border-top: 1px solid var(--border); padding: 10px; background: var(--bg); }
        #action-bar { display: flex; gap: 8px; margin-bottom: 8px; }
        .btn { font-size: 10px; cursor: pointer; padding: 2px 6px; border: 1px solid #666; color: #666; }
        .btn:hover { border-color: var(--fg); color: var(--fg); }
        .input-wrapper { display: flex; border: 1px solid var(--border); padding: 6px; background: rgba(0,0,0,0.2); }
        textarea { flex: 1; background: transparent; border: none; color: inherit; font-family: inherit; outline: none; resize: none; }
        .hint { font-size: 9px; color: #666; text-align: right; margin-top: 4px; }
    </style>
</head>
<body>
    <div id="chat-box"></div>
    <div id="bottom-container">
        <div id="action-bar">
            <div class="btn" onclick="linkFile()">[LINK_FILE]</div>
            <div class="btn" onclick="saveClear()">[SAVE_CHAT]</div>
        </div>
        <div class="input-wrapper">
            <span style="color:var(--ai-c); margin-right:8px; font-weight:bold">></span>
            <textarea id="input" rows="1" placeholder="Option+Enter to Send"></textarea>
        </div>
        <div class="hint">⌥ Option + Enter to SEND</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const chatBox = document.getElementById('chat-box');
        const input = document.getElementById('input');

        function linkFile() { vscode.postMessage({ type: 'linkActiveFile' }); }
        function saveClear() { vscode.postMessage({ type: 'saveAndClear' }); }

        document.addEventListener('click', e => {
            const pre = e.target.closest('pre');
            if (pre) {
                const code = pre.innerText.replace("CLICK TO INSERT", "").trim();
                vscode.postMessage({ type: 'insertCode', value: code });
            }
        });

        input.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.altKey) {
                e.preventDefault();
                const val = input.value.trim();
                if (!val) return;
                appendMsg('user', val);
                vscode.postMessage({ type: 'userInput', value: val });
                input.value = '';
                input.style.height = 'auto';
            }
        });

        let curRes = null, curCnt = null, mdBuf = "";
        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            const label = role === 'user' ? 'USER' : 'OPENGRAVITY';
            div.innerHTML = \`<div style="font-weight:bold;margin-bottom:5px">[\${label}]</div><div class="reasoning"></div><div class="content"></div>\`;
            if (role === 'user') div.querySelector('.content').textContent = text;
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
            return div;
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'streamStart') {
                const div = appendMsg('ai', '');
                curRes = div.querySelector('.reasoning');
                curCnt = div.querySelector('.content');
                mdBuf = "";
            } else if (msg.type === 'streamUpdate') {
                if (msg.dataType === 'reasoning') {
                    curRes.style.display = 'block';
                    curRes.textContent += msg.value;
                } else {
                    mdBuf += msg.value;
                    curCnt.innerHTML = marked.parse(mdBuf);
                }
                chatBox.scrollTop = chatBox.scrollHeight;
            } else if (msg.type === 'clearView') {
                chatBox.innerHTML = '<div style="color:var(--ai-c)">[SYSTEM] Memory Purged. Archive Created.</div>';
            } else if (msg.type === 'restoreHistory') {
                chatBox.innerHTML = '';
                msg.value.forEach(m => {
                    const div = appendMsg(m.role, m.content);
                    if (m.role === 'ai') div.querySelector('.content').innerHTML = marked.parse(m.content);
                });
            } else if (msg.type === 'fillInput') {
                // 把内容填进输入框，并聚焦
                input.value = msg.value;
                input.focus();
                // 自动调整高度
                input.style.height = 'auto';
                input.style.height = input.scrollHeight + 'px';
            }
        });
        vscode.postMessage({ type: 'webviewLoaded' });
    </script>
</body>
</html>`;
    }
    // --- 【新增】持久化存储：获取历史文件路径 ---
    private getHistoryPath(): string | undefined {
        if (!vscode.workspace.workspaceFolders) return undefined;
        return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.opengravity', 'session_history.json');
    }

    // --- 【新增】持久化存储：保存当前对话到硬盘 ---
    private saveSessionToDisk() {
        const historyPath = this.getHistoryPath();
        if (historyPath) {
            try {
                // 只保存 _apiMessages，因为它可以推导出 UI 历史
                fs.writeFileSync(historyPath, JSON.stringify(this._apiMessages, null, 2), 'utf-8');
            } catch (e) {
                console.error('Failed to save session:', e);
            }
        }
    }

    // --- 【新增】持久化存储：从硬盘加载对话 ---
    private loadSessionFromDisk() {
        const historyPath = this.getHistoryPath();
        if (historyPath && fs.existsSync(historyPath)) {
            try {
                const data = fs.readFileSync(historyPath, 'utf-8');
                this._apiMessages = JSON.parse(data);
            } catch (e) {
                console.error('Failed to load session:', e);
                this._apiMessages = []; // 如果文件坏了，就重置
            }
        }
    }
}