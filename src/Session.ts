import { Logger } from "./logger"
import { PolymorphicTypes, getConstantEntryValue, ApplicationEntry, Model, Atom, State, Relation, EquivClasses, GraphModel, ConstantEntry, ModelEntry, MapEntry, Graph, GraphNode, isRef, isSetOfRefs, ViperType, LocalRelation, isInt, isBool, isPerm, isNull, Status, SmtBool, castToSmtBool, castToMapEntry, NodeClass, NodeSet, PrimitiveTypes } from "./Models"
import { Query } from "./Query"
import { collect } from "./tools"
import { Type, TypedViperDefinition, ViperDefinition, ViperLocation } from "./ViperAST"
import { ViperTypesProvider } from "./ViperTypesProvider"

export interface SessionOpts {
    is_carbon: boolean
    is_carbon_type_encoding_a: boolean
}

const wildcard = undefined


export class Session {
    public programDefinitions: Array<ViperDefinition> | undefined = undefined
    public errorLocation: ViperLocation | undefined = undefined   // e.g. "30:22" meaning line 30, column 22
    public model: Model | undefined = undefined

    private getEntriesViaRegExp(pattern: RegExp): Array<[string, ModelEntry]> {
        return Object.entries(this.model!).filter(pair => pattern.test(pair[0]))
    }

    public isSilicon(): boolean {
        return !this.opts.is_carbon
    }
    public isCarbon(): boolean {
        return this.opts.is_carbon
    }

    // private is_carbon_type_enc_a: boolean | undefined = undefined
    public isCarbonTypeEncodingA(): boolean {
        return this.opts.is_carbon && this.opts.is_carbon_type_encoding_a
    }

    public isCarbonTypeEncodingP(): boolean {
        return this.opts.is_carbon && !this.opts.is_carbon_type_encoding_a
    }

    private viperTypes: ViperTypesProvider | undefined = undefined
    
    constructor(public opts: SessionOpts, 
                private __next_node_id = 0) {}

    private freshNodeId(): number {
        let next_node_id = this.__next_node_id
        this.__next_node_id ++
        return next_node_id
    }

    private mkAtom(name: string, innerval: string, is_local: boolean, 
                   type: ViperType | undefined = undefined, 
                   states: Array<State> = []): Atom {

        const id = this.freshNodeId()
        
        if (type === undefined) {
            // If type is not provided, try to retrieve it from available program definitions
            type = this.viperTypes!.get(name)
            if (!type) {
                // Fallback to Other type
                Logger.warn(`no type information for ${name} = ${innerval}`)
                type = PolymorphicTypes.Other(innerval)
            }
        }
        
        let protoName = this.innerToProto(name)
        return new Atom(type, id, innerval, is_local, protoName, states)
    }

    // static myRelations = ['[2]', '[3]', '[4:=]', 
    //                       'exists_path_', 'exists_path', 
    //                       'edge_', 'edge', '$$', '$$\'']

    public parseProgramDefinitions(pds: Array<any>): void {
        this.programDefinitions = pds.map(pd => {
            let file = pd.location.file
            let loc = ViperLocation.from(pd.location.start, file)
            let scopeStart: ViperLocation | 'global' = 
                (pd.scopeStart === 'global') ? 'global' : ViperLocation.from(pd.scopeStart, file)
            let scopeEnd: ViperLocation | 'global' = 
                (pd.scopeEnd === 'global') ? 'global' : ViperLocation.from(pd.scopeEnd, file)
            
            if (pd.type.hasOwnProperty('viperType')) {
                let typ = { name: pd.type.name, viperType: <Type> pd.type.viperType }
                let new_def = new TypedViperDefinition(pd.name, loc, scopeStart, scopeEnd, typ)
                return new_def
            } else {
                let typ = { name: pd.type.name }
                let new_def = new ViperDefinition(pd.name, loc, scopeStart, scopeEnd, typ)
                return new_def
            }
        })
    }

    public setErrorLocation(error_location: ViperLocation): void {
        this.errorLocation = error_location
    }

    public parseModel(m: Model): void {
        if (!(typeof m === 'object' && m !== null)) {
            Logger.error(`model must be a JavaScript object`)
            return
        }
        var valid_model = true

        // check model
        Object.entries(m).forEach(entry => {
            let key = entry[0]
            let value = entry[1]
            if (!(typeof value === 'object' && value !== null)) {
                Logger.error(`model entry values must be objects`)
                valid_model = false
                return
            }
            if (!value.hasOwnProperty('type')) {
                Logger.error(`model entry values must be objects with field 'type'`)
                valid_model = false
                return
            }
            valid_model = true
        })

        // save model 
        if (valid_model) {
            this.model = <Model> m
        } else {
            Logger.info(`model not updated sinse there were failed sanity checks`)
        }
    }

    private atoms: Array<Atom> | undefined = undefined
    public states: Array<State> | undefined = undefined 
    private extended_equiv_classes = new EquivClasses()
    private transitive_nodes = new NodeSet()

    private latestQuery: GraphModel | undefined = undefined 
    private graphModel: GraphModel | undefined = undefined

    public getLatestModel(): GraphModel {
        if (this.latestQuery !== undefined) {
            return this.latestQuery
        } else {
            return this.graphModel!
        }
    }

    private null_node: GraphNode | undefined = undefined

    static unary_ops = new Set<string>(['-', '+', '!'])
    static binary_ops = new Set<string>(['-', '+', '*', '/', 'and', 'or'])

    static serializeEntryValue(entry: ModelEntry): string {
        if (entry.type === 'constant_entry') {
            return (<ConstantEntry> entry).value
        } else if (entry.type === 'application_entry') { 
            let app_entry = (<ApplicationEntry> entry)
            let fun = app_entry.value.name
            let args = app_entry.value.args
            if (args.length === 1 && Session.unary_ops.has(fun)) {
                // Unary function
                return fun + Session.serializeEntryValue(args[0])
            } else if (args.length === 2 && Session.binary_ops.has(fun)) {
                // Binary function
                return Session.serializeEntryValue(args[0]) + fun + Session.serializeEntryValue(args[1])
            } else {
                // Other function
                return `${fun}(${args.map(arg => Session.serializeEntryValue(arg)).join(', ')})`
            }
        } else {
            throw `serialization of map entry values is not supported`
        }
    }

    public preProcessRawModel(): void {
        // 0. Collect type information
        this.viperTypes = new ViperTypesProvider(this.programDefinitions!, 
            // e.g. "X@1" is an inner name for the prototype "X"
            (innername: string) => Session.innerToProto(this.isCarbon(), innername))
        
        this.setNull()
        
        // 1. Collect program states and merge the potential aliases among them
        this.states = this.collectStates()

        // 2. If the program is instrumented with a $state(G:Set[Ref], state_id:Int) function, 
        //    remap the states to those that have explicit labels
        this.states = this.remapStates(this.states)

        // 3. Extract all atoms (i.e. top-level constant_entries) from the raw model. 
        this.atoms = new Array<Atom>()
        Object.entries(this.model!).forEach(pair => {
            let name = pair[0]
            let entry = pair[1]
            
            if (entry.type === 'constant_entry' || entry.type == 'application_entry') {
                let innerval = Session.serializeEntryValue(entry)
                let node = this.mkAtom(name, innerval, true)
                this.atoms!.push(node)
            }
        })

        // 3. Compute equivalence classes amongst all atoms
        Session.collectEquivClasses(this.atoms!, this.extended_equiv_classes)
    }

    private equiv_classes = new EquivClasses()

