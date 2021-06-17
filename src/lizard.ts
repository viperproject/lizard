import * as vscode from 'vscode'
import { DebuggerPanel } from './DebuggerPanel'
import { viperApi } from './extension'
import { Logger, LogLevel } from './logger'
import { Session } from './Session'

export namespace Lizard {

    var debugSession: Session
    var panel: DebuggerPanel

    export function stop() {
        panel.dispose()
    }

    export function start(context: vscode.ExtensionContext, activeEditor: vscode.TextEditor) {
        Logger.setLogLevel(LogLevel.DEBUG)
        Logger.debug(`Created namespace Lizard.`)

        panel = new DebuggerPanel(context.extensionPath)
        panel.reveal()
        
        viperApi.registerServerMessageCallback('program_definitions', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'program_definitions'`)
            debugSession = new Session(viperApi.getBackendName())
            debugSession.setProgramDefs(message.msg_body.definitions)
        })
        
        viperApi.registerServerMessageCallback('verification_result', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'verification_result'`)
            let errors = message.msg_body.details.result.errors
            if (errors.length === 0) {
                Logger.error(`message must contain verification errors`)
                return    
            }
            if (errors.length > 1) {
                Logger.info(`multiple verification errors; picking the first counterexample...`)
            } 
            let counterexample = errors[0].counterexample
            
            // Step 1 -- preprocessing
            debugSession.parseModel(counterexample.model!)
            panel.emitRawModel(debugSession.model!)
            debugSession.preProcessRawModel()

            // Step 2 -- refinement
            let graphModel = debugSession.produceGraphModel()

            // Step 3 -- visualization
            panel.emitRefinedModel(graphModel)
        })
    }
}