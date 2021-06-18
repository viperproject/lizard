import * as vscode from 'vscode'
import { DebuggerPanel } from './DebuggerPanel'
import { viperApi } from './extension'
import { Logger, LogLevel } from './logger'
import { GraphModel } from './Models'
import { Session } from './Session'

export namespace Lizard {

    var debugSession: Session | undefined = undefined
    var panel: DebuggerPanel | undefined = undefined
    var sessionCounter = 0

    export function stop() {
        if (panel) panel!.dispose()
    }

    export function start(context: vscode.ExtensionContext, activeEditor: vscode.TextEditor) {
        Logger.setLogLevel(LogLevel.DEBUG)
        Logger.debug(`Created namespace Lizard.`)
        
        viperApi.registerServerMessageCallback('program_definitions', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'program_definitions'`)
            
            debugSession = new Session(viperApi.getBackendName())
            debugSession.setProgramDefs(message.msg_body.definitions)
        
            if (panel) panel!.dispose()
            panel = new DebuggerPanel(context.extensionPath)
            panel.reveal()
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
            
            Logger.info(`↓↓↓ Starting debug session №${++sessionCounter} ↓↓↓`)

            // Step 1 -- preprocessing
            debugSession!.parseModel(counterexample.model!)
            panel!.emitRawModel(debugSession!.model!)
            Logger.info(`✓ parsed raw SMT model`)
            try {
                debugSession!.preProcessRawModel()
            } catch (error) {
                Logger.error(`Session.preProcessRawModel() reached an exceptional situation: ${error}`)
                return 
            }
            Logger.info(`✓ preprocessed the raw model`)

            // Step 2 -- 
            let graphModel: GraphModel
            try {
                graphModel = debugSession!.produceGraphModel()
            } catch (error) {
                Logger.error(`Session.produceGraphModel() reached an exceptional situation: ${error}`)
                return 
            }
            
            // Step 3 -- visualization
            panel!.emitRefinedModel(graphModel)

            Logger.info(`✓ prepared the graph model. enjoy!`)
        })
    }
}