    private static collectEquivClasses(nodes: Array<Atom>, ec: EquivClasses): void {
        nodes.forEach(node => {
            let key: [string, ViperType] = [node.val, node.type]
            if (ec.has(...key)) {
                ec.get(...key)!.push(node)
            } else {
                ec.set(...key, new Array(node))
            }
        })
    }

    private collectLocalStoreVars(): Array<Atom> | undefined {
        let res = new Map<string, Atom>()  // from node's (name, state) to node

        // Entry example: "$local$a$2" -> 22
        let localEntris = Object.entries(this.model!).filter(pair => pair[0].startsWith('$local'))

        if (localEntris.length === 0) {
            Logger.warn(`Did not find local variable instrumentation; proceeding with a best-effort approach`)
            return undefined 
        }

        // Map states by labels 
        let states = new Map<string, Array<State>>()
        this.states!.forEach(state => {
            state.names.forEach(label => {
                if (states.has(label)) {
                    states.get(label)!.push(state)
                } else {
                    states.set(label, new Array(state))
                }
            })
        })

        localEntris.forEach(pair => {
            let name = pair[0]
            let entry = pair[1]
            let m = name.match(/^\$local\$(.*)\$(\d+)$/)
            if (m === null || m === undefined) {
                throw `cannot parse local store instumentation emtry name '${name}' (expected e.g. '$local$a$2')`
            }
            let varName = m[1]
            let stateLabel = m[2]
            let val = Session.serializeEntryValue(entry)
            
            let lblName = `l${stateLabel}`
            let statesForThisVar = states.get(lblName)
            if (statesForThisVar === undefined) {
                throw `broken instrumentation: no heap states specified in the model for label ${lblName}`
            }

            let key = [varName, statesForThisVar.map(s => s.hash()).join('/')].join('///')

            if (!res.has(key)) {
                // Add corresponding atom to model
                let type = this.viperTypes!.get(varName)
                let atom = this.mkAtom(varName, val, true, type, statesForThisVar)
                this.atoms!.push(atom)
                res.set(key, atom)
            }
        })

        return Array.from(res.values())
    }

    private collectInitialGraphsAndNodes(best_effort: boolean): Array<Atom> {
        
        let names: Array<string> 
        if (best_effort) {
            names = this.getDefinitionNames('Argument')
                    .concat(this.getDefinitionNames('Local'))
                    .concat(this.getDefinitionNames('Return'))
        } else {
            // Normal mode, in case the program was properly instrumented
            names = this.getDefinitionNames('Argument')
        }

        let atoms = names.flatMap(proto => 
            this.atoms!.filter(atom => {
                let atom_name = atom.proto
                return this.isPrototypeOf(proto, atom_name)
            }))

        if (atoms.length < names.length) {
            Logger.error(`could not find some atom definitions in raw model;\n` + 
                         ` names: ${names.join(', ')}\n` + 
                         ` atoms: ${atoms.map(a => a.repr()).join(', ')}`)
        }

        return atoms
    }

    // map from inner values to nodes
    private nonAliasingNodesMap = new NodeSet()
    
    private mergeAliases(nodes: Array<Atom>): Array<NodeClass> {
        let eq = EquivClasses.from(nodes)
        return eq.toNodeClassArray(() => this.freshNodeId())
    }

    private mergeClasses(nodes: Array<NodeClass>): Array<NodeClass> {
        let freshNodes = this.nonAliasingNodesMap.merge(nodes)
        return freshNodes
    }

    private collectReach(nodes: Array<GraphNode>): Array<LocalRelation> {
        let reach_rel_names = this.reachabilityRelationNames()
        
        // Extract reachability relations which are present in the model
        let useful_rels = reach_rel_names.filter(rel_name => {
            let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
            return rel_maybe !== undefined
        })

        let reach_rels = new Set<LocalRelation>()
        useful_rels.forEach(rel_name => 
            this.graphs.forEach(graph => 
                nodes.forEach(pred_node => 
                    nodes.forEach(succ_node => {
                        let state_to_rels = this.collectReachInfo(rel_name, graph, pred_node, succ_node)
                        this.states!.forEach(state => 
                            state.innervals.forEach(state_innerval => {
                                let [is_reachable, status] = state_to_rels(state_innerval)
                                if (is_reachable !== 'unspecified') {
                                    let r = (is_reachable === 'true') ? 'P' : '¬P'
                                    let new_rel = new LocalRelation(r, state, graph.id, pred_node.id, succ_node.id, status)
                                    reach_rels.add(new_rel)
                                }
                            }))
                    }))))

        return Array.from(reach_rels)
    }
 
    private collectFields(nodes: Array<GraphNode>): Array<Relation> {
        let fnames = this.getDefinitionNames('Field')

        // Extract fields which are present in the model
        let useful_fields = fnames.filter(fname => {
            let rel_name = this.fieldLookupRelationName(fname)
            let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
            return rel_maybe !== undefined
        })

        // Deduce relations for each field, node, state
        let field_relations = useful_fields.flatMap(fname => 
            this.states!.flatMap(state => {
                let activeNodes = nodes.filter(node => 
                    node.aliases.find(atom => atom.states.length === 0 || atom.states.includes(state)) !== undefined)
                let rels = activeNodes.flatMap(node => {
                    let state_to_rels = this.collectFieldValueInfo(node, fname)
                    if (state.innervals.length !== 1) {
                        throw `state innervals must be unique (${state.nameStr()} has ${state.innervals.join(', ')})`
                    }
                    let [adj_node, status] = state_to_rels(state)
                    if (adj_node === undefined) {
                        return []
                    } else {
                        if (this.nonAliasingNodesMap.has(adj_node.val, adj_node.type)) {
                            // merge 
                            let oldSucc = this.nonAliasingNodesMap.get(adj_node.val, adj_node.type)!
                            oldSucc.aliases.push(...adj_node.aliases)
                            adj_node = oldSucc
                        } else if (this.transitive_nodes.has(adj_node.val, adj_node.type)) {
                            // transitive node already built on this iteration
                            let oldSucc = this.transitive_nodes.get(adj_node.val, adj_node.type)!
                            oldSucc.aliases.push(...adj_node.aliases)
                            adj_node = oldSucc
                        } else {
                            // new transitive node
                            this.transitive_nodes.add(adj_node)
                        }
                        let new_rel = new Relation(fname, state, node.id, adj_node.id, status)
                        node.fields.push(new_rel)
                        return [new_rel]
                    }
                })
                return rels
            }))

        return field_relations
    }

    private connectNodesToGraphs(nodes: Array<GraphNode>, graphs: Array<Graph>): void {
        let rel_name = this.setIncludesRelationName()
        let rel = this.getEntryByName(rel_name)
        if (rel === undefined) {
            Logger.warn(`the model does not contain the expected relation '${rel_name}'`)
            return
        }
        graphs.forEach(graph => {
            nodes.forEach(node => {
                let [val, status] = this.applySetInMapEntry(rel!, graph.val, node.val)
                if (this.parseInnervalAsSmtBool(val) === 'true') {
                    // this node belongs to this graph class
                    graph.addNode(node, status)
                }
            })
        })
    }

    private node_hash = new Map<number, GraphNode>()
    private graph_hash = new Map<number, Graph>()

    private graphs = new Array<Graph>()
    private footprints: {'client': Array<Graph>, 'callee': Array<Graph>} | undefined = undefined
    
    private graph_nodes = new Array<GraphNode>()
    private scalar_nodes = new Array<NodeClass>()
    private fields = new Array<Relation>()
    private reach = new Array<LocalRelation>()

