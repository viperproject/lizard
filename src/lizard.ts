import * as vscode from 'vscode'
import { DebuggerPanel } from './DebuggerPanel'
import { DotGraph, RenderOpts } from './DotGraph'
import { viperApi } from './extension'
import { Logger, LogLevel } from './logger'
import { GraphModel } from './Models'
import { Query } from './Query'
import { Session, SessionOpts } from './Session'
import { ViperLocation } from "./ViperAST"

export namespace Lizard {

    var session: Session | undefined = undefined
    var panel: DebuggerPanel | undefined = undefined
    var sessionCounter = 0
    const lizardOpts: RenderOpts & SessionOpts = {
        is_carbon: false,
        is_carbon_type_encoding_a: false,
        rankdir_lr: false,
        dotnodes: false,
    }

    export function stop() {
        if (panel) panel!.dispose()
    }

    export function start(context: vscode.ExtensionContext, activeEditor: vscode.TextEditor) {
        Logger.setLogLevel(LogLevel.DEBUG)
        Logger.debug(`Created namespace Lizard.`)

        viperApi.registerServerMessageCallback('backend_configuration', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'backend_configuration'`)

            lizardOpts.is_carbon = viperApi.getBackendName().toLowerCase().includes('carbon')
            if (lizardOpts.is_carbon) {
                lizardOpts.is_carbon_type_encoding_a = message.msg_body.stages[0].customArguments.toLowerCase().includes('/typeencoding:a')
            } else {
                lizardOpts.is_carbon_type_encoding_a = false
            }

            Logger.debug(`inferred Lizard configuration: ${JSON.stringify(lizardOpts)}`)
        })
        
        viperApi.registerServerMessageCallback('program_definitions', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'program_definitions'`)
            
            session = new Session(lizardOpts)
            session.parseProgramDefinitions(message.msg_body.definitions)

            // Initialize rendering options
            lizardOpts.is_carbon = session.isCarbon()
        
            if (panel) panel!.dispose()
            panel = new DebuggerPanel(context.extensionPath, handleQuery, 
                handleToggleGraphRankDirRequest, handleToggleGraphDotNodesRequest)
            panel.reveal()
        })

        function tryProducingGraphModel(query?: Query, 
                                        onError?: (error: any) => void): GraphModel | undefined {
            let model_maybe: GraphModel | undefined
            try {
                if (query) {
                    model_maybe = session!.applyQuery(query)
                } else {
                    model_maybe = session!.produceGraphModel()
                }
            } catch (error) {
                Logger.error(`Session.produceGraphModel() reached an exceptional situation: ${error}`)
                if (onError) {
                    onError(error)
                }
            }
            return model_maybe
        }

        function tryRenderGraph(graph_model: GraphModel): boolean {
            let dot_graph: DotGraph
            try {
                dot_graph = new DotGraph(graph_model, lizardOpts)
            } catch (error) {
                Logger.error(`DotGraph() reached an exceptional situation: ${error}`)
                return false
            }
            try {
                panel!.renderGraph(dot_graph)
            } catch (error) {
                Logger.error(`DebuggerPanel.renderGraph() reached an exceptional situation: ${error}`)
                return false
            }
            return true
        }

        function render(model?: GraphModel): void {
            let m = model ? model : session!.getLatestModel()
            let outcome = tryRenderGraph(m)
            if (outcome) {
                Logger.info(`✅ rendered the graph model. enjoy!`)
            } else {
                Logger.info(`❌ graph rendering failed`)
            }
        }

        function handleQuery(query: Query) {
            let graph_model = tryProducingGraphModel(query)
            if (!graph_model) return 

            panel!.emitRefinedModel(graph_model)
            Logger.info(`✓ processed query ${JSON.stringify(query)}`)

            render(graph_model)
        }

        function handleToggleGraphRankDirRequest() {
            Logger.info(`✓ processed toggle-rankdir request`)
            lizardOpts.rankdir_lr = !(lizardOpts.rankdir_lr)
            render()
        }

        function handleToggleGraphDotNodesRequest() {
            Logger.info(`✓ processed toggle-dotnodes request`)
            lizardOpts.dotnodes = !(lizardOpts.dotnodes)
            render()
        }
        
        viperApi.registerServerMessageCallback('verification_result', (messageType: string, message: any) => {
            Logger.debug(`recieved message of type 'verification_result'`)
            let errors = message.msg_body.details.result.errors
            if (errors.length === 0) {
                Logger.info(`message does not contain any verification errors; nothing to debug`)
                return    
            }
            if (errors.length > 1) {
                Logger.warn(`multiple verification errors; picking the first counterexample...`)
            } 
            let counterexample = errors[0].counterexample
            let error_location = errors[0].position.start
            let error_file = errors[0].position.file

            session!.setErrorLocation(new ViperLocation(error_location, error_file))
            
            Logger.info(`↓↓↓ Starting debug session №${++sessionCounter} for error on ${error_location} ↓↓↓`)

            // Step 1 -- preprocessing
            session!.parseModel(counterexample.model!)
            panel!.emitRawModel(session!.model!)
            Logger.info(`✓ parsed raw SMT model`)
            try {
                session!.preProcessRawModel()
            } catch (error) {
                Logger.error(`Session.preProcessRawModel() reached an exceptional situation: ${error}`)
                return 
            }
            panel!.listProgramStates(session!.states!)

            Logger.info(`✓ preprocessed the raw model`)

            // Step 2 -- model refinement
            let graph_model = tryProducingGraphModel()
            if (graph_model === undefined) {
                Logger.info(`visualization interrupted because a graph model could not be produced`)
                return
            }
            panel!.emitRefinedModel(graph_model)
            Logger.info(`✓ prepared the graph model`)
            
            // Step 3 -- visualization
            render(graph_model)
        })
    }
}