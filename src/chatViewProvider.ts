import * as vscode from 'vscode';
import { loadSystemPrompt } from './utils/promptLoader';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'opengravity.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getAIProvider: () => any
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 监听来自前端的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'userInput': {
                    const provider = this._getAIProvider();
                    
                    if (!provider) {
                        webviewView.webview.postMessage({ type: 'error', value: 'API Key 没配呢，去设置里看看？' });
                        return;
                    }

                    try {
                        // 1. 获取 System Prompt (真相来源)
                        const systemPrompt = await loadSystemPrompt();
                        // 2. 调用 AI
                        const response = await provider.generateContent(data.value, systemPrompt);
                        // 3. 返回结果
                        webviewView.webview.postMessage({ type: 'aiResponse', value: response });
                    } catch (err: any) {
                        webviewView.webview.postMessage({ type: 'error', value: err.message });
                    }
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body { background: transparent; color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 10px; }
        #chat-container { display: flex; flex-direction: column; height: 100vh; }
        #messages { flex-grow: 1; overflow-y: auto; margin-bottom: 10px; }
        .msg { margin-bottom: 12px; padding: 8px; border-radius: 4px; line-height: 1.4; word-wrap: break-word; }
        .user { background: var(--vscode-button-secondaryBackground); align-self: flex-end; margin-left: 20px; }
        .ai { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); margin-right: 20px; }
        .loading { font-style: italic; opacity: 0.7; font-size: 0.8em; }
        textarea { 
            width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border); border-radius: 4px; resize: none; padding: 8px;
            box-sizing: border-box;
        }
        pre { background: rgba(0,0,0,0.2); padding: 8px; overflow-x: auto; border-radius: 4px; }
        code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
    <div id="chat-container">
        <div id="messages"></div>
        <textarea id="input" rows="3" placeholder="问问 Opengravity... (Ctrl+Enter 发送)"></textarea>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const messagesDiv = document.getElementById('messages');
        const inputArea = document.getElementById('input');

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            if (role === 'ai') {
                div.innerHTML = marked.parse(text);
            } else {
                div.textContent = text;
            }
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            return div;
        }

        function send() {
            const text = inputArea.value.trim();
            if (!text) return;
            
            appendMsg('user', text);
            const loadingDiv = appendMsg('ai loading', 'Thinking...');
            
            vscode.postMessage({ type: 'userInput', value: text });
            inputArea.value = '';

            // 存一下这个 loading 节点的引用，方便一会儿替换它
            window.currentLoadingDiv = loadingDiv;
        }

        inputArea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (window.currentLoadingDiv) {
                window.currentLoadingDiv.remove();
                window.currentLoadingDiv = null;
            }

            if (message.type === 'aiResponse') {
                appendMsg('ai', message.value);
            } else if (message.type === 'error') {
                appendMsg('ai', '❌ Error: ' + message.value);
            }
        });
    </script>
</body>
</html>`;
    }
}