    private getNodeById(id: number): GraphNode {
        let node = this.node_hash.get(id)
        if (node === undefined) {
            throw `cannot find node with ID ${id}`
        }
        return node
    }

    private getGraphById(id: number): Graph {
        let graph = this.graph_hash.get(id)
        if (graph === undefined) {
            throw `cannot find graph with ID ${id}`
        }
        return graph
    }

    private produceGraphModelRec(startingNodeClasses: Array<NodeClass>, iteration=1): void {
        Logger.info(`iteration №${iteration} of analyzing the heap model`)

        // B. Deduce and merge aliasing nodes 
        let new_nonaliasing_nodes = this.mergeClasses(startingNodeClasses)

        // A. Update hash s.t. nodes can be retrieved efficiently, via their IDs
        // new_nonaliasing_nodes.forEach(node => {
            // if (this.node_hash.has(node.id)) {
            //     throw `saturation error: node with ID ${node.id} is already present in the node hash`
            // }
            // this.node_hash.set(node.id, node)
        // })

        // C. Group nodes by type: Ref, Set[Ref], Others
        //    Keep only the latest version of client and callee footprints
        let new_graph_nodes = new Array<GraphNode>()
        let nullNode: GraphNode | undefined = undefined
        new_nonaliasing_nodes.forEach(nodeClass => {
            if (nodeClass.type && isRef(nodeClass.type)) {
                let isNull = this.isValNull(nodeClass.val)
                let graphNode = GraphNode.from(nodeClass, isNull)
                if (isNull) {
                    let nullAtom = this.mkNullAtom()
                    graphNode.aliases.push(nullAtom)
                    nullNode = graphNode
                }
                new_graph_nodes.push(graphNode)
                if (this.node_hash.has(graphNode.id)) {
                    throw `saturation error: node with ID ${graphNode.id} is already present in the node hash`
                }
                this.node_hash.set(graphNode.id, graphNode)
            } else if (nodeClass.type && isSetOfRefs(nodeClass.type)) {
                let graphClass = Graph.from(nodeClass)
                this.graphs.push(graphClass)
                if (this.graph_hash.has(graphClass.id)) {
                    throw `saturation error: graph with ID ${graphClass.id} is already present in the graph hash`
                }
                this.graph_hash.set(graphClass.id, graphClass)
            } else {
                this.scalar_nodes.push(nodeClass)
            }
        })

        // Define Null Node
        if (nullNode === undefined) {
            nullNode = this.mkNullNode()
            new_graph_nodes.push(nullNode)
        } 

        this.graph_nodes.push(...new_graph_nodes)

        // D. Determine which Ref-based nodes belong to which graphs (i.e. Set[Ref]-based nodes)
        this.connectNodesToGraphs(new_graph_nodes, this.graphs)

        // E. Collect information about fields  
        let non_null_nodes = new_graph_nodes.filter(n => !n.isNull)
        let new_fields = this.collectFields(non_null_nodes)
        this.fields.push(...new_fields)

        // F. Some of the relations may lead to new nodes that must be encountered for in the model. 
        let trans_nodes = this.transitive_nodes.getNodeClasses()
        this.transitive_nodes = new NodeSet()

        // G. Saturate! 
        if (trans_nodes.length > 0) {
            this.produceGraphModelRec(trans_nodes, iteration+1)
        } else {
            Logger.info(`🎩 saturation completed 🎩`)
        }
    }

    private static extractFootprints(graphs: Array<Graph>): {callee: Array<Graph>, client: Array<Graph>} {
        let result = {callee: new Array<Graph>(), client: new Array<Graph>()}
        graphs.forEach(graph => {
            if (graph.aliases.find(a => a.proto === 'G') !== undefined) {
                result.client.push(graph)
            } else if (graph.aliases.find(a => a.proto === 'H') !== undefined) {
                result.callee.push(graph)
            }
        })
        return result
    }

    private static transitiveClosure(state: State, rels: Array<Relation>): Set<Relation> {
        // Make sure we keep one copy of each relation
        let closure = new Map<string, Relation>()
        rels.forEach(rel => {
            let root_tc_rel = new Relation('TC', rel.state, rel.pred_id, rel.succ_id)
            closure.set(root_tc_rel.hash(), root_tc_rel)
        })

        while (true) {
            let new_rels = new Map<string, Relation>()
            closure.forEach(rel_a => {
                closure.forEach(rel_b => {
                    if (rel_a.succ_id === rel_b.pred_id) {
                        let trans_rel = new Relation('TC', state, rel_a.pred_id, rel_b.succ_id)
                        new_rels.set(trans_rel.hash(), trans_rel)
                    }
                })
            })
            let found_new_elems = false
            new_rels.forEach((rel, rhash) => {
                if (!closure.has(rhash)) {
                    found_new_elems = true
                    closure.set(rhash, rel)
                }
            })
            if (!found_new_elems) {
                break
            }
        }
        return new Set(closure.values())
    }

    private static computeTransitiveClosure(heap_edges: Array<Relation>): Map<State, Map<string, Relation>> {
        let tc = new Map<State, Map<string, Relation>>()
        
        // Hash heap edges by state
        let heap_edges_in_state = new Map<string, Array<Relation>>()
        let states = new Array<State>()
        heap_edges.forEach(edge => {
            let entry = heap_edges_in_state.get(edge.state.hash())
            if (entry === undefined) {
                heap_edges_in_state.set(edge.state.hash(), new Array(edge))
                states.push(edge.state)
            } else {
                entry.push(edge)
            }
        })

        // Process each state
        states.forEach(state => {
            let tc_for_state = Session.transitiveClosure(state, heap_edges_in_state.get(state.hash())!)
            let rel_map = new Map<string, Relation>()
            tc_for_state.forEach(rel => rel_map.set(rel.hash(), rel))
            tc.set(state, rel_map)
        })

        return tc
    }
    
    private log_reason(rel: Relation, reason: string): void {
        let pred = this.node_hash.get(rel.pred_id)!
        let succ = this.node_hash.get(rel.succ_id)!
        let rel_str = `${rel.name}[ ${rel.state.valStr()} ](${pred.val}, ${succ.val})`
        Logger.info(`removing relation ${rel.repr()} = ${rel_str} because ${reason}`)
    }

    private filter_rel(rel: Relation, is_good: boolean, reason_removed: string): boolean {
        if (!is_good) {
            this.log_reason(rel, reason_removed)
            return false
        } else {
            return true
        }
    }

