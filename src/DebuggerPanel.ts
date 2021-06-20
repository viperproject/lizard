import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { GraphModel } from './Models'
import { DotGraph } from './DotGraph'

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

    constructor(readonly extensionPath: string) {
        this.panel = vscode.window.createWebviewPanel(
            'viperDebugPanel',
            "Viper Debugger",
            vscode.ViewColumn.Two,
            DebuggerPanel.webviewOptions
        )
        this.panel.webview.html = DebuggerPanel.loadWebviewContent(this.extensionPath)
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

    public reveal() {
        this.panel.reveal()
    }

    public dispose() {
        this.panel.dispose()
    }
}

