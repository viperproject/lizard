import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { GraphModel, State } from './Models'
import { DotGraph } from './DotGraph'
import { Logger } from './logger'
import { Query } from './Query'

export class DebuggerPanel {

    private static webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions = {
        enableFindWidget: true,
        retainContextWhenHidden: true,
        enableScripts: true,
        enableCommandUris: true
    }

    private static loadWebviewContent(extensionPath: string) {
        let htmlPath = path.join(extensionPath, 'out/panel/debugger.html')
        let content = fs.readFileSync(htmlPath).toString()

        // We now know where we are running, we can replace all the temporary paths
        // in the HTML document with the actual extension path.
        return content.replace(/\{\{root\}\}/g, 'vscode-resource:' + extensionPath + '/')
    }

    private panel: vscode.WebviewPanel

    constructor(readonly extensionPath: string,
                readonly queryHandler: (q: Query) => any,
                readonly toggleGraphRankDir: () => any) {

        this.panel = vscode.window.createWebviewPanel(
            'viperDebugPanel',
            "Viper Debugger",
            vscode.ViewColumn.Two,
            DebuggerPanel.webviewOptions
        )
        this.panel.webview.onDidReceiveMessage((m) => {
            this.handleMessageFromPanel(m)
        })
        this.panel.webview.html = DebuggerPanel.loadWebviewContent(this.extensionPath)
    }
    
    public reveal() {
        this.panel.reveal()
    }

    public dispose() {
        this.panel.dispose()
    }

    public emitRawModel(model: any) {
        this.panel.webview.postMessage({
            type: 'rawModelMessage',
            text: model
        })
    }

    public emitRefinedModel(model: GraphModel) {
        this.panel.webview.postMessage({
            type: 'logModel',
            text: model
        })
    }

    public renderGraph(graph: DotGraph) {
        this.panel.webview.postMessage({
            type: 'renderDotGraph',
            text: graph.dotEncoding()
        })
    }

    public listProgramStates(states: Array<State>) {
        this.panel.webview.postMessage({
            type: 'programStates',
            text: states
        })
    }

    private handleMessageFromPanel(message: any) {
        switch (message.command) { 
            case 'filterStates': 
                let state_names: Array<string> = message.state_names
                this.queryHandler(new Query(state_names))
                break 

            case 'toggleRankDir': 
                this.toggleGraphRankDir()
                break

            default:
                Logger.error(`Unknown command from debug pane: '${message}'`);
        }
    }

}

