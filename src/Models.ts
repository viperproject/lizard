import { serialize } from "v8"

export interface ModelEntry {
    type: string
}

export class ConstantEntry implements ModelEntry {
    type = 'constant_entry'
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
    type = 'application_entry'
    constructor(readonly value: FunctionValue) {}
}

export interface ModelCase {
    args: Array<ModelEntry>
    value: ModelEntry
}

export class MapEntry implements ModelEntry {
    type = 'map_entry'
    cases: Array<ModelCase>  
    default: ModelEntry
    constructor(readonly cs: Array<ModelCase>, df: ModelEntry) {
        this.cases = cs
        this.default = df
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

export function isRef(type: ViperType): boolean {
    return type.typename === 'Ref'
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

    public repr(withoutType=false, withoutValue=false): string {
        let readable_name = Array.isArray(this.aliases) ? `${this.aliases.join(' = ')}` : this.aliases
        let val = withoutValue ? `` : ` = ${this.val}`
        
        if (!withoutType && this.type) {
            return `${readable_name}: ${this.type.typename}${val}`
        } else {
            return `${readable_name}${val}`
        }
    }
    constructor(public aliases: Array<string>,          // e.g. "X@7@12" or ["$FOOTPRINT@0@12", "$FOOTPRINT@1@12"]
                public type: ViperType,                 // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                readonly id: number,                    // 0, 1, 2, ...
                public val: string,                     // e.g. "$Ref!val!0"
                public proto: string | undefined = undefined) { // e.g. "X"
    
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
                readonly isNull: boolean,
                readonly id: number,
                public val: string,
                public proto: string | undefined = undefined) {
        
        super(aliases, PrimitiveTypes.Ref, id, val, proto)
    }
}

export class Graph extends Node {

    constructor(readonly nodes: Array<GraphNode>, 
                public aliases: Array<string>, 
                readonly id: number, 
                readonly val: string, 
                public proto: string | undefined = undefined) {

        super(aliases, PolymorphicTypes.Set(PrimitiveTypes.Ref), id, val, proto)
    }
}


export class Relation {
    private _: string
    constructor(readonly name: string,  // e.g. "NEXT", "edge", or "exists_path"
                readonly state: State,  // e.g. { name: "Heap@@1", val: "T@U!val!11" }
                readonly pred_id: number, 
                readonly succ_id: number) {
    
        this._ = `${name}[ ${state.name} ](N${pred_id}, N${succ_id})`
    }
}

export class State { 
    constructor(readonly name: string,
                readonly val: string) {}
}

export class GraphModel {
    constructor(
        public states: Array<State> = [], 
        public graphs: Array<Graph> = [],
        public graphNodes: Array<GraphNode> = [],
        public scalarNodes: Array<Node> = [],

        public fields: Array<Relation> = [],
        public edges: Array<Relation> = [],
        public paths: Array<Relation> = [],

        public equivalence_classes: EquivClasses = new EquivClasses()) {}

}

export class EquivClasses {
    [Key: string]: Array<Node>   // mapping inner values to nodes'
}