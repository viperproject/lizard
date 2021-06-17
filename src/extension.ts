// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { Lizard } from './Lizard'

/** The API exported by the "main" Viper extension.
 *  
 *  It allows listening for verification events.
 */
export var viperApi: any

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	console.log('The Lizard is active.')

	// vscode.window.showInformationMessage('Hello World from Lizard!');

	let viper = vscode.extensions.getExtension('viper-admin.viper')
	if (viper && viper.isActive) {
        viperApi = viper.exports

		Lizard.start(context, vscode.window.activeTextEditor!)
    } else {
		let msg = "Could not retrieve the Viper API when starting the debugger extension!"
        vscode.window.showErrorMessage(msg);
        deactivate()
    }
	
}

// this method is called when your extension is deactivated
export function deactivate() {
	Lizard.stop()
}