    private filterReachabilityRelations(raw_reach_rels: Array<LocalRelation>): Array<LocalRelation> {

        // 0. Remove relations that originate from default model cases
        raw_reach_rels = raw_reach_rels.filter(rel => this.filter_rel(rel, rel.status !== 'default', `it originates from one of the default model cases`))

        // 0.5. Remove trivial relation, e.g. P_(G, X, X)
        raw_reach_rels = raw_reach_rels.filter(rel => this.filter_rel(rel, rel.pred_id !== rel.succ_id, `it is trivial`))

        // 1. Remove spurious relations, 
        // e.g. $P(A, x, y)$ where $x \notin A$
        raw_reach_rels = raw_reach_rels.filter(rel => {
            let graph = this.graph_hash.get(rel.graph_id)!
            let pred = GraphNode.from(this.node_hash.get(rel.pred_id)!)
            return this.filter_rel(rel, graph.hasNode(pred), `local relation must originate in it's local graph`)
        })

        // 2-I Compute transitive closure based on Ref-fields 
        let tc = Session.computeTransitiveClosure(this.fields.filter(field => {
            let succ = this.node_hash.get(field.succ_id)
            return succ !== undefined && isRef(succ.type) && !isNull(succ)
        }))

        // 2-II Remove reachability relations contradicting field information, 
        // e.g. x.next == null && y != x ==> !P(A, x, y)
        raw_reach_rels = raw_reach_rels.filter(rel => {
            let entry = tc.get(rel.state)
            if (entry === undefined) {
                // In case there are no transitive heap relations for this state, keep reachability information from the model
                return true
            } else {
                let key = (new Relation('TC', rel.state, rel.pred_id, rel.succ_id)).hash()
                let tc_rel = entry.get(key)
                if (tc_rel === undefined) {
                    // In case there is no transitive heap relation for this pred and succ, keep reachability information from the model
                    return true
                } else {
                    return this.filter_rel(rel, ['P', '¬P'].includes(rel.name), `expected reachability relation but found a '${rel.name}' relation`)
                           && this.filter_rel(rel, rel.name !== 'P', `this reachability relation is redundant (it merely follows concrete heap edges)`)
                           && this.filter_rel(rel, rel.name === '¬P', `this reachability relation contradicts the computed transitive closure`)
                }
            }
        })

        // 3. Remove redundant relations
        let client_pos_reach = new Map<string, LocalRelation>()
        let callee_pos_reach = new Map<string, LocalRelation>()
        let client_neg_reach = new Map<string, LocalRelation>()
        let callee_neg_reach = new Map<string, LocalRelation>()

        function relkey(rel: LocalRelation): string {
            // encodes all but the name and graph_id
            return `${rel.state.valStr()}_${rel.pred_id}_${rel.succ_id}`
        }
            
        raw_reach_rels.forEach(rel => {
            let key = relkey(rel)
            let graph = this.graph_hash.get(rel.graph_id)!
            if (this.footprints!.client.includes(graph)) {
                if (rel.name === 'P') {
                    client_pos_reach.set(key, rel)
                } else if (rel.name === '¬P') {
                    client_neg_reach.set(key, rel)
                } else {
                    Logger.error(`unexpected relation name: ${rel.name} (expected 'P' or '¬P')`)
                }
            } else if (this.footprints!.callee.includes(graph)) {
                if (rel.name === 'P') {
                    callee_pos_reach.set(key, rel)
                } else if (rel.name === '¬P') {
                    callee_neg_reach.set(key, rel)
                } else {
                    Logger.error(`unexpected relation name: ${rel.name} (expected 'P' or '¬P')`)
                }
            }
        })

        if (client_pos_reach.size === 0 && callee_pos_reach.size === 0 && 
            client_neg_reach.size === 0 && callee_neg_reach.size === 0) {
            // Do not filter the relations since the footprints are not defined
            return raw_reach_rels
        } else {
            // Filter redundant relations
            let result = new Set<LocalRelation>()

            // (1) P(H) ==> P(G)
            // Throw away P(G,x,y) for which there exist P(H,x,y)
            client_pos_reach.forEach(client_pos_rel => {
                let key = relkey(client_pos_rel)
                if (!callee_pos_reach.has(key)) {
                    result.add(client_pos_rel)
                } else {
                    this.log_reason(client_pos_rel, 
                        `H ⊆ G ^ P(H) ⇒ P(G), i.e. positive client-local reachability relation follows from an known positive callee-local reachability relation`)
                }
            })

            // (2) !P(G) ==> !P(H)
            // Throw away !P(H,x,y) for which there exists !P(G,x,y)
            callee_neg_reach.forEach(callee_neg_rel => {
                let key = relkey(callee_neg_rel)
                if (!client_neg_reach.has(key)) {
                    result.add(callee_neg_rel)
                } else {
                    this.log_reason(callee_neg_rel, 
                        `H ⊆ G ^ ¬P(G) ⇒ ¬P(H), i.e. negative callee-local reachability relation follows from an known negative client-local reachability relation`)
                }
            })

            // (3) keep remaining strong reachability information: P(H), !P(G)
            callee_pos_reach.forEach(callee_pos_rel => result.add(callee_pos_rel))
            client_neg_reach.forEach(client_neg_rel => result.add(client_neg_rel))
            
            return Array.from(result)
        }
    }

    public produceGraphModel(): GraphModel {
        // 0. Collect initial nodes
        let local_node_versions = this.collectLocalStoreVars()
        let starting_atoms: Array<Atom>
        if (local_node_versions === undefined) {
            starting_atoms = this.collectInitialGraphsAndNodes(true)
        } else {
            starting_atoms = this.collectInitialGraphsAndNodes(false)
            starting_atoms.push(...local_node_versions)
        }

        Session.collectEquivClasses(starting_atoms, this.equiv_classes)  // optional
        let starting_nodes = this.mergeAliases(starting_atoms)

        // 1. Process and Saturate! 
        this.produceGraphModelRec(starting_nodes)
        
        // 2. Extract latest footprints (possibly, aliasing groups of node sets)
        this.footprints = Session.extractFootprints(this.graphs)

        // 3. Collect reachability information
        let non_null_nodes = this.graph_nodes.filter(n => !n.isNull)
        let raw_reach_rels = this.collectReach(non_null_nodes)
        
        // 4. Filter out redundant information
        // this.reach = this.filterReachabilityRelations(raw_reach_rels)
        this.reach = raw_reach_rels

        // 5. Complete model
        this.graphModel = 
            new GraphModel(
                this.states!, 
                Array.from(this.graphs), 
                this.footprints,
                this.graph_nodes, 
                this.scalar_nodes, 
                this.fields, 
                this.reach, 
                this.equiv_classes)

        return this.graphModel
    }

    public applyQuery(query: Query): GraphModel {

        // Filter the states
        let selected_states = new Set<string>(query.states)
        let filtered_states = this.graphModel!.states.filter(state => selected_states.has(state.nameStr()))
        
        let filtered_graphs = this.graphModel!.graphs.flatMap(g => collect(g.project(selected_states)))
        let filtered_fields = this.graphModel!.fields.filter(field => selected_states.has(field.state.nameStr()))

        let filtered_nodes = new Map<number, GraphNode>()  // from node id to node
        filtered_graphs.forEach(graph => 
            graph.getNodesArray().forEach(node => {
                if (!filtered_nodes.has(node.id)) {
                    filtered_nodes.set(node.id, node)
                }
            }))

        // Add nodes that are not in a graph
        this.graphModel!.graphNodes.forEach(node => {
            if (!filtered_nodes.has(node.id)) {
                let proj = node.project(selected_states)
                if (proj !== undefined) {
                    filtered_nodes.set(proj.id, proj)
                }
            }
        })
        let selected_node_ids = new Set(filtered_nodes.keys())
        let filtered_scalars = this.graphModel!.scalarNodes.flatMap(c => collect(c.project(selected_states)))

        
        let filtered_reach = this.graphModel!.reach.filter(rel => {
            let isSelected = selected_states.has(rel.state.nameStr())
            let isGraphActive = filtered_graphs.map(g => g.id).includes(rel.graph_id)  // could be optimized
            let isPredActive = selected_node_ids.has(rel.pred_id)
            let isSuccActive = selected_node_ids.has(rel.succ_id)
            return isSelected && isPredActive && isSuccActive && isGraphActive
        })

        this.latestQuery = new GraphModel()
        Object.assign(this.latestQuery, this.graphModel!)
        this.latestQuery!.fields = filtered_fields
        this.latestQuery!.states = filtered_states
        this.latestQuery!.reach = filtered_reach
        this.latestQuery!.graphNodes = Array.from(filtered_nodes.values())
        this.latestQuery!.graphs = filtered_graphs
        this.latestQuery!.scalarNodes = filtered_scalars
        this.latestQuery!.footprints = Session.extractFootprints(filtered_graphs)
        
        return this.latestQuery!
    }

