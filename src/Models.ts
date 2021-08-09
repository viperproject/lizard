import { collect } from "./tools"

// Used to indicate that a partial model does not specify a value for some cases in a function interpretation. 
export type SmtBool = 'unspecified' | 'true' | 'false'

export function castToSmtBool(val: string): SmtBool {
    if (val === '#unspecified') {
        return 'unspecified'
    } else if (['true', 'false'].includes(val)) {
        return <SmtBool> val
    } else {
        throw `cannot cast ${val} to SmtBool`
    }
}

export interface ModelEntry {
    type: 'constant_entry' | 'application_entry' | 'map_entry'
}

export class ConstantEntry implements ModelEntry {
    type: 'constant_entry' | 'application_entry' | 'map_entry' = 'constant_entry'
    value: string
    constructor(readonly v: string) {
        this.value = v
    }
}

export function getConstantEntryValue(entry: ModelEntry): string {
    if (entry.type !== 'constant_entry') {
        throw `expected entry of type 'constant_entry'; got '${entry.type}'`
    }
    return (<ConstantEntry> entry).value
}

export interface FunctionValue {
    args: Array<ModelEntry>
    name: string
}

export class ApplicationEntry implements ModelEntry {
    type: 'constant_entry' | 'application_entry' | 'map_entry' = 'application_entry'
    constructor(readonly value: FunctionValue) {}
}

export interface ModelCase {
    args: Array<ModelEntry>
    value: ModelEntry
}

export class MapEntry implements ModelEntry {
    type: 'constant_entry' | 'application_entry' | 'map_entry' = 'map_entry'
    cases: Array<ModelCase>  
    default: ModelEntry
    constructor(readonly cs: Array<ModelCase>, df: ModelEntry) {
        this.cases = cs
        this.default = df
    }
}

export function castToMapEntry(entry: ModelEntry): MapEntry {
    if (entry.type === 'map_entry') {
        return <MapEntry> entry
    } else {
        throw `cannot interpret '${entry}' as map entry`
    }
}

export interface Model {
    [Key: string]: ModelEntry
}

export interface ViperType {
    typename: string
}

export class PrimitiveTypes {
    private constructor() {}

    private static ref_type: ViperType = { typename: "Ref" }
    public static readonly Ref = PrimitiveTypes.ref_type

    private static int_type: ViperType = { typename: "Int" }
    public static readonly Int = PrimitiveTypes.int_type 

    private static bool_type: ViperType = { typename: "Bool" }
    public static readonly Bool = PrimitiveTypes.bool_type

    private static perm_type: ViperType = { typename: "Perm" }
    public static readonly Perm = PrimitiveTypes.perm_type
}

export function isBool(type: ViperType): boolean {
    return type.typename === 'Bool'
}

export function isInt(type: ViperType): boolean {
    return type.typename === 'Int'
}

export function isPerm(type: ViperType): boolean {
    return type.typename === 'Perm'
}

export function isRef(type: ViperType): boolean {
    return type.typename === 'Ref'
}

export function isNull(node: NodeClass): boolean {
    return node.type.typename === 'Ref' && (<GraphNode> node).isNull
}

export function isSetOfRefs(type: ViperType): boolean {
    return type.typename === 'Set[Ref]'
}

class SetType implements ViperType {
    typename: string
    constructor(readonly type_arg: ViperType) {
        this.typename = `Set[${type_arg.typename}]`
    }
}  

class OtherType implements ViperType {
    typename: string 
    constructor(readonly enc_value: string) {
        this.typename = `Other[${enc_value}]`
    }
} 


export class PolymorphicTypes {
    private constructor() {}

    private static set_types = new Map<ViperType, SetType>()
    public static Set(type_arg: ViperType) { 
        if (PolymorphicTypes.set_types.has(type_arg)) {
            return PolymorphicTypes.set_types.get(type_arg)!
        } else {
            let new_set_type = new SetType(type_arg)
            PolymorphicTypes.set_types.set(type_arg, new_set_type)
            return new_set_type
        }
    }

    private static other_type = new Map<string, OtherType>()
    public static Other(enc_value: string) { 
        if (PolymorphicTypes.other_type.has(enc_value)) {
            return PolymorphicTypes.other_type.get(enc_value)!
        } else {
            let new_other_type = new OtherType(enc_value)
            PolymorphicTypes.other_type.set(enc_value, new_other_type)
            return new_other_type
        }
    }
}

export function viperTypeParser(typename: string) {
    let type: ViperType
    if (typename === 'Ref') {
        type = PrimitiveTypes.Ref
    } else if (typename === 'Set[Ref]') {
        type = PolymorphicTypes.Set(PrimitiveTypes.Ref)
    } else if (typename === 'Int') {
        type = PrimitiveTypes.Int
    } else if (typename === 'Bool') {
        type = PrimitiveTypes.Bool
    } else if (typename === 'Perm') {
        type = PrimitiveTypes.Perm
    } else {
        let m = typename.match(/^Other\[(.*)\]$/)
        if (m === null || m === undefined || !Array.isArray(m) || m.length !== 2) {
            throw `cannot parse typename ${typename}`
        }
        type = PolymorphicTypes.Other(m[1])
    }
    return type 
}


// TODO: support other types e.g. Maps, Multisets, etc. 

export class Atom {
    /** This dynamic field enables JSONFormatter to pretty pront the node. */
    private _: string 

    public name(withoutState=false, html=false): string {
        if (withoutState) {
            return this.proto
        }

        let state = this.states.map(s => s.nameStr()).join('/')
        if (state !== '' && html) {
            state = `<SUB><FONT POINT-SIZE="10">${state}</FONT></SUB>`
        } else if (state !== '') {
            state = `@${state}`
        }
        
        return `${this.proto}${state}`
    }

    public repr(withoutType=false, withoutValue=false, withoutState=false, html=false): string { 
        let readable_name = this.name(withoutState, html)
        let val = withoutValue ? `` : ` = ${this.val}`

        if (!withoutType) {
            return `${readable_name}: ${this.type.typename}${val}`
        } else {
            return `${readable_name}${val}`
        }
    }
    constructor(readonly type: ViperType,                 // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                readonly id: number,                    // 0, 1, 2, ...
                readonly val: string,                     // e.g. "$Ref!val!0"
                readonly isLocal: boolean,              // whether this ndoe is refer to from the program store
                readonly proto: string, 
                readonly states: Array<State> = []) { // e.g. "X"
    
        this._ = this.repr()
    }
}

export class NodeClass {
    public repr(withoutType=false, withoutValue=false, withoutState=false, onlyLocal=false, html=false): string {
        let readable_name_list = 
            this.aliases
                .filter(a => onlyLocal ? a.isLocal : true)
                .map(a => `${a.name(withoutState, html)}`)
        let readable_name: string
        if (withoutState) {
            readable_name = Array.from(new Set(readable_name_list)).sort((a,b) => a.localeCompare(b)).join('=')
        } else {
            readable_name = readable_name_list.sort((a,b) => a.localeCompare(b)).join('=')
        }
        let val = withoutValue ? `` : ` = ${this.val}`
        if (!withoutType) {
            return `${readable_name}: ${this.type.typename}${val}`
        } else {
            return `${readable_name}${val}`
        }
    }
    constructor(readonly id: number, 
                readonly val: string, 
                readonly type: ViperType,
                public aliases: Array<Atom>) {}            
            
    protected copy(aliases: Array<Atom> | undefined = undefined): NodeClass {
        aliases = (aliases === undefined) ? Array.from(this.aliases) : aliases
        return new NodeClass(this.id, this.val, this.type, aliases)
    }

    public project(stateHashes: Set<string>): NodeClass | undefined {
        let activeAliases = this.aliases.filter(alias => {
            if (alias.states.length === 0) {
                // This atom is active in all states; keep it
                return true
            } else {
                let activeStates = alias.states.filter(state => stateHashes.has(state.nameStr()))
                if (activeStates.length === 0) {
                    // this atom is not active in any of the active states; drop it
                    return false
                } else {
                    // this atom is active in some of the active states; project it
                    return new Atom(alias.type, alias.id, alias.val, alias.isLocal, alias.proto, activeStates)
                }
            }
        })
        if (activeAliases.length === 0) {
            return undefined
        } else {
            return this.copy(activeAliases)
        }
    }

    public isLocal(): boolean {
        return this.aliases.find(a => a.isLocal) !== undefined
    }
}

export class GraphNode extends NodeClass {
    
    constructor(readonly id: number, 
                readonly val: string,
                readonly isNull: boolean,
                readonly aliases: Array<Atom>,
                public fields: Array<Relation> = new Array()) {
        
        super(id, val, PrimitiveTypes.Ref, aliases)
    }

    protected override copy(aliases: Array<Atom> | undefined = undefined): GraphNode {
        aliases = (aliases === undefined) ? Array.from(this.aliases) : aliases
        return new GraphNode(this.id, this.val, this.isNull, aliases, Array.from(this.fields))
    }

    public override project(stateHashes: Set<string>): GraphNode | undefined {
        return <GraphNode | undefined> super.project(stateHashes)
    }
    
    public static from(nc: NodeClass, isNull=false): GraphNode {
        if (isRef(nc.type)) {
            return new GraphNode(nc.id, nc.val, isNull, nc.aliases)
        } else {
            throw `cannot cast node class of type ${nc.type.typename} to GraphNode`
        }
    }
}

export class Graph extends NodeClass {

    constructor(readonly id: number,
                readonly val: string, 
                readonly aliases: Array<Atom> = [],
                private nodes: Array<GraphNode> = [],
                private statuses: {[NodeId: number]: Status} = {}) {

        super(id, val, PolymorphicTypes.Set(PrimitiveTypes.Ref), aliases)
    }

    protected override copy(aliases: Array<Atom> | undefined = undefined): Graph {
        aliases = (aliases === undefined) ? Array.from(this.aliases) : aliases
        return new Graph(this.id, this.val, aliases, Array.from(this.nodes), Object.assign({}, this.statuses))
    }

    public override project(stateHashes: Set<string>): Graph | undefined {
        let proj = super.project(stateHashes)
        if (proj === undefined) {
            return undefined
        } else {
            let projectedGraph = (<Graph> <unknown> proj)
            projectedGraph.nodes = this.nodes.flatMap(node => collect(node.project(stateHashes)))
            return projectedGraph
        }
    }

    public static from(nc: NodeClass): Graph {
        if (isSetOfRefs(nc.type)) {
            return new Graph(nc.id, nc.val, nc.aliases)
        } else {
            throw `cannot cast node class of type ${nc.type.typename} to Graph`
        }
    }

    public addNode(node: GraphNode, status: Status): void {
        if (this.hasNode(node)) {
            throw `graph ${this.repr()} already has ${node.repr()}`
        }
        this.nodes.push(node)
        this.statuses[node.id] = status
    }

    public getNodesSet(): Set<GraphNode> {
        return new Set(this.nodes)
    }

    public getNodesArray(): Array<GraphNode> {
        return this.nodes
    }

    public hasNode(node: GraphNode): boolean {
        return this.statuses.hasOwnProperty(node.id)
    }

    public getNodeStatus(node: GraphNode): Status {
        if (this.hasNode(node)) {
            return this.statuses[node.id]
        } else {
            throw `graph ${this.repr()} does not contain ${node.repr()}`
        }
    }

    public mapNodes<U>(callbackfn: (value: GraphNode, index: number, nodes: Array<GraphNode>) => U, thisArg?: any): Array<U> {
        return Array.from(this.nodes).map(callbackfn, thisArg)
    }
    public filterNodes(predicate: (value: GraphNode, index: number, array: Array<GraphNode>) => boolean, thisArg?: any): Array<GraphNode> {
        return Array.from(this.nodes).filter(predicate, thisArg)
    }
}

export type Status = 'from_cases' | 'constant' | 'fun_app' | 'default' | 'unknown'

export class Relation {
    protected _: string
    constructor(readonly name: string,  // e.g. "NEXT", "edge", or "exists_path"
                readonly state: State,  // e.g. { name: "Heap@@1", val: "T@U!val!11" }
                readonly pred_id: number, 
                readonly succ_id: number, 
                readonly status: Status = 'unknown') {
    
        this._ = `${name}[ ${state.nameStr()} ](N${pred_id}, N${succ_id})`
    }

    public hash(): string {
        return this._
    }

    public repr(full_details: boolean = false): string {
        return this._
    }
}

export class LocalRelation extends Relation {
    constructor(readonly name: string, 
                readonly state: State, 
                readonly graph_id: number, 
                readonly pred_id: number, 
                readonly succ_id: number, 
                readonly status: Status = 'unknown') {
    
        super(name, state, pred_id, succ_id, status)
        this._ = `${name}[ ${state.nameStr()} ](G${graph_id}, N${pred_id}, N${succ_id})`
    }
}

export class State { 

    public val: string = this.valStr()
    public name: string = this.nameStr()

    constructor(readonly names: Array<string>,  // e.g. l0, l1, ...
                readonly innervals: Array<string>, 
                public aliases: Array<string>,
                readonly localStoreHash: string | undefined = undefined) { // e.g. Heap@1, PostHeap@@2, etc.
        
        Object.defineProperty(this, 'name', {
            get: function() {
                return this.nameStr()
            }
        })

        Object.defineProperty(this, 'val', {
            get: function() {
                return this.valStr()
            }
        })
    }

