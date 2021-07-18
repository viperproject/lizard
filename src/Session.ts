import { node } from "webpack"
import { Logger } from "./logger"
import { PolymorphicTypes, getConstantEntryValue, ApplicationEntry, Model, Node, State, Relation, EquivClasses, GraphModel, ConstantEntry, ModelEntry, MapEntry, Graph, GraphNode, isRef, isSetOfRefs, ViperType, LocalRelation, isInt, isBool, isPerm, isNull, Status, SmtBool, castToSmtBool } from "./Models"
import { Query } from "./Query"
import { Type, TypedViperDefinition, ViperDefinition, ViperLocation } from "./ViperAST"
import { ViperTypesProvider } from "./ViperTypesProvider"

export interface SessionOpts {
    is_carbon: boolean
    is_carbon_type_encoding_a: boolean
}

export class Session {
    public programDefinitions: Array<ViperDefinition> | undefined = undefined
    public errorLocation: ViperLocation | undefined = undefined   // e.g. "30:22" meaning line 30, column 22
    public model: Model | undefined = undefined

    public getEntryByName(entry_name: string): ModelEntry | undefined {
        let res_maybe = Object.entries(this.model!).find(pair => pair[0] === entry_name)
        if (res_maybe === undefined) {
            return undefined
        } else {
            return res_maybe![1]
        }
    }

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

    private mkNode(name: string, innerval: string, is_local: boolean, 
                   type: ViperType | undefined = undefined, 
                   proto: Array<string> | undefined = undefined): Node {

        // Special case the null node
        if (name === this.nullNodeName()) {
            this.null_node = new GraphNode([name], true, this.freshNodeId(), innerval, false, proto)
            return this.null_node!
        }
        if (proto === undefined) {
            proto = new Array(this.innerToProto(name))
        }
        if (type === undefined) {
            // If type is not provided, try to retrieve it from available program definitions
            type = this.viperTypes!.get(name)
            if (!type) {
                // Fallback to Other type
                Logger.warn(`no type information for ${name} = ${innerval}`)
                type = PolymorphicTypes.Other(innerval)
            }
        }
        if (type.typename === 'Set[Ref]') {
            return new Graph([name], this.freshNodeId(), innerval, is_local, proto)
        } else if (type && type.typename === 'Ref') {
            return new GraphNode([name], false, this.freshNodeId(), innerval, is_local, proto)
        } else {
            return new Node([name], type, this.freshNodeId(), innerval, is_local, proto)
        }
    }

    // static myRelations = ['[2]', '[3]', '[4:=]', 
    //                       'exists_path_', 'exists_path', 
    //                       'edge_', 'edge', '$$', '$$\'']

    public parseProgramDefinitions(pds: Array<any>): void {
        this.programDefinitions = pds.map(pd => {
            let file = pd.location.file
            let loc = new ViperLocation(pd.location.start, file)
            let scopeStart: ViperLocation | 'global' = 
                (pd.scopeStart === 'global') ? 'global' : new ViperLocation(pd.scopeStart, file)
            let scopeEnd: ViperLocation | 'global' = 
                (pd.scopeEnd === 'global') ? 'global' : new ViperLocation(pd.scopeEnd, file)
            
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

    private atoms: Array<Node> | undefined = undefined
    public states: Array<State> | undefined = undefined 
    private extended_equiv_classes = new EquivClasses()
    private transitive_nodes = new Map<number, Node>()

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

        // 1. Collect program states and merge the potential aliases among them
        this.states = this.collectStates()

        // 2. If the program is instrumented with a $state(G:Set[Ref], state_id:Int) function, 
        //    remap the states to those that have explicit labels
        this.states = this.remapStates(this.states)

        // 3. Extract all atoms (i.e. top-level constant_entries) from the raw model. 
        this.atoms = new Array<Node>()
        Object.entries(this.model!).forEach(pair => {
            let name = pair[0]
            let entry = pair[1]
            
            if (entry.type === 'constant_entry' || entry.type == 'application_entry') {
                let innerval = Session.serializeEntryValue(entry)
                let node = this.mkNode(name, innerval, true)
                this.atoms!.push(node)
            }
        })

        // 3. Compute equivalence classes amongst all atoms
        Session.collectEquivClasses(this.atoms!, this.extended_equiv_classes)
    }

    private equiv_classes = new EquivClasses()

    private static collectEquivClasses(nodes: Array<Node>, ec: EquivClasses): void {
        nodes.forEach(node => {
            let key: [string, ViperType] = [node.val, node.type]
            if (ec.has(...key)) {
                ec.get(...key)!.push(node)
            } else {
                ec.set(...key, new Array(node))
            }
        })
    }

    private collectInitialGraphsAndNodes(): Array<Node> {
        
        let names = this.getDefinitionNames('Local')
                    .concat(this.getDefinitionNames('Argument'))
                    .concat(this.getDefinitionNames('Return'))
                    .concat(this.nullNodeName())

        let atoms = names.flatMap(proto => 
            this.atoms!.filter(atom => {
                if (atom.aliases.length > 1) {
                    throw `each node should have one internal name at this point, ` + 
                          `but ${JSON.stringify(atom)} has more.`
                }
                let atom_name = atom.aliases[0]
                return this.isPrototypeOf(proto, atom_name)
            })
            /*.map(atom => {
                // Set the prototype variable for this atom
                atom.proto = new Array(proto)
                atom
            })*/)

        if (atoms.length < names.length) {
            Logger.error(`could not find some atom definitions in raw model`)
        }

        // Filter old versions of variables in case the encoding uses SSA
        return atoms//this.extractLatestAssignedVars(atoms)
    }

    // map from inner values to nodes
    private nonAliasingNodesMap = new Map<string, Node>()

    private mergeAliases(nodes: Array<Node>): Array<Node> {

        let new_nonaliasing_nodes = new Set<Node>()

        nodes.forEach(node => {
            let node_name = node.aliases[0]

            let key = EquivClasses.key(node.val, node.type)
            if (this.nonAliasingNodesMap.has(key)) {
                // We already have a representative for this node inner value+type
                let na_node = this.nonAliasingNodesMap.get(key)!
                
                // FIXME: Checking membership in the array [[na_node.aliases]] is not efficient; would be better to store aliases in a set. 
                // FIXME: However, sets are not natively handles by our JSON visualization, so we bear with this theoretical inefficiency.  
                if (!na_node.aliases.includes(node_name)) {
                    // This is a new alias
                    na_node.aliases.push(node_name)
                    if (isRef(node.type) && (<GraphNode> node).isNull) {
                        (<GraphNode> na_node).isNull = true
                    }
                } 
                new_nonaliasing_nodes.add(na_node)
            } else {
                // This is a new node inner value
                this.nonAliasingNodesMap.set(key, node)
                new_nonaliasing_nodes.add(node)
            }
        })

        return Array.from(new_nonaliasing_nodes)
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
                        let rels = this.states!.map(state => {
                            let [is_reachable, status] = state_to_rels(state)
                            if (is_reachable !== 'unspecified') {
                                let r = (is_reachable === 'true') ? 'P' : '¬P'
                                let new_rel = new LocalRelation(r, state, graph.id, pred_node.id, succ_node.id, status)
                                reach_rels.add(new_rel)
                            }
                        })
                        return rels
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
            nodes.flatMap(node => {
                let state_to_rels = this.collectFieldValueInfo(node, fname)
                let rels = this.states!.flatMap(state => {
                    let [adj_node, status] = state_to_rels(state)
                    if (adj_node === undefined) {
                        return []
                    } else {
                        return [new Relation(fname, state, node.id, adj_node.id, status)]
                    }
                })
                node.fields.push(...rels)
                return rels
            }))

        return field_relations
    }

    private connectNodesToGraphs(nodes: Array<GraphNode>, graphs: Set<Graph>): void {
        let rel_name = this.setIncludesRelationName()
        let rel = this.getEntryByName(rel_name)
        if (rel === undefined) {
            Logger.warn(`the model does not contain the expected relation '${rel_name}'`)
            return
        }
        graphs.forEach(graph => {
            nodes.forEach(node => {
                let [val, status] = this.applySetInMapEntry(rel!, graph, node)
                if (this.parseInnervalAsSmtBool(val) === 'true') {
                    // this node belongs to this graph
                    graph.addNode(node, status)
                }
            })
        })
    }

    private node_hash = new Map<number, Node>()
    private graphs = new Set<Graph>()
    private latest_client_footprint: Graph | undefined = undefined
    private latest_callee_footprint: Graph | undefined = undefined
    
    private graph_nodes = new Array<GraphNode>()
    private scalar_nodes = new Array<Node>()
    private fields = new Array<Relation>()
    private reach = new Array<LocalRelation>()

    private produceGraphModelRec(starting_atoms: Array<Node>, iteration=1): void {
        Logger.info(`iteration №${iteration} of analyzing the heap model`)
        
        // A. Update hash s.t. nodes can be retrieved efficiently, via their IDs
        starting_atoms.forEach(node => {
            if (this.node_hash.has(node.id)) {
                throw `saturation error: node with ID ${node.id} is already present in the node hash`
            }
            this.node_hash.set(node.id, node)
        })

        // B. Deduce and merge aliasing nodes 
        Session.collectEquivClasses(starting_atoms, this.equiv_classes)
        let new_nonaliasing_nodes = this.mergeAliases(starting_atoms)

        // C. Group nodes by type: Ref, Set[Ref], Others
        //    Keep only the latest version of client and callee footprints
        let new_graph_nodes = new Array<GraphNode>()
        new_nonaliasing_nodes.forEach(node => {
            if (node.type && isRef(node.type)) {
                let graph_node = <GraphNode> node
                new_graph_nodes.push(graph_node)
            } else if (node.type && isSetOfRefs(node.type)) {
                let graph = <Graph> node
                this.graphs.add(graph)
            } else {
                this.scalar_nodes.push(node)
            }
        })
        this.graph_nodes.push(...new_graph_nodes)

        // D. Determine which Ref-based nodes belong to which graphs (i.e. Set[Ref]-based nodes)
        this.connectNodesToGraphs(new_graph_nodes, this.graphs)

        // E. Collect information about fields  
        let non_null_nodes = new_graph_nodes.filter(n => !n.isNull)
        let new_fields = this.collectFields(non_null_nodes)
        this.fields.push(...new_fields)

        // F. Some of the relations may lead to new nodes that must be encountered for in the model. 
        let trans_nodes = Array.from(this.transitive_nodes.values())
        this.transitive_nodes = new Map<number, Node>()

        // G. Saturate! 
        if (trans_nodes.length > 0) {
            this.produceGraphModelRec(trans_nodes, iteration+1)
        } else {
            Logger.info(`🎩 saturation completed 🎩`)
        }
    }

    private extractFootprints(): void {
        let client_footprint_max_index = -Infinity
        let callee_footprints_max_index = -Infinity
        this.graphs.forEach(nodeset => {
            let graph = <Graph> nodeset
            let is_client_footprint_proto = false
            let is_callee_footprint_proto = false
            let highest_client_footprint_index: number = -Infinity
            let highest_callee_footprint_index: number = -Infinity

            graph.aliases.forEach(alias => {
                // Handle the case in which there are several aliasing node sets 
                //  that potentially represent the footprints
                let {proto, suffix, index} = Session.innerNameParser(alias)
                if (proto === 'G') {
                    is_client_footprint_proto = true
                    if (index === undefined) {
                        highest_client_footprint_index = +Infinity
                    } else if (highest_client_footprint_index < index) {
                        highest_client_footprint_index = index
                    }
                } else if (proto === 'H') {
                    is_callee_footprint_proto = true
                    if (index === undefined) {
                        highest_callee_footprint_index = +Infinity
                    } else if (highest_callee_footprint_index < index) {
                        highest_callee_footprint_index = index
                    }
                }
            })
            // Maximize the index among all node sets whose proto is a footprint 
            //  (no index is better than all indices)
            if (is_client_footprint_proto) {
                if (highest_client_footprint_index === undefined && highest_client_footprint_index === +Infinity) {
                    // choose the entry without index over all possible other entries
                    // e.g. "G" rather than "G@1"
                    client_footprint_max_index = +Infinity 
                    this.latest_client_footprint = graph

                } else if (client_footprint_max_index < highest_client_footprint_index) {
                    // choose the entry with the highest index
                    // e.g. "G@1" rather than "G@0"
                    client_footprint_max_index = highest_client_footprint_index
                    this.latest_client_footprint = graph
                }
            } else if (is_callee_footprint_proto) {
                if (highest_callee_footprint_index === undefined && highest_callee_footprint_index === +Infinity) {
                    // choose the entry without index over all possible other entries
                    // e.g. "H" rather than "H@1"
                    callee_footprints_max_index = +Infinity
                    this.latest_callee_footprint = graph

                } else if (callee_footprints_max_index < highest_callee_footprint_index) {
                    // choose the entry with the highest index
                    // e.g. "H@1" rather than "H@0"
                    callee_footprints_max_index = highest_callee_footprint_index 
                    this.latest_callee_footprint = graph
                }
            }
        })
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
        let heap_edges_in_state = new Map<State, Array<Relation>>()
        heap_edges.forEach(edge => {
            let entry = heap_edges_in_state.get(edge.state)
            if (entry === undefined) {
                heap_edges_in_state.set(edge.state, new Array(edge))
            } else {
                entry.push(edge)
            }
        })

        // Process each state
        let states = new Set(heap_edges_in_state.keys())
        states.forEach(state => {
            let tc_for_state = Session.transitiveClosure(state, heap_edges_in_state.get(state)!)
            let rel_map = new Map<string, Relation>()
            tc_for_state.forEach(rel => rel_map.set(rel.hash(), rel))
            tc.set(state, rel_map)
        })

        return tc
    }
    
    private log_reason(rel: Relation, reason: string): void {
        let pred = this.node_hash.get(rel.pred_id)!
        let succ = this.node_hash.get(rel.succ_id)!
        let rel_str = `${rel.name}[ ${rel.state.val} ](${pred.val}, ${succ.val})`
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

        // 1. Remove spurious relations, 
        // e.g. $P(A, x, y)$ where $x \notin A$
        raw_reach_rels = raw_reach_rels.filter(rel => {
            let graph = <Graph> this.node_hash.get(rel.graph_id)!
            let pred = <GraphNode> this.node_hash.get(rel.pred_id)!
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
                if (!tc_rel) {
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
            return `${rel.state.val}_${rel.pred_id}_${rel.succ_id}`
        }
            
        raw_reach_rels.forEach(rel => {
            let key = relkey(rel)
            let graph = this.node_hash.get(rel.graph_id)
            if (graph === this.latest_client_footprint) {
                if (rel.name === 'P') {
                    client_pos_reach.set(key, rel)
                } else if (rel.name === '¬P') {
                    client_neg_reach.set(key, rel)
                } else {
                    Logger.error(`unexpected relation name: ${rel.name} (expected 'P' or '¬P')`)
                }
            } else if (graph === this.latest_callee_footprint) {
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
        let starting_atoms = this.collectInitialGraphsAndNodes()

        // 1. Process and Saturate! 
        this.produceGraphModelRec(starting_atoms)
        
        // 2. Extract latest footprints (possibly, aliasing groups of node sets)
        this.extractFootprints()

        // 3. Collect reachability information
        let non_null_nodes = this.graph_nodes.filter(n => !n.isNull)
        let raw_reach_rels = this.collectReach(non_null_nodes)
        
        // 4. Filter out redundant information
        this.reach = this.filterReachabilityRelations(raw_reach_rels)

        // 5. Complete model
        this.graphModel = 
            new GraphModel(
                this.states!, 
                Array.from(this.graphs), 
                {
                    'client': this.latest_client_footprint, 
                    'callee': this.latest_callee_footprint
                },
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
        let filtered_fields = this.graphModel!.fields.filter(field => selected_states.has(field.state.name))
        let filtered_states = this.graphModel!.states.filter(state => selected_states.has(state.name))
        let filtered_reach = this.graphModel!.reach.filter(rel => selected_states.has(rel.state.name))
        this.latestQuery = new GraphModel()
        Object.assign(this.latestQuery, this.graphModel!)
        this.latestQuery!.fields = filtered_fields
        this.latestQuery!.states = filtered_states
        this.latestQuery!.reach = filtered_reach
        
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
                             pred_node: GraphNode, succ_node: GraphNode): (state: State) => [SmtBool, Status] {

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
        
        // e.g. $$(h: Heap, g: Set[Ref]): Set[Edge]
        let inner_fun = (stateval: string) => Session.appleEntry($$, [stateval, graph.val])
        

        /** Step 3 -- combine the decoded functions */
        return (state: State) => {
            let [edge_graph, _] = inner_fun(state.val)
            return outer_fun(edge_graph)
        }
    }

    private collectFieldValueInfo(node: Node, fname: string): (state: State) => [Node | undefined, Status] {
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
            
            let key = EquivClasses.key(succ_innerval, field_type)
            let succ: Node
            if (this.nonAliasingNodesMap.has(key)) {
                // succ already has a representative node
                succ = this.nonAliasingNodesMap.get(key)!
            } else {
                // this is a fresh value; create a new atom (per alias) to support it
                Logger.info(`no atom found for value ${succ_innerval} of type ${field_type.typename}; ` + 
                            `adding transitive node(s): `)
                let aliasing_succs = node.aliases.map(pred_alias_name => {
                    // All aliases of [[node]] yield new aliasing fresh nodes. 
                    //  E.g.: {X.next, Y.next, Z.next} alias if {X, Y, Z} alias. 
                    // Note that we postpone the alias analysis until the next iteration of the core algorithm, 
                    //  at which stage all transitive nodes are going to be processed. 
                    let alias_name = `${pred_alias_name}.${fname}[${state.name}]`
                    let alias = this.mkNode(alias_name, succ_innerval, false, field_type)
                    this.transitive_nodes.set(alias.id, alias)
                    Logger.info(` ${alias.repr(true, true)}`)
                    return alias
                })
                succ = aliasing_succs.pop()!
                this.nonAliasingNodesMap.set(key, succ)
            }
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
    
    /** Backend-specific code */

    private nullNodeName(): string {
        return this.isCarbon() ? 'null' : '$Ref.null'
    }

    /** Returns true iff 'lhs' is the name of the prototype of the 'rhs' */
    private isPrototypeOf(proto: string, name: string) {
        return this.innerToProto(name) === proto
    }

    private collectStates(): Array<State> {
        // Collect states as inner values of the SMT model
        let states = Object.entries(this.model!).filter(pair => {
            let entry_name = pair[0]
            let entry = pair[1]
            if (this.isCarbon()) {
                return entry.type === 'constant_entry' && entry_name.includes('Heap')
            } else {
                return entry.type === 'constant_entry' && (<ConstantEntry> entry).value.startsWith('$FVF<')
            }
        }).map(pair => new State(pair[0], (<ConstantEntry> pair[1]).value))

        // Merge aliasing states
        let non_aliasing_states = new Map<string, State>()
        states.forEach(state => {
            if (non_aliasing_states.has(state.val)) {
                let non_aliasing_state = non_aliasing_states.get(state.val)!
                non_aliasing_state.aliases.push(state.name)
            } else {
                non_aliasing_states.set(state.val, state)
            }
        })
        
        return Array.from(non_aliasing_states.values())
    }

    private static isStateLabel(idn: string): boolean {
        let m = idn.match(/^l\d+$/)
        return m !== null && m !== undefined
    }

    private getStateNames(): Array<string> {
        return this.programDefinitions!.filter(def => 
            Session.isStateLabel(def.name)).map(state_lbl_def => state_lbl_def.name)
    }

    private remapStates(states: Array<State>): Array<State> {
        let state_lbl_fun = Object.entries(this.model!).find(pair => pair[0] === '$state')
        if (state_lbl_fun === undefined) {
            return states
        } else {
            // 0. Find the defined state names, e.g. l0, l1, l2, ...
            let state_names = new Set(this.getStateNames())

            // 1. Find entries for each state name, 
            //    e.g. l0:{type:"constant_entry", value:"T@U!val!1"}
            let state_name_entries = new Map<string, ConstantEntry>()
            Object.entries(this.model!).forEach(pair => {
                let entry_name = pair[0]
                let entry = pair[1]
                if (state_names.has(entry_name)) {
                    if (entry.type !== 'constant_entry') {
                        throw `expected constant_entry for '${entry_name}' in the model, but found ${entry.type}`
                    } else {
                        state_name_entries.set(entry_name, <ConstantEntry> entry)
                    }
                }
            })

            // 2. Map raw states to state names using the $state function
            let state_lbl_entry = state_lbl_fun[1]
            let remapped_states = new Map<string, State>()
            states.forEach(raw_state => {
                if (!remapped_states.has(raw_state.val)) {
                    state_name_entries.forEach((state_entry, state_name) => {
                        // The expected arguments of $state are: (1) heap/state, (2) current_footprint, (3) state_name
                        //  we substitute these as follows:          raw_state       wildcard               state_name.val
                        let [res, status] = Session.appleEntry(state_lbl_entry, [raw_state.val, undefined, state_entry.value])
                        if (this.parseInnervalAsSmtBool(res) === 'true') {
                            let proper_state = new State(state_name, raw_state.val, raw_state.aliases)
                            remapped_states.set(raw_state.val, proper_state)
                        }
                    })
                }
            })

            // 3. Return sorted, named states
            return Array.from(remapped_states.values()).sort((a: State, b: State) => a.name.localeCompare(b.name))
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
            let first = getConstantEntryValue(first_entry)
        
            if (field) {
                // this is Carbon
                let second_entry = map_case.args[field_index!]
                let second = getConstantEntryValue(second_entry)
                if (first === reciever && second === field) {
                    let val = getConstantEntryValue(map_case.value)
                    res_map.set(state, val)
                }
            } else {
                if (first === reciever) {
                    let val = getConstantEntryValue(map_case.value)
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

    private applySetInMapEntry(entry: ModelEntry, graph: Graph, node: GraphNode): [string, Status] {
        if (this.isCarbonTypeEncodingA()) {
            return Session.appleEntry(entry, [undefined, undefined, graph.val, node.val])
        } else if (this.isCarbonTypeEncodingP()) {
            return Session.appleEntry(entry, [graph.val, node.val])
        } else {
            return Session.appleEntry(entry, [node.val, graph.val])
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

        let m2 = inner_name.match(/(.*)@(.*)@(\d+)/)
        if (m2 !== null) {
            return { proto: m2[1], suffix: m2[2], index: parseInt(m2[3]) }
        }
        let m1 = inner_name.match(/(.*)@(\d+)/)
        if (m1 !== null) {
            return { proto: m1[1], index: parseInt(m1[2]) }
        }
        let m0 = inner_name.match(/(.*)_(\d+)/)
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

    /* We are interested in verifying the failed assertion --- 
    *   a property of the last reachable state in the trace. 
    *  Since Silicon uses the SSA form, we need to keep only only 
    *   the latest version of each variable in the counterexample. 
    *  e.g. "X@1", "X@2", "X@3" --> "X@3"
    */ 
    private extractLatestAssignedVars(nodes: Array<Node>): Array<Node> {
        if (this.isCarbon()) {
            return nodes
        } else {
            let ssa_map = new Map<string, [number, Node]>()
            let immutable_things = new Array<Node>()

            nodes.forEach(node => {
                let names = node.aliases
                if (names.length > 1) {
                    throw `at this point, each node is expected to have only one name`
                }
                let name = names[0]
                let name_struct = Session.innerNameParser(name)
                let proto = name_struct.proto
                let index = name_struct.index
                if (index === undefined) {
                    // No index --- that means this is an immutable thing and we should keep it. 
                    //  e.g. "s@$"
                    immutable_things.push(node)
                } else {
                    // Maximize the index for each prototype
                    if (ssa_map.has(proto)) {
                        let max_index_so_far = ssa_map.get(proto)![0]
                        if (max_index_so_far < index) {
                            ssa_map.set(proto, [index, node])
                        } 
                    } else {
                        ssa_map.set(proto, [index, node])
                    }
                }
            })

            return Array.from(ssa_map.values()).map(pair => pair[1]).concat(immutable_things)
        }
    }
}