    private getDefinitionNames(type: string): Array<string> {
        return this.programDefinitions!.filter(def => {
            let matches_type = (def.type.name === type)
            // Check if the error we are debugging is in the scope of this definition
            let matches_error_location = this.errorLocation!.inScope(def.scopeStart, def.scopeEnd)
            return matches_type && matches_error_location
        }).flatMap(def => def.name)
    }

    private getDefinitionModelValues(idn: string): Array<[string, ModelEntry]> {
        return Object.entries(this.model!).filter(mapEntry => mapEntry[0].startsWith(idn))
    }

    private collectDependentEntriesRec(entry_path: Array<string>, 
                                       entry: ModelEntry, value: string): Array<[Array<string>, ModelEntry]> {
        switch(entry.type) {
            case 'constant_entry': 
                if ((<ConstantEntry> entry).value === value) {
                    return [[entry_path, entry]]
                } else {
                    return []
                }

            case 'application_entry':
                let fun = (<ApplicationEntry> entry).value
                return fun.args.flatMap(arg => 
                    this.collectDependentEntriesRec(entry_path.concat([fun.name]), arg, value))

            case 'map_entry': 
                let map = (<MapEntry> entry)
                let res1 = this.collectDependentEntriesRec(entry_path.concat('default'), map.default, value)
                let res2 = map.cases.flatMap(caseEntry => {
                    let res11 = this.collectDependentEntriesRec(entry_path.concat('value'), caseEntry.value, value)
                    let res21 = caseEntry.args.flatMap((arg, index) => {
                        return this.collectDependentEntriesRec(entry_path.concat(`arg${index}`), arg, value)
                    })
                    return res11.concat(res21)
                })
                return res1.concat(res2)
                
            default: 
                Logger.error(`unsupported model entry type: ${entry.type}`)
                return []
        }
    }

    private collectDependentEntries(dep_value: string): Array<[Array<string>, ModelEntry]> {
        return Object.entries(this.model!).flatMap(entry => 
            this.collectDependentEntriesRec([entry[0]], entry[1], dep_value))
    }

    private collectReachInfo(rel_name: string, graph: Graph, 
                             pred_node: GraphNode, succ_node: GraphNode): (state_innerval: string) => [SmtBool, Status] {

        /** Step 1 -- decode the reachability function that depends on an edge graph */
        let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
        if (!rel_maybe) {
            throw `model does not contain the expected relation '${rel_name}'`
        } 
        let rel = rel_maybe![1]
        if (rel.type !== 'map_entry') {
            throw `reachability relation '${rel_name}' must be of type 'map_entry'`
        }
        // e.g. exists_path(EG: Set[Edge], x: Ref, y: Ref): Bool
        let outer_fun = this.partiallyApplyReachabilityRelation(<MapEntry> rel, pred_node.val, succ_node.val)
        

        /** Step 2 -- decode the snapshot function that takes a state and yields an edge graph */
        
        let $$_maybe = Object.entries(this.model!).find(pair => pair[0] === '$$')
        if (!$$_maybe) {
            throw `model does not contain the expected relation '$$'`
        }
        let $$ = $$_maybe![1]

        /** Step 3 -- combine the decoded functions */
        return (state_innerval: string) => {
            // e.g. $$(h: Heap, g: Set[Ref]): Set[Edge]
            let [edge_graph, _] = Session.appleEntry($$, [state_innerval, graph.val])
            return outer_fun(edge_graph)
        }
    }

    private collectFieldValueInfo(node: GraphNode, fname: string): (state: State) => [NodeClass | undefined, Status] {
        let rel_name = this.fieldLookupRelationName(fname)
        let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
        if (!rel_maybe) {
            throw `model does not contain the expected relation '${rel_name}' for field ${fname}`
        } 
        let rel = rel_maybe![1]
        if (rel.type !== 'map_entry') {
            throw `field-value relation '${rel_name}' must be of type 'map_entry'`
        }
        let field_node_val = this.fieldNodeValue(fname)
        let simple_fun = this.partiallyApplyFieldMapEntry(<MapEntry> rel, node.val, field_node_val)

        // We cannot pass just the state itself because consolidated states may have multiple inner values
        return (state: State) => {
            
            let [succ_innerval, status] = simple_fun(state.val)
            let field_type = this.viperTypes!.get(fname)

            // Check the value type. If the type in the model contradicts the field type, 
            //  assume that this value is irrelevant for the counterexample. 
            if (!isBool(field_type) && this.isBoolLiteral(succ_innerval) || 
                !isInt(field_type) && this.isIntLiteral(succ_innerval) || 
                !isPerm(field_type) && this.isFloatLiteral(succ_innerval)) {

                Logger.info(`ignoring field value ${succ_innerval} of node of node ${node.repr()} (inconsistent field type in the model)`)
                return [undefined, status]
            }

            if (succ_innerval === '#unspecified') {
                Logger.info(`ignoring unspecified value of field ${fname} of node ${node.repr(true)}`)
                return [undefined, status]
            }
            
            let aliasing_succs = node.aliases.map(pred_alias => {
                // All aliases of [[node]] yield new aliasing fresh nodes. 
                //  E.g.: {X.next, Y.next, Z.next} alias if {X, Y, Z} alias. 
                // Note that we postpone the alias analysis until the next iteration of the core algorithm, 
                //  at which stage all transitive nodes are going to be processed. 
                let alias_name = `${pred_alias.name()}.${fname}[${state.nameStr()}]`
                let alias = this.mkAtom(alias_name, succ_innerval, false, field_type, [state])
                Logger.info(` ${alias.repr(true, true)}`)
                return alias
            })
            let succ = new NodeClass(this.freshNodeId(), succ_innerval, field_type, aliasing_succs)
            
            return [succ, status]
        }
    }

    private isIntLiteral(succ_innerval: string): boolean {
        let i = parseInt(succ_innerval) 
        let f = parseFloat(succ_innerval)
        return i === i && f === f && i !== f
    }

    private isFloatLiteral(succ_innerval: string): boolean {
        let i = parseInt(succ_innerval) 
        let f = parseFloat(succ_innerval)
        return i === i && f === f && i !== f
    }

    private isBoolLiteral(succ_innerval: string): boolean {
        return succ_innerval === 'true' || succ_innerval === 'false'
    }

    private isValueOfUninterpretedType(innerval: string): boolean {
        let m = innerval.match(/^.*val!\d+$/)  // e.g. "T@U!val!1"
        if (m !== null && m !== undefined) {
            return true
        } else {
            return false
        }
    }

