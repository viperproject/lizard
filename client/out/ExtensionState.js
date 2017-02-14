'use strict';
const vscode_languageclient_1 = require('vscode-languageclient');
const fs = require('fs');
const path = require('path');
const ViperProtocol_1 = require('./ViperProtocol');
const Log_1 = require('./Log');
const ViperFileState_1 = require('./ViperFileState');
const index_1 = require('vscode-uri/lib/index');
const Helper_1 = require('./Helper');
class State {
    static createState() {
        if (State.instance) {
            return State.instance;
        }
        else {
            this.reset();
            let newState = new State();
            State.instance = newState;
            return newState;
        }
    }
    static setLastActiveFile(uri, editor) {
        this.lastActiveFileUri = uri.toString();
        let lastActiveFile = this.getFileState(uri);
        if (lastActiveFile) {
            lastActiveFile.setEditor(editor);
        }
        return lastActiveFile;
    }
    static getLastActiveFile() {
        return this.getFileState(this.lastActiveFileUri);
    }
    static resetViperFiles() {
        Log_1.Log.log("Reset all viper files", ViperProtocol_1.LogLevel.Info);
        this.viperFiles.forEach(element => {
            element.changed = true;
            element.verified = false;
            element.verifying = false;
            element.decorationsShown = false;
            element.stateVisualizer.completeReset();
        });
    }
    static reset() {
        this.isBackendReady = false;
        this.isDebugging = false;
        this.isVerifying = false;
        this.viperFiles = new Map();
    }
    static checkBackendReady(prefix) {
        if (!this.isBackendReady) {
            Log_1.Log.log(prefix + "Backend is not ready.", ViperProtocol_1.LogLevel.Debug);
        }
        return this.isBackendReady;
    }
    static getVisualizer(uri) {
        let fileState = this.getFileState(uri);
        return fileState ? fileState.stateVisualizer : null;
    }
    ///retrieves the requested file, creating it when needed
    static getFileState(uri) {
        let uriObject;
        let uriString;
        if (typeof uri === "string") {
            uriObject = index_1.default.parse(uri);
            uriString = uri;
        }
        else {
            uriObject = uri;
            uriString = uri.toString();
        }
        if (!Helper_1.Helper.isViperSourceFile(uriString)) {
            return null;
        }
        let result;
        if (!State.viperFiles.has(uriString)) {
            result = new ViperFileState_1.ViperFileState(uriObject);
            State.viperFiles.set(uriString, result);
        }
        else {
            result = State.viperFiles.get(uriString);
        }
        return result;
    }
    startLanguageServer(context, fileSystemWatcher, brk) {
        this.context = context;
        // The server is implemented in node
        let serverModule = this.context.asAbsolutePath(path.join('server', 'server.js'));
        if (!fs.existsSync(serverModule)) {
            Log_1.Log.log(serverModule + " does not exist. Reinstall the Extension", ViperProtocol_1.LogLevel.Debug);
            return;
        }
        // The debug options for the server
        let debugOptions = { execArgv: ["--nolazy", "--debug" + (brk ? "-brk" : "") + "=5556"] };
        // If the extension is launch in debug mode the debug server options are use
        // Otherwise the run options are used
        let serverOptions = {
            run: { module: serverModule, transport: vscode_languageclient_1.TransportKind.ipc },
            debug: { module: serverModule, transport: vscode_languageclient_1.TransportKind.ipc, options: debugOptions }
        };
        // Options to control the language client
        let clientOptions = {
            // Register the server for plain text documents
            documentSelector: ['viper'],
            synchronize: {
                // Synchronize the setting section 'viperSettings' to the server
                configurationSection: 'viperSettings',
                // Notify the server about file changes to .sil or .vpr files contain in the workspace
                fileEvents: fileSystemWatcher
            }
        };
        this.client = new vscode_languageclient_1.LanguageClient('languageServer', 'Language Server', serverOptions, clientOptions, brk);
        Log_1.Log.log("Start Language Server", ViperProtocol_1.LogLevel.Info);
        // Create the language client and start the client.
        this.languageServerDisposable = this.client.start();
        if (!this.client || !this.languageServerDisposable) {
            Log_1.Log.error("LanguageClient is undefined");
        }
    }
    dispose() {
        try {
            return new Promise((resolve, reject) => {
                Log_1.Log.log("Ask language server to shut down.", ViperProtocol_1.LogLevel.Info);
                this.client.sendRequest(ViperProtocol_1.Commands.Dispose, null).then(() => {
                    Log_1.Log.log("Language server has shut down, terminate the connection", ViperProtocol_1.LogLevel.Info);
                    this.languageServerDisposable.dispose();
                    resolve();
                });
            });
        }
        catch (e) {
            Log_1.Log.log("Error disposing state: " + e);
        }
    }
    static checkOperatingSystem() {
        if ((this.isWin ? 1 : 0) + (this.isMac ? 1 : 0) + (this.isLinux ? 1 : 0) != 1) {
            Log_1.Log.error("Cannot detect OS");
            return;
        }
        if (this.isWin) {
            Log_1.Log.log("OS: Windows", ViperProtocol_1.LogLevel.Debug);
        }
        else if (this.isMac) {
            Log_1.Log.log("OS: OsX", ViperProtocol_1.LogLevel.Debug);
        }
        else if (this.isLinux) {
            Log_1.Log.log("OS: Linux", ViperProtocol_1.LogLevel.Debug);
        }
    }
}
State.isWin = /^win/.test(process.platform);
State.isLinux = /^linux/.test(process.platform);
State.isMac = /^darwin/.test(process.platform);
exports.State = State;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0ZW5zaW9uU3RhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvRXh0ZW5zaW9uU3RhdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsWUFBWSxDQUFDO0FBQ2Isd0NBQW9GLHVCQUF1QixDQUFDLENBQUE7QUFFNUcsTUFBWSxFQUFFLFdBQU0sSUFBSSxDQUFDLENBQUE7QUFDekIsTUFBWSxJQUFJLFdBQU0sTUFBTSxDQUFDLENBQUE7QUFDN0IsZ0NBQW1DLGlCQUFpQixDQUFDLENBQUE7QUFDckQsc0JBQW9CLE9BQU8sQ0FBQyxDQUFBO0FBQzVCLGlDQUErQixrQkFBa0IsQ0FBQyxDQUFBO0FBQ2xELHdCQUFnQixzQkFBc0IsQ0FBQyxDQUFBO0FBQ3ZDLHlCQUF1QixVQUFVLENBQUMsQ0FBQTtBQUdsQztJQWVJLE9BQWMsV0FBVztRQUNyQixFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUNqQixNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQztRQUMxQixDQUFDO1FBQUMsSUFBSSxDQUFDLENBQUM7WUFDSixJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDYixJQUFJLFFBQVEsR0FBRyxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQzNCLEtBQUssQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1lBQzFCLE1BQU0sQ0FBQyxRQUFRLENBQUM7UUFDcEIsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFjLGlCQUFpQixDQUFDLEdBQThCLEVBQUUsTUFBeUI7UUFDckYsSUFBSSxDQUFDLGlCQUFpQixHQUFHLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUN4QyxJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzVDLEVBQUUsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUM7WUFDakIsY0FBYyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FB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