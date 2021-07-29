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

export function isNull(node: Node): boolean {
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


// TODO: support other types e.g. Maps, Multisets, etc. 

export class Node {
    /** This dynamic field enables JSONFormatter to pretty pront the node. */
    private _: string 

    public repr(withoutType=false, withoutValue=false, withoutState=false, html=false): string {
        let readable_name = Array.isArray(this.aliases) ? `${this.aliases.join(' = ')}` : this.aliases
        let val = withoutValue ? `` : ` = ${this.val}`
        
        let state = this.states.map(s => s.nameStr()).join('/')
        if (state !== '' && html) {
            state = `<SUB><FONT POINT-SIZE="10">${state}</FONT></SUB>`
        } else if (state !== '') {
            state = `@${state}`
        }
        if (withoutState) {
            state = ``
        }

        if (!withoutType && this.type) {
            return `${readable_name}${state}: ${this.type.typename}${val}`
        } else {
            return `${readable_name}${state}${val}`
        }
    }
    constructor(public aliases: Array<string>,          // e.g. "X@7@12" or ["$FOOTPRINT@0@12", "$FOOTPRINT@1@12"]
                public type: ViperType,                 // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                readonly id: number,                    // 0, 1, 2, ...
                public val: string,                     // e.g. "$Ref!val!0"
                readonly isLocal: boolean,             // whether this ndoe is refer to from the program store
                public proto: Array<string>, 
                public states: Array<State> = []) { // e.g. "X"
    
        this._ = this.repr()
        // A node's pretty representation is computed dynamically since the fields are mutable. 
        Object.defineProperty(this, '_', {
            get: function() {
                return this.repr()
            }
        })
    }
}

export class GraphNode extends Node {
    public fields: Array<Relation> = []

    constructor(public aliases: Array<string>,
                public isNull: boolean,
                readonly id: number,
                public val: string,
                readonly isLocal: boolean,
                public proto: Array<string> = [], 
                public states: Array<State> = []) {
        
        super(aliases, PrimitiveTypes.Ref, id, val, isLocal, proto, states)
    }
}

export class Graph extends Node {

    private readonly nodes: Array<GraphNode> = []
    private readonly statuses: {[NodeId: number]: Status} = {}

    constructor(public aliases: Array<string>, 
                readonly id: number, 
                readonly val: string, 
                readonly isLocal: boolean,
                public proto: Array<string> = [], 
                public states: Array<State> = []) {

        super(aliases, PolymorphicTypes.Set(PrimitiveTypes.Ref), id, val, isLocal, proto, states)
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
                readonly aliases: Array<string>,
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
}

export class GraphModel {
    constructor(
        public states: Array<State> = [], 
        public graphs: Array<Graph> = [],

        public footprints: {'client'?: Graph, 'callee'?: Graph} = {},

        public graphNodes: Array<GraphNode> = [],
        public scalarNodes: Array<Node> = [],

        public fields: Array<Relation> = [],
        public reach: Array<LocalRelation> = [],

        public equivalence_classes: EquivClasses = new EquivClasses()) {}
}

export class EquivClasses {
    
    // mapping keys to nodes
    private __buf: { 
        [Key: string]: Array<Node>,
    } = {}

    public static key(innerval: string, states: Array<State>, type: ViperType): string {
        return `${innerval}@[${states.map(s => s.nameStr()).join('/')}]:${type.typename}`
    }

    public has(innerval: string, states: Array<State>, type: ViperType): boolean {
        let key = EquivClasses.key(innerval, states, type)
        return this.__buf.hasOwnProperty(key)
    }

    public get(innerval: string, states: Array<State>, type: ViperType): Array<Node> {
        let key = EquivClasses.key(innerval, states, type)
        return this.__buf[key]
    }

    public set(innerval: string, states: Array<State>, type: ViperType, nodes: Array<Node>): void {
        let key = EquivClasses.key(innerval, states, type)
        this.__buf[key] = nodes
    }
}