    /** Example application entry in function model: 
      *
      *  type: "application_entry"
      *  value:Object
      *      name:"="
      *      args:Array[2]
      *          0:Object
      *              type: "application_entry"
      *              value:Object
      *                  name: ":var" 
      *                  args:Array[1]
      *                      0:Object
      *                          type: "constant_entry"
      *                          value:"0"
      *          1:Object
      *              type: "constant_entry"
      *              value: "$Ref!val!1"
      */
     private static __wildcard_symbol = '@@wild@card@@'
     private static evalEntry(entry: ModelEntry, args: Array<string | undefined>): [string, Status] {
        if (entry.type === 'constant_entry') {
            return [getConstantEntryValue(entry), 'constant']

        } else if (entry.type === 'application_entry') {
            let res: string 
            let app_entry = (<ApplicationEntry> entry)
            let fun = app_entry.value.name
            let fun_args = app_entry.value.args
            let sub_results = fun_args.map(fun_arg => Session.evalEntry(fun_arg, args)[0])
            if (fun === 'and') {
                // do all arguments evaluate to 'true'?
                res = sub_results.every(sub_res => sub_res === 'true') ? 'true' : 'false'
            } else if (fun === 'or') {
                // do some arguments evaluate to 'true'?
                res = (sub_results.some(sub_res => sub_res === 'true')) ? 'true' : 'false'
            } else if (fun === 'not' || fun === '!') {
                // negate the argument 
                res = (sub_results[0] === 'true') ? 'false' : 'true'
            } else if (fun === '=') {
                // check that all arguments of '=' evaluate to the same value
                let sub_result_set = new Set(sub_results)
                if (sub_result_set.size === 1) {
                    // All arguments are equal
                    return ['true', 'fun_app']
                } else if (sub_result_set.size === 2 && sub_result_set.has(this.__wildcard_symbol)) {
                    // All arguments are either equal to some value or match a wildcard argument
                    return ['true', 'fun_app']
                } else {
                    // Some arguments did not match this case
                    return ['false', 'fun_app']
                }
            } else if (fun === ':var') {
                let arg_index = parseInt(getConstantEntryValue(fun_args[0]))
                let arg = args[arg_index]
                // Undefined args correspond to wildcards in the contex of partial function applications.
                // For example, if a predicate P is defined in the model as "(and (= (:var 0) 22) (= (:var 1) 33) (= (:var 2) 44))", 
                //  then P(x,y,z) is true **iff** x=22|wildcard, y=33|wildcard, z=44|wildcard; 
                //  e.g., P(22, 33, 44) and P(22, wildcard, 44) hold, while e.g. P(88, wildcard, 44) does not hold. 
                res = (arg === undefined) ? this.__wildcard_symbol : arg
            } else {
                throw `unsupported function: '${fun}'`
            }
            return [res, 'fun_app']
            
        } else {
            return Session.appleEntry(entry, args)
        }
    }

    static appleEntry(entry: ModelEntry, args: Array<string | undefined>): [string, Status] {
        if (entry.type === 'constant_entry') {
            let const_entry = <ConstantEntry> entry
            return [const_entry.value, 'constant']
        } else if (entry.type === 'application_entry') {
            let app_entry = (<ApplicationEntry> entry)
            let [app_value, _] = Session.evalEntry(app_entry, args)
            return [app_value, 'fun_app']
        } else {
            let map_entry = <MapEntry> entry
            let res_entry_maybe = map_entry.cases.find(map_case => {
                
                let matches = args.map((arg, index) => {
                    if (arg === undefined) {
                        // this is a wildcard argument
                        return true
                    }
                    let case_arg = getConstantEntryValue(map_case.args[index])
                    return arg === case_arg
                })
                return matches.every(x => x)
            })
            if (res_entry_maybe) {
                let case_entry = res_entry_maybe!.value
                let [case_val, _] = Session.appleEntry(case_entry, args)
                return [case_val, 'from_cases']  // track only top-level status 
            } else {
                let default_entry = map_entry.default
                let [default_val, _] = Session.appleEntry(default_entry, args)
                return [default_val, 'default'] // track only top-level status 
            } 
        }
    }
    

    private __nullInnerVal: string | undefined = undefined
    private isValNull(innerval: string): boolean {
        if (this.__nullInnerVal === undefined) {
            return false
        } else {
            return innerval === this.__nullInnerVal
        }
    }
    private setNull(): void {
        let nullEntries = Object.entries(this.model!).filter(pair => pair[0] === this.nullNodeName())
        if (nullEntries.length === 0) {
            throw `model does not specify null`
        } else if (nullEntries.length > 1) {
            throw `model specifies multiple null entries`
        }
        let nullEntry = nullEntries.pop()![1]
        this.__nullInnerVal = getConstantEntryValue(nullEntry)
    }
    private mkNullAtom(): Atom {
        let nullAtom = this.mkAtom('null', this.__nullInnerVal!, false, PrimitiveTypes.Ref)
        return nullAtom
    }

    private mkNullNode(): GraphNode {
        let nullAtom = this.mkNullAtom()
        let nullNode = new GraphNode(this.freshNodeId(), this.__nullInnerVal!, true, [nullAtom], [])
        return nullNode
    }

    /** Backend-specific code */

    private nullNodeName(): string {
        return this.isCarbon() ? 'null' : '$Ref.null'
    }

    /** Returns true iff 'lhs' is the name of the prototype of the 'rhs' */
    private isPrototypeOf(proto: string, name: string) {
        return this.innerToProto(name) === proto
    }

    private collectStates(): Array<State> {
        // A. Collect heap states as inner values of the SMT model
        let states = Object.entries(this.model!).filter(pair => {
            let entry_name = pair[0]
            let entry = pair[1]
            if (this.isCarbon()) {
                return entry.type === 'constant_entry' && entry_name.includes('Heap')
            } else {
                return entry.type === 'constant_entry' && (<ConstantEntry> entry).value.startsWith('$FVF<')
            }
        }).map(pair => new State(new Array(), new Array((<ConstantEntry> pair[1]).value), new Array(pair[0])))

        // // C. Merge states with the same innerval (each state may have only one innerval at this point)
        // let non_aliasing_states = new Map<string, State>()
        // states.forEach(state => {
        //     let key1 = labelToHash.get(state.names[0])
        //     let key = `${state.innervals[0]}_${key1}`
        //     if (non_aliasing_states.has(key)) {
        //         let na_state = non_aliasing_states.get(key)!
        //         na_state.aliases.push(...state.aliases)
        //     } else {
        //         non_aliasing_states.set(key, state)
        //     }
        // })
        
        // return Array.from(non_aliasing_states.values())
        return states
    }

    private static isStateLabel(idn: string): boolean {
        let m = idn.match(/^l\d+$/)
        return m !== null && m !== undefined
    }

    private getStateNames(): Array<string> {
        return this.programDefinitions!.filter(def => 
            Session.isStateLabel(def.name)).map(state_lbl_def => state_lbl_def.name)
    }

    private static isMapEntryUnspecified(entry: MapEntry): boolean {
        return entry.cases.length === 0 && entry.default.type === 'constant_entry' && 
               getConstantEntryValue(entry.default) === '#unspecified'
    }

    private getEntryByName(name: string): ModelEntry | undefined {
        
        let matches = Object.entries(this.model!).filter(pair => pair[0].includes(name))
        
        if (matches.length === 0) {
            return undefined
        } else if (matches.length === 1) {
            let match = matches.pop()!
            return match[1]
        } else {
            let exact_match = matches.find(pair => pair[0] === name)
            if (exact_match !== undefined) {
                return exact_match[1]
            } else {
                let renamed_matches = matches.filter(pair => {
                    // Check if we have entries named e.g. 'snap_1'
                    let m = pair[0].match(/^${name}_\d+$/) 
                    return m !== null
                })
                if (renamed_matches.length === 0) {
                    return undefined
                } else {
                    // Take the match with the least index
                    return Array.from(renamed_matches.map(p => p[1])).sort().pop()
                }
            }
        }
    }

    // Used as a fallback for remapStates in case state labels could not be identified
    private static triviallyRemapStates(states: Array<State>): Array<State> {
        states.forEach(state => state.names.push(state.aliases[0]))
        return states
    }