    public nameStr(): string {
        return this.names.join('/')
    }

    public valStr(): string {
        return this.innervals.join('=')
    }

    public hash(): string {
        if (this.localStoreHash === undefined) {
            return this.nameStr()
        } else {
            return `${this.nameStr()}///${this.localStoreHash}`
        }
    }

    public isStrictlyPreceding(other: State): boolean {
        return this.nameStr().localeCompare(other.nameStr()) < 0
    }
}

export class GraphModel {
    constructor(
        public states: Array<State> = [], 
        public graphs: Array<Graph> = [],

        public footprints = {'client': new Array<Graph>(), 'callee': new Array<Graph>()},

        public graphNodes: Array<GraphNode> = [],
        public scalarNodes: Array<NodeClass> = [],

        public fields: Array<Relation> = [],
        public reach: Array<LocalRelation> = [],

        public equivalence_classes: EquivClasses = new EquivClasses()) {}

}

export class EquivClasses {
    
    // mapping keys to nodes
    private __buf: { 
        [Key: string]: Array<Atom>,
    } = {}

    static __keySep = '///'

    public static key(innerval: string, type: ViperType): string {
        return `${innerval}${EquivClasses.__keySep}${type.typename}`
    }

    private static keyToValueType(key: string): [string, ViperType] {
        let pair = key.split(EquivClasses.__keySep)
        if (pair.length !== 2) {
            throw `invalid EquivClasses key: ${key}`
        }
        let innerval = pair[0]
        let typename = pair[1]
        let type = viperTypeParser(typename)
        return [innerval, type]
    }

    public has(innerval: string, type: ViperType): boolean {
        let key = EquivClasses.key(innerval, type)
        return this.__buf.hasOwnProperty(key)
    }

    public get(innerval: string, type: ViperType): Array<Atom> {
        let key = EquivClasses.key(innerval, type)
        return this.__buf[key]
    }

    public add(innerval: string, type: ViperType, node: Atom): void {
        let key = EquivClasses.key(innerval, type)
        if (this.__buf.hasOwnProperty(key)) {
            this.__buf[key].push(node)
        } else {
            this.__buf[key] = new Array(node)
        }
    }

    public set(innerval: string, type: ViperType, nodes: Array<Atom>): void {
        let key = EquivClasses.key(innerval, type)
        this.__buf[key] = nodes
    }

    public toNodeClassArray(idGen: () => number): Array<NodeClass> {
        return Object.entries(this.__buf).map(pair => {
            let key = pair[0]
            let aliases = pair[1]
            let [value, type] = EquivClasses.keyToValueType(key)
            return new NodeClass(idGen(), value, type, aliases)
        })
    }

    public static from(atoms: Array<Atom>): EquivClasses {
        let eq = new EquivClasses()
        atoms.forEach(atom => eq.add(atom.val, atom.type, atom))
        return eq
    }
}

export class NodeSet {
    private __ec =  new EquivClasses()
    private __ns = new Map<string, NodeClass>()

    public getNodeClasses(): Array<NodeClass> {
        return Array.from(this.__ns.values())
    }
    
    public has(innerval: string, type: ViperType): boolean {
        return this.__ns.has(EquivClasses.key(innerval, type))
    }

    public get(innerval: string, type: ViperType): NodeClass | undefined {
        return this.__ns.get(EquivClasses.key(innerval, type))
    }

    public getNode(innerval: string, type: ViperType): NodeClass | undefined {
        let res = this.__ns.get(EquivClasses.key(innerval, type))
        return res
    }

    public add(node: NodeClass): void {
        this.__ns.set(EquivClasses.key(node.val, node.type), node)
        this.__ec.set(node.val, node.type, node.aliases)
    }

    public merge(nodes: Array<NodeClass>): Array<NodeClass> {
        let newNodes = new Array<NodeClass>()
        nodes.forEach(node => {
            if (this.has(node.val, node.type)) {
                // Matches exisitng node class ==> merge
                let existingClass = this.get(node.val, node.type)!
                let extendedAliases = Array.from(new Set(existingClass.aliases.concat(node.aliases)))
                this.__ec.set(node.val, node.type, extendedAliases)
                existingClass.aliases = extendedAliases
            } else {
                // Does not match any existing class ==> add all its aliases and save
                this.add(node)
                newNodes.push(node)
            }
        })
        return newNodes
    }
}