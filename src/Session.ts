import { Logger } from "./logger"
import { PrimitiveTypes, PolymorphicTypes, getConstantEntryValue, ApplicationEntry, Model, ViperType, Node, State, Relation, EquivClasses, GraphModel, ConstantEntry, ModelEntry, MapEntry, Graph, GraphNode, FunctionValue } from "./Models"
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

    private mkNode(name: string, innerval: string, proto: string | undefined = undefined): Node {
        // Special case the null node
        if (name === this.nullNodeName()) {
            this.null_node = new GraphNode([name], true, this.freshNodeId(), innerval, proto)
            return this.null_node!
        }
        
        let typ = this.viperTypes!.get(name)
        if (!typ) {
            Logger.warn(`no type information for ${name} = ${innerval}`)
            typ = PolymorphicTypes.Other(innerval)
        }
        if (typ.typename === 'Set[Ref]') {
            return new Graph([], [name], this.freshNodeId(), innerval, proto)
        } else if (typ && typ.typename === 'Ref') {
            return new GraphNode([name], false, this.freshNodeId(), innerval, proto)
        } else {
            return new Node([name], typ, this.freshNodeId(), innerval, proto)
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
    private extended_equiv_classes: EquivClasses | undefined = undefined

    private latestQuery: GraphModel | undefined = undefined 
    private graphModel: GraphModel | undefined = undefined

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

        // this.precomputeViperTypesFromModel()

        // 1. Collect program states 
        this.states = this.collectStates()

        // 2. Extract all atoms (i.e. top-level constant_entries) from the raw model. 
        this.atoms = new Array<Node>()
        Object.entries(this.model!).forEach(pair => {
            let name = pair[0]
            let entry = pair[1]
            
            if (entry.type === 'constant_entry' || entry.type == 'application_entry') {
                let innerval = Session.serializeEntryValue(entry)
                let node = this.mkNode(name, innerval)
                this.atoms!.push(node)
            }
        })

        // 3. Compute equivalence classes amongst all atoms
        this.extended_equiv_classes = this.collectEquivClasses(this.atoms!)
    }

    private collectEquivClasses(nodes: Array<Node>): EquivClasses {
        let res: EquivClasses = new EquivClasses()

        nodes.forEach(node => {
            if (res.hasOwnProperty(node.val)) {
                res[node.val].push(node)
            } else {
                res[node.val] = [node]
            }
        })

        return res
    }

    private collectGraphsAndNodes(): { graphs: Array<Graph>, nodes: Array<Node> } {
        
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
        atoms = this.extractLatestAssignedVars(atoms)

        // Split abstract nodes into Node 
        let graphs = atoms.filter(node => node.hasOwnProperty('nodes')).map(n => <Graph> n)
        let nodes = atoms.filter(node => !node.hasOwnProperty('nodes'))

        return { graphs: graphs, nodes: nodes }
    }

    private mergeAliases(nodes: Array<Node>): Array<Node> {
        let nonAliasingNodesMap = new Map<string, Node>()  // map from inner values to nodes

        nodes.forEach(node => {
            let innerval = node.val
            if (nonAliasingNodesMap.has(innerval)) {
                // We already have a representative for this node inner value
                let na_node = nonAliasingNodesMap.get(innerval)!
                if (node.aliases.length > 1) {
                    throw `aliasing node ${JSON.stringify(node)} is expected to have only one internal name`
                }
                na_node.aliases.push(node.aliases[0])
            } else {
                nonAliasingNodesMap.set(innerval, node)
            }
        })

        return Array.from(nonAliasingNodesMap.values())
    }

    private collectFields(nodes: Array<GraphNode>): Array<Relation> {
        let fnames = this.getDefinitionNames('Field')

        // Check if the method containing the failed assertion uses any fields at all
        let useful_fields = fnames.find(fname => {
            let rel_name = this.fieldLookupRelationName(fname)
            let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
            return rel_maybe !== undefined
        })
        if (useful_fields === undefined) {
            return []
        }

        // Deduce relations for each field, node, state
        let state_to_field_val_funs = fnames.flatMap(fname => 
            nodes.flatMap(node => {
                let state_to_rels = this.collectFieldValueInfo(node, fname)
                let rels = this.states!.map(state => {
                    let adj_node = state_to_rels(state)
                    return new Relation(fname, state, node.id, adj_node.id)
                })
                node.fields = rels
                return rels
            }))

        return state_to_field_val_funs
    }

    private connectNodesToGraphs(nodes: Array<GraphNode>, graphs: Array<Graph>): void {
        let rel_name = this.setIncludesRelationName()
        let rel = this.getEntryByName(rel_name)
        if (!rel) {
            Logger.warn(`the model does not contain the expected relation '${rel_name}'`)
            return
        }
        if (rel.type !== 'map_entry') {
            throw `set-in relation '${rel_name}' is expected to be of type 'map_entry'`
        }
        graphs.forEach(graph => {
            nodes.forEach(node => {
                let val = Session.appleEntry(rel!, [graph.val, node.val])
                if (this.isInnerValueTrue(val)) {
                    // this node belongs to this graph
                    graph.nodes.push(node)
                }
            })
        })
    }

    private node_hash: Map<number, Node> | undefined = undefined

    public produceGraphModel(): GraphModel {
        // A. Collect all the clearly relevant nodes
        let {graphs, nodes} = this.collectGraphsAndNodes()
        
        // B. Hash all nodes for easy access
        this.node_hash = new Map<number, Node>()
        nodes.concat(graphs).forEach(generic_node => this.node_hash!.set(generic_node.id, generic_node))
        
        // C. Merge aliases based on equivalent classes
        let equivalence_classes = this.collectEquivClasses(nodes)
        let non_aliasing_nodes = this.mergeAliases(nodes)
        
        // D. Split nodes into Ref-typed and all others
        let graph_nodes = new Array<GraphNode>()
        let scalar_nodes = new Array<Node>()
        non_aliasing_nodes.forEach(node => {
            if (node.type && node.type.typename === 'Ref') {
                graph_nodes.push(<GraphNode> node)
            } else {
                scalar_nodes.push(node)
            }
        })

        // E. Determine which Ref-based nodes belong to which graphs (Set[Ref]-based nodes)
        this.connectNodesToGraphs(graph_nodes, graphs)
        
        // F. Collect the fields information 
        let fields = this.collectFields(graph_nodes)

        // G. Some of the fields may lead to new nodes that must be encountered for in the model. 
        let new_nodes = fields.filter(field => !this.node_hash!.has(field.succ_id)).map(field => this.node_hash!.get(field.succ_id))
        // TODO: implement saturation 
        
        // TODO: edges, paths
        this.graphModel = new GraphModel(this.states!, graphs, graph_nodes, scalar_nodes, 
                                         fields, [], [], equivalence_classes)
        return this.graphModel!
    }

    public applyQuery(query: Query): GraphModel {

        // Filter the states
        let state_name_hash = new Map<string, undefined>()
        query.states.forEach(state_name => state_name_hash.set(state_name, undefined))

        let filtered_fields = this.graphModel!.fields.filter(field => state_name_hash.has(field.state.name))
        this.latestQuery = new GraphModel()
        Object.assign(this.latestQuery, this.graphModel!)
        this.latestQuery!.fields = filtered_fields
        
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
            let succ: Node
            if (this.extended_equiv_classes!.hasOwnProperty(succ_innerval)) {
                let succs = this.extended_equiv_classes![succ_innerval]
                if (succs.length > 1) {
                    Logger.warn(`multiple values are possible for ${node.aliases}.${fname}; ` + 
                                `perhaps there are multiple program states involved?`)
                }
                succ = succs[0]
            } else {
                // this is a fresh value; create a new atom to support it
                let name = `${node.aliases}.${fname}`
                Logger.warn(`no atom found for value ${succ_innerval} of ${name} in state ${state.name}`)
                succ = this.mkNode(name, succ_innerval)
                this.extended_equiv_classes![succ_innerval] = new Array<Node>(succ)
            }
            return succ
        }
    }

    // private getAtomsByInnerVal(innerval: string): Array<Node> {
    //     return this.atoms!.filter(atom => atom.val === innerval)
    // }

    static appleEntry(entry: ModelEntry, args: Array<string>): string {
        if (entry.type === 'constant_entry') {
            let const_entry = <ConstantEntry> entry
            return const_entry.value
        } else if (entry.type === 'application_entry') {
            throw `entries of type 'application_entry' are not yet supported`
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
                let case_val = getConstantEntryValue(case_entry)
                return case_val
            } else {
                let default_entry = map_entry.default
                let default_val = getConstantEntryValue(default_entry)
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

    private fieldLookupRelationName(fname: string): string {
        return this.isCarbon() ? '[3]' : `$FVF.lookup_${fname}`
    }

    private setIncludesRelationName(): string {
        return this.isCarbon() ? '[2]' : 'Set_in'
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

    private siliconInnerNameParser(inner_name: string): 
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

    private siliconInnerToProto(inner_name: string): string {
        let inner_name_struct = this.siliconInnerNameParser(inner_name)
        return inner_name_struct.proto
    }
    
    private innerToProto(is_carbon: boolean, inner_name: string): string {
        if (is_carbon) {
            return inner_name
        } else {
            return this.siliconInnerToProto(inner_name)
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
                let name_struct = this.siliconInnerNameParser(name)
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
