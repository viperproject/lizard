import * as vscode from 'vscode'
import { Lizard } from './Lizard'

/** The API exported by the "main" Viper extension.
 *  
 *  It allows listening for verification events.
 */
export var viperApi: any

export function activate(context: vscode.ExtensionContext) {
	
	console.log('The Lizard is active.')

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

export function deactivate() {
	Lizard.stop()
}