    private remapStates(states: Array<State>): Array<State> {
        let state_fun = '$state'
        // let heap_fun = '$heap'
        let state_lbl_fun = this.getEntryByName(state_fun)
        // let heap_snap_fun = this.getEntryByName(heap_fun)
        if (state_lbl_fun === undefined) {
            return Session.triviallyRemapStates(states)
        } else {
            // 0. Check that the state labels are modeled properly
            let state_lbl_entry = castToMapEntry(state_lbl_fun)
            // let heap_snap_entry = castToMapEntry(heap_snap_fun)

            if (Session.isMapEntryUnspecified(state_lbl_entry)) {
                Logger.warn(`could not map program states (interpretation of function '${state_fun}' is unspecified)`)
                return Session.triviallyRemapStates(states)
            }
            
            // 0.5. Collect local store versions (TODO: this is similar to collectLocalStoreVars -- share the code?)
            let labelVarVal = new Map<string, Map<string, string>>()  // From labels to vars to values
            let localEntris = Object.entries(this.model!).filter(pair => pair[0].startsWith('$local'))
            localEntris.forEach(pair => {
                let name = pair[0]
                let entry = pair[1]
                let m = name.match(/^\$local\$(.*)\$(\d+)$/)
                if (m === null || m === undefined) {
                    throw `cannot parse local store instumentation emtry name '${name}' (expected e.g. '$local$a$2')`
                }
                let varName = m[1]
                let stateLabel = m[2]
                let labelName = `l${stateLabel}`
                let val = Session.serializeEntryValue(entry)
                
                if (labelVarVal.has(labelName)) {
                    let varsToVals = labelVarVal.get(labelName)!
                    if (varsToVals.has(varName)) {
                        throw `unexpected duplicate in local state instrumentation: label='${labelName}', var='${varName}', val='${val}'`
                    } else {
                        varsToVals.set(varName, val)
                    }
                } else {
                    let varsToVals = new Map()
                    varsToVals.set(varName, val)
                    labelVarVal.set(labelName, varsToVals)
                }
            })
            let labelToHash = new Map<string, string>()  // label hashes to labels
            labelVarVal.forEach((varToVal, label) => {
                let key = Array.from(varToVal.entries()).map(pair => `${pair[0]}_${pair[1]}`).sort().join(';')
                labelToHash.set(label, key)
            })

            // 1    Find the defined state names, e.g. l0, l1, l2, ...
            const keySep = '///'
            let state_names = new Set(this.getStateNames())
            // 1.5  Find entries for each state name, 
            //    e.g. l0:{type:"constant_entry", value:"T@U!val!1"}
            let labels = new Map<string, Array<string>>()  // from label innerval/localHash to label names
            Object.entries(this.model!).forEach(pair => {
                let entry_name = pair[0]
                let entry = pair[1]
                if (state_names.has(entry_name)) {
                    if (entry.type !== 'constant_entry') {
                        throw `expected constant_entry for '${entry_name}' in the model, but found ${entry.type}`
                    } else {
                        let const_entry = <ConstantEntry> entry
                        let key1 = labelToHash.get(entry_name)  // e.g. labelToHash('l1') === 'a_42;b_25'
                        let key = `${const_entry.value}${keySep}${key1}`
                        if (labels.has(key)) {
                            let labels_for_val = labels.get(key)!
                            labels_for_val.push(entry_name)
                        } else {
                            labels.set(key, new Array(entry_name))
                        }
                    }
                }
            })

            // 2. Map raw states to state names using the $state function
            let remapped_states = new Map<string, State>()  // Maps heap/store pairs to states
            states.forEach(raw_state => {
                if (remapped_states.has(raw_state.innervals[0])) {
                    throw `unexpected state alias with value ${raw_state.innervals[0]}`
                }

                // The expected arguments of $state are:                                 (1) heap/state,         (2) current_footprint
                //  we substitute these as follows:                                          raw_state               wildcard         
                let [expected_state_name_innerval, _] = Session.appleEntry(state_lbl_entry, [raw_state.innervals[0], wildcard])

                labels.forEach((state_names, key) => {
                    let k = key.split(keySep)
                    let state_name_innerval = k[0]
                    let local_store_hash = k[1]
                    if (expected_state_name_innerval === state_name_innerval) {
                        // Found a correspondence between label and raw state
                        let proper_state = new State(state_names.sort(), raw_state.innervals, raw_state.aliases.sort(), local_store_hash)
                        let remapKey = `${raw_state.innervals[0]}${keySep}${local_store_hash}`
                        if (remapped_states.has(remapKey)) {
                            let old_state = remapped_states.get(remapKey)!
                            Logger.warn(`consider removing duplicate labels for state with value ${raw_state.innervals[0]} and local store hash ${local_store_hash} (keeping ${old_state.nameStr()}; dropping ${state_names})`)
                        } else {
                            remapped_states.set(remapKey, proper_state)
                        }
                    }
                })
            })

            // // 2.75. Merge states with the same innerval/localHash (each state may have only one innerval at this point)
            // let non_aliasing_states = new Map<string, State>()
            // Array.from(remapped_states.values()).forEach(state => {
            //     let key1 = state.localStoreHash
            //     let key = `${state.innervals[0]}_${key1}`
            //     if (non_aliasing_states.has(key)) {
            //         let na_state = non_aliasing_states.get(key)!
            //         na_state.aliases.push(...state.aliases)
            //     } else {
            //         non_aliasing_states.set(key, state)
            //     }
            // })

            // 3. Merge states that have labels with the same innerval
            //   After this step, states may have multiple innervals for the first time. 
            let na_states = new Map<string, State>()  // maps labels (e.g. "l1" or "l0/l1/l2") to states

            let potentially_aliasing_states = Array.from(remapped_states.values())
            potentially_aliasing_states.forEach(state => {
                let key = state.nameStr()
                if (na_states.has(key)) {
                    let old_state = na_states.get(key)!
                    old_state.aliases = Array.from(new Set(old_state.aliases.concat(state.aliases))).sort()
                    if (old_state.valStr() === state.valStr()) {
                        throw `different states' values should not be equal before state consolidation (${old_state}, ${state})`
                    }
                    // We assume that these states are effectively equal since the labels to which they correspond are equal.
                    state.innervals.forEach(dropped_innerval => 
                        Logger.warn(`ignoring states with innerval ${dropped_innerval} as they are equal to ${old_state.nameStr()}`))
                    // old_state.innervals.push(...state.innervals)
                    // old_state.innervals.sort()
                } else {
                    na_states.set(key, state)
                }
            })

            // 4. Return sorted, named states
            return Array.from(na_states.values()).sort((a: State, b: State) => a.nameStr().localeCompare(b.nameStr()))
        }
    }

    private partiallyApplyReachabilityRelation(m_entry: MapEntry, pred: string, succ: string): (edge_graph: string) => [SmtBool, Status] {
        let res_map = new Map<string, string>()

        m_entry.cases.forEach(map_case => {
            let edge_graph_entry = map_case.args[0]
            let edge_graph = getConstantEntryValue(edge_graph_entry)

            // Check if this case matches the provided partial arguments
            let first_entry = map_case.args[1]
            let first = getConstantEntryValue(first_entry)

            let second_entry = map_case.args[2]
            let second = getConstantEntryValue(second_entry)

            if (first === pred && second === succ) {
                let val = getConstantEntryValue(map_case.value)
                res_map.set(edge_graph, val)
            }
        })

        let default_entry = m_entry.default
        let default_val = getConstantEntryValue(default_entry)

        return (edge_graph: string) => {
            if (res_map.has(edge_graph)) {
                return [castToSmtBool(res_map.get(edge_graph)!), 'from_cases']
            } else {
                return [castToSmtBool(default_val), 'default']
            }
        }
    }

