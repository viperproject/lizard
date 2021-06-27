import { node } from "webpack"
import { Logger } from "./logger"
import { PolymorphicTypes, getConstantEntryValue, ApplicationEntry, Model, Node, State, Relation, EquivClasses, GraphModel, ConstantEntry, ModelEntry, MapEntry, Graph, GraphNode, isRef, isSetOfRefs, ViperType, LocalRelation } from "./Models"
import { Query } from "./Query"
import { Type, TypedViperDefinition, ViperDefinition, ViperLocation } from "./ViperAST"
import { ViperTypesProvider } from "./ViperTypesProvider"

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
        return this.backend.includes('silicon')
    }
    public isCarbon(): boolean {
        return this.backend.includes('carbon')
    }

    private viperTypes: ViperTypesProvider | undefined = undefined
    
    constructor(public backend: string, 
                private __next_node_id = 0) {}

    private freshNodeId(): number {
        let next_node_id = this.__next_node_id
        this.__next_node_id ++
        return next_node_id
    }

    private mkNode(name: string, innerval: string, is_local: boolean, 
                   type: ViperType | undefined = undefined, proto: string | undefined = undefined): Node {

        // Special case the null node
        if (name === this.nullNodeName()) {
            this.null_node = new GraphNode([name], true, this.freshNodeId(), innerval, false, proto)
            return this.null_node!
        }
        if (!type) {
            // If type is not provided, try to retrieve it from available program definitions
            type = this.viperTypes!.get(name)
            if (!type) {
                // Fallback to Other type
                Logger.warn(`no type information for ${name} = ${innerval}`)
                type = PolymorphicTypes.Other(innerval)
            }
        }
        if (type.typename === 'Set[Ref]') {
            return new Graph([], [name], this.freshNodeId(), innerval, is_local, proto)
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
            (innername: string) => this.innerToProto(this.isCarbon(), innername))  

        // 1. Collect program states 
        this.states = this.collectStates()

        // 2. Extract all atoms (i.e. top-level constant_entries) from the raw model. 
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
        this.collectEquivClasses(this.atoms!, this.extended_equiv_classes)
    }

    private equiv_classes = new EquivClasses()

    private collectEquivClasses(nodes: Array<Node>, ec: EquivClasses): void {
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

        // Find atoms that define graph nodes
        let atoms = names.flatMap(proto => 
            this.atoms!.filter(atom => {
                if (atom.aliases.length > 1) {
                    throw `each node should have one internal name at this point, ` + 
                          `but ${JSON.stringify(atom)} has more.`
                }
                let atom_name = atom.aliases[0]
                return this.isPrototypeOf(proto, atom_name)
            }).map(atom => {
                // Set the prototype variable for this atom
                atom.proto = proto
                return atom
            }))

        // Check that all expected nodes are defined in each state
        if (atoms.length < names.length) {
            Logger.warn(`could not find definitions for some graph nodes in raw model`)
        }

        // Filter old versions of variables in case the encoding uses SSA
        return this.extractLatestAssignedVars(atoms)
    }

    // map from inner values to nodes
    private nonAliasingNodesMap = new Map<string, Node>()

    private mergeAliases(nodes: Array<Node>): Array<Node> {

        let new_nonaliasing_nodes = new Set<Node>()

        nodes.forEach(node => {
            // TODO: decide what to check and/or report in this case
            // if (node.aliases.length > 1) {
            //     Logger.warn(`...`)
            // }
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
                            let is_reachable = state_to_rels(state)
                            let r = is_reachable ? 'P' : '¬P'
                            let new_rel = new LocalRelation(r, state, graph.id, pred_node.id, succ_node.id)
                            reach_rels.add(new_rel)
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
                let rels = this.states!.map(state => {
                    let adj_node = state_to_rels(state)
                    return new Relation(fname, state, node.id, adj_node.id)
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
                let val = this.applySetInMapEntry(rel!, graph, node)
                if (this.isInnerValueTrue(val)) {
                    // this node belongs to this graph
                    graph.nodes.push(node)
                }
            })
        })
    }

    private node_hash = new Map<number, Node>()
    private graphs = new Set<Graph>()
    
    private graph_nodes = new Array<GraphNode>()
    private scalar_nodes = new Array<Node>()
    private fields = new Array<Relation>()
    private reach = new Array<LocalRelation>()

    private produceGraphModelRec(starting_atoms: Array<Node>, iteration=1) {
        Logger.info(`iteration №${iteration} of analyzing the heap model`)
        
        // A. Update hash s.t. nodes can be retrieved efficiently, via their IDs
        starting_atoms.forEach(node => {
            if (this.node_hash.has(node.id)) {
                throw `saturation error: node with ID ${node.id} is already present in the node hash`
            }
            this.node_hash.set(node.id, node)
        })

        // B. Deduce and merge aliasing nodes 
        this.collectEquivClasses(starting_atoms, this.equiv_classes)
        let new_nonaliasing_nodes = this.mergeAliases(starting_atoms)

        // C. Split nodes into Ref-typed and all others
        let new_graph_nodes = new Array<GraphNode>()
        new_nonaliasing_nodes.forEach(node => {
            if (node.type && isRef(node.type)) {
                new_graph_nodes.push(<GraphNode> node)
            } else if (node.type && isSetOfRefs(node.type)) {
                this.graphs.add(<Graph> node)
            } else {
                this.scalar_nodes.push(node)
            }
        })
        this.graph_nodes.push(...new_graph_nodes)

        // D. Determine which Ref-based nodes belong to which graphs (i.e. Set[Ref]-based nodes)
        this.connectNodesToGraphs(new_graph_nodes, this.graphs)

        // E1. Collect information about fields  
        let non_null_nodes = new_graph_nodes.filter(n => !n.isNull)
        let new_fields = this.collectFields(non_null_nodes)
        this.fields.push(...new_fields)

        // E2. Collect reachability information
        let reach = this.collectReach(non_null_nodes)
        this.reach.push(...reach)

        // F1. Some of the relations may lead to new nodes that must be encountered for in the model. 
        let trans_nodes = Array.from(this.transitive_nodes.values())
        this.transitive_nodes = new Map<number, Node>()

        // G. Saturate! 
        if (trans_nodes.length > 0) {
            this.produceGraphModelRec(trans_nodes, iteration+1)
        } else {
            Logger.info(`🎩 saturation completed 🎩`)
        }

        // H. Return model
        this.graphModel = new GraphModel(this.states!, Array.from(this.graphs), this.graph_nodes, this.scalar_nodes, 
                                         this.fields, this.reach, this.equiv_classes)

        return this.graphModel!
    }

    public produceGraphModel(): GraphModel {
        // O. Collect initial nodes
        let starting_atoms = this.collectInitialGraphsAndNodes()
        // I. Process and Saturate! 
        return this.produceGraphModelRec(starting_atoms)
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
                             pred_node: GraphNode, succ_node: GraphNode): (state: State) => boolean {

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
        let inner_fun = (state: string) => Session.appleEntry($$, [state, graph.val])
        

        /** Step 3 -- combine the decoded functions */
        return (state: State) => {
            let edge_graph = inner_fun(state.val)
            let predicate_val = outer_fun(edge_graph)
            if (predicate_val !== 'true' && predicate_val !== 'false') {
                throw `got unexpected value for a reachability predicate: ${predicate_val}`
            }
            if (predicate_val === 'true') {
                return true
            } else {
                return false
            }
        }
    }

    private collectFieldValueInfo(node: Node, fname: string): (state: State) => Node {
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
            let succ_innerval = simple_fun(state.val)
            let field_type = this.viperTypes!.get(fname)
            let key = EquivClasses.key(succ_innerval, field_type)
            let succ: Node
            if (this.nonAliasingNodesMap.has(key)) {
                // succ already has a representative node
                succ = this.nonAliasingNodesMap.get(key)!
            } else {
                // this is a fresh value; create a new atom (per alias) to support it
                Logger.info(`no atom found for value ${succ_innerval} of type ${field_type}; ` + 
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
            return succ
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
     private static evalEntry(entry: ModelEntry, args: Array<string>): string {
        if (entry.type === 'constant_entry') {
            return getConstantEntryValue(entry)

        } else if (entry.type === 'application_entry') {
            let app_entry = (<ApplicationEntry> entry)
            let fun = app_entry.value.name
            let fun_args = app_entry.value.args
            let sub_results = fun_args.map(fun_arg => Session.evalEntry(fun_arg, args))
            if (fun === 'and') {
                // do all arguments evaluate to 'true'?
                return sub_results.every(sub_res => sub_res === 'true') ? 'true' : 'false'
            } else if (fun === 'or') {
                // do some arguments evaluate to 'true'?
                return sub_results.some(sub_res => sub_res === 'true') ? 'true' : 'false'
            } else if (fun === 'not' || fun === '!') {
                // negate the argument 
                return sub_results[0] === 'true' ? 'false' : 'true'
            } else if (fun === '=') {
                // check that all arguments of '=' evaluate to the same value
                return (new Set(sub_results)).size === 1 ? 'true' : 'false'
            } else if (fun === ':var') {
                let arg_index = parseInt(getConstantEntryValue(fun_args[0]))
                return args[arg_index]
            } else {
                throw `unsupported function: '${fun}'`
            }
            
        } else {
            return Session.appleEntry(entry, args)
        }
    }

    static appleEntry(entry: ModelEntry, args: Array<string>): string {
        if (entry.type === 'constant_entry') {
            let const_entry = <ConstantEntry> entry
            return const_entry.value
        } else if (entry.type === 'application_entry') {
            let app_entry = (<ApplicationEntry> entry)
            return Session.evalEntry(app_entry, args)
        } else {
            let map_entry = <MapEntry> entry
            let res_entry_maybe = map_entry.cases.find(map_case => {
                
                let matches = args.map((arg, index) => {
                    let case_arg = getConstantEntryValue(map_case.args[index])
                    return arg === case_arg
                })
                return matches.every(x => x)
            })
            if (res_entry_maybe) {
                let case_entry = res_entry_maybe!.value
                let case_val = Session.appleEntry(case_entry, args)
                return case_val
            } else {
                let default_entry = map_entry.default
                let default_val = Session.appleEntry(default_entry, args)
                return default_val
            } 
        }
    }
    
    /** Backend-specific code */

    private nullNodeName(): string {
        return this.isCarbon() ? 'null' : '$Ref.null'
    }

    /** Returns true iff 'lhs' is the name of the prototype of the 'rhs' */
    private isPrototypeOf(proto: string, name: string) {
        if (this.isCarbon()) {
            return name.split('@')[0] === proto
        } else {
            // TODO: check this
            return name.split('@')[0] === proto
        }
    }

    private collectStates(): Array<State> {
        return Object.entries(this.model!).filter(pair => {
            let entry_name = pair[0]
            let entry = pair[1]
            if (this.isCarbon()) {
                return entry.type === 'constant_entry' && entry_name.includes('Heap')
            } else {
                return entry.type === 'constant_entry' && (<ConstantEntry> entry).value.startsWith('$FVF<')
            }
        }).map(pair => new State(pair[0], (<ConstantEntry> pair[1]).value))
    }

    private partiallyApplyReachabilityRelation(m_entry: MapEntry, pred: string, succ: string): (edge_graph: string) => string {
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
                return res_map.get(edge_graph)!
            } else {
                return default_val
            }
        }
    }

    private partiallyApplyFieldMapEntry(m_entry: MapEntry, reciever: string, field: string | undefined): (state: string) => string {
        let res_map = new Map<string, string>()

        m_entry.cases.forEach(map_case => {
            let state_entry = map_case.args[0]
            let state = getConstantEntryValue(state_entry)

            // Check if this case matches the provided partial arguments
            let first_entry = map_case.args[1]
            let first = getConstantEntryValue(first_entry)
        
            if (field) {
                let second_entry = map_case.args[2]
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
                return res_map.get(state)!
            } else {
                return default_val
            }
        }
    }

    private reachabilityRelationNames(): Array<string> {
        if (this.isCarbon()) {
            return ['exists_path', 'exists_path_']
        } else {
            return ['exists_path<Bool>', 'exists_path_<Bool>']
        }
    }

    private fieldLookupRelationName(fname: string): string {
        return this.isCarbon() ? '[3]' : `$FVF.lookup_${fname}`
    }

    private setIncludesRelationName(): string {
        return this.isCarbon() ? '[2]' : 'Set_in'
    }

    private applySetInMapEntry(entry: ModelEntry, graph: Graph, node: GraphNode): string {
        if (this.isCarbon()) {
            return Session.appleEntry(entry, [graph.val, node.val])
        } else {
            return Session.appleEntry(entry, [node.val, graph.val])
        }
    }

    private isInnerValueTrue(innerval: string): boolean {
        if (innerval === 'true') {
            return true
        }
        if (innerval === 'false') {
            return false
        }
        if (this.isCarbon()) {
            let U_2_bool = this.getEntryByName('U_2_bool')
            if (!U_2_bool) {
                throw `cannot interpret value '${innerval}' of uninterpreted type to Boolean: model does not define 'U_2_bool'`
            }
            let bool_str = Session.appleEntry(U_2_bool, [innerval])
            if (bool_str !== 'true' && bool_str !== 'false') {
                throw `cannot parse value '${bool_str}' as Boolean`
            }
            return bool_str === 'true'
        } else {
            if (innerval !== 'true' && innerval !== 'false') {
                throw `cannot parse value '${innerval}' as Boolean`
            }
            return innerval === 'true'
        }
    }

    private fieldNodeValue(fname: string): string | undefined {
        if (this.isCarbon()) {
            let field_node_entry = this.model![fname]
            let field_node_val = getConstantEntryValue(field_node_entry)
            return field_node_val
        } else {
            return undefined
        }
    }

    private static innerNameParser(inner_name: string): 
        { proto: string, suffix?: number, index?: number } {

        let m2 = inner_name.match(/(.*)@(\d+)@(\d+)/)
        if (m2 && m2[1] && m2[2] && m2[3]) {
            return { proto: m2[1], suffix: parseInt(m2[2]), index: parseInt(m2[3]) }
        }
        let m1 = inner_name.match(/(.*)@(\d+)/)
        if (m1 && m1[1] && m1[2]) {
            return { proto: m1[1], index: parseInt(m1[2]) }
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
    
    private innerToProto(is_carbon: boolean, inner_name: string): string {
        if (is_carbon) {
            return Session.carbonInnerNameToProto(inner_name)
        } else {
            return Session.siliconInnerToProto(inner_name)
        }
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