    private partiallyApplyFieldMapEntry(m_entry: MapEntry, reciever: string, field: string | undefined): (state: string) => [string, Status] {
        let res_map = new Map<string, string>()

        let state_index: number
        let object_index: number
        let field_index: number | undefined
        if (this.isCarbonTypeEncodingA()) {
            //                                 0    1    2       3       4    5
            // typeEncoding:a -- MapType0Store A@@2 B@@2 RefType Heap@@6 o@@2 f_2@@2 v)
            state_index = 3
            object_index = 4
            field_index = 5
        } else if (this.isCarbonTypeEncodingP()) {
            state_index = 0
            object_index = 1
            field_index = 2
        } else {
            // silicon
            state_index = 0
            object_index = 1
            field_index = undefined
        }

        m_entry.cases.forEach(map_case => {
            let state_entry = map_case.args[state_index]
            let state = getConstantEntryValue(state_entry)

            // Check if this case matches the provided partial arguments

            let first_entry = map_case.args[object_index]
            if (first_entry.type !== 'constant_entry' || !this.isValueOfUninterpretedType(getConstantEntryValue(first_entry))) {
                // A heuristic for avoiding type-insensitive model entries (which may occur in e.g. Boogie's [3] function)
                Logger.warn(`skipping model entry with mixed types`)
                return
            }
            let first = getConstantEntryValue(first_entry)
        
            if (field) {
                // this is Carbon
                let second_entry = map_case.args[field_index!]
                if (second_entry.type !== 'constant_entry' || !this.isValueOfUninterpretedType(getConstantEntryValue(second_entry))) {
                    // A heuristic for avoiding type-insensitive model entries (which may occur in e.g. Boogie's [3] function)
                    Logger.warn(`skipping model entry with mixed types`)
                    return
                }
                let second = getConstantEntryValue(second_entry)
                if (first === reciever && second === field) {
                    let val = Session.serializeEntryValue(map_case.value)
                    res_map.set(state, val)
                }
            } else {
                if (first === reciever) {
                    let val = Session.serializeEntryValue(map_case.value)
                    res_map.set(state, val)
                }
            }
        })

        let default_entry = m_entry.default
        let default_val = getConstantEntryValue(default_entry)
        
        return (state: string) => {
            if (res_map.has(state)) {
                return [res_map.get(state)!, 'from_cases']
            } else {
                return [default_val, 'default']
            }
        }
    }

    private reachabilityRelationNames(): Array<string> {
        if (this.isCarbon()) {
            return ['exists_path']
        } else {
            return ['exists_path<Bool>']
        }
    }

    private fieldLookupRelationName(fname: string): string {
        return this.isCarbon() 
        ? (this.isCarbonTypeEncodingA() ? '[7]' : '[3]') 
        : `$FVF.lookup_${fname}`
    }

    private setIncludesRelationName(): string {
        if (this.isCarbonTypeEncodingA()) {
            return '[4]'
        } else if (this.isCarbonTypeEncodingP()) {
            return '[2]'
        } else {
            // silicon
            return 'Set_in'
        }
    }

    private applySetInMapEntry(entry: ModelEntry, graphVal: string, nodeVal: string): [string, Status] {
        if (this.isCarbonTypeEncodingA()) {
            return Session.appleEntry(entry, [undefined, undefined, graphVal, nodeVal])
        } else if (this.isCarbonTypeEncodingP()) {
            return Session.appleEntry(entry, [graphVal, nodeVal])
        } else {
            return Session.appleEntry(entry, [nodeVal, graphVal])
        }
    }

    private parseInnervalAsSmtBool(innerval: string): SmtBool {
        if (innerval === 'true') {
            return 'true'
        }
        if (innerval === 'false') {
            return 'false'
        }
        if (innerval === '#unspecified') {
            return 'unspecified'
        }
        if (this.isCarbon()) {
            let U_2_bool = this.getEntryByName('U_2_bool')
            if (!U_2_bool) {
                throw `cannot interpret value '${innerval}' of uninterpreted type as Boolean: model does not define 'U_2_bool'`
            }
            let [bool_str, _] = Session.appleEntry(U_2_bool, [innerval])
            if (bool_str === '#unspecified') {
                let bool_2_U = this.getEntryByName('bool_2_U')
                if (!bool_2_U) {
                    throw `cannot interpret value '${innerval}' of uninterpreted type as Boolean: model does not define 'bool_2_U'`
                }
                let [true_innerval, _1] = Session.appleEntry(bool_2_U, ['true'])
                let [false_innerval, _2] = Session.appleEntry(bool_2_U, ['false'])
                if (true_innerval === false_innerval) {
                    throw `model assignes the same innerval to true and false (${true_innerval}); this may be a bug in Z3`
                }
                if (true_innerval !== '#unspecified' && innerval === true_innerval) {
                    return 'true'
                } else if (false_innerval !== '#unspecified' && innerval === false_innerval) {
                    return 'false'
                } else {
                   throw `cannot interpret value '${bool_str}' as Boolean` 
                }
            } else if (bool_str !== 'true' && bool_str !== 'false') {
                throw `cannot interpret value '${bool_str}' as Boolean`
            }
            return bool_str
        } else {
            if (innerval === '#unspecified') {
                return 'unspecified'
            }
            if (innerval !== 'true' && innerval !== 'false') {
                throw `cannot interpret value '${innerval}' as Boolean`
            }
            return innerval
        }
    }

    private fieldNodeValue(fname: string): string | undefined {
        if (this.isCarbon()) {
            let field_node_entry = this.model![fname]
            if (field_node_entry === undefined) {
                throw `cannot find model entry with expected name '${fname}'. Try renaming this identifier to avoid it being renamed by the translation`
            } else if (field_node_entry.type !== 'constant_entry') {
                throw `field '${fname}' is not represented as a constant in the model (fields of non-scalar types are not supported)`
            }
            let field_node_val = getConstantEntryValue(field_node_entry)
            return field_node_val
        } else {
            return undefined
        }
    }

    private static innerNameParser(inner_name: string): 
        { proto: string, suffix?: string, index?: number } {

        let m3 = inner_name.match(/^(.*)_(\d+)@.*@(\d+)$/)  // e.g. a_2@@3
        if (m3 !== null) {
            return { proto: m3[1], suffix: m3[2], index: parseInt(m3[3]) }
        }
        let m2 = inner_name.match(/^(.*)@(.*)@(\d+)$/)
        if (m2 !== null) {
            return { proto: m2[1], suffix: m2[2], index: parseInt(m2[3]) }
        }
        let m1 = inner_name.match(/^(.*)@(\d+)$/)
        if (m1 !== null) {
            return { proto: m1[1], index: parseInt(m1[2]) }
        }
        let m0 = inner_name.match(/^(.*)_(\d+)$/)
        if (m0 !== null) {
            return { proto: m0[1], index: parseInt(m0[2]) }
        }
        return { proto: inner_name }
    }

    private static siliconInnerToProto(inner_name: string): string {
        let inner_name_struct = Session.innerNameParser(inner_name)
        return inner_name_struct.proto
    }

    private static carbonInnerNameToProto(inner_name: string): string {
        let inner_name_struct = Session.innerNameParser(inner_name)
        return inner_name_struct.proto
    }
    
    private static innerToProto(is_carbon: boolean, inner_name: string): string {
        if (is_carbon) {
            return Session.carbonInnerNameToProto(inner_name)
        } else {
            return Session.siliconInnerToProto(inner_name)
        }
    }

    private innerToProto(inner_name: string): string {
        return Session.innerToProto(this.isCarbon(), inner_name)
    }
}
