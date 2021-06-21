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
    innerval: string | undefined
}

export class RefType implements ViperType {
    typename = "Ref"
    constructor(readonly innerval: string | undefined = undefined) {}
}

export class IntType implements ViperType {
    typename = "Int"
    constructor(readonly innerval: string | undefined = undefined) {}
}

export class BoolType implements ViperType {
    typename = "Bool"
    constructor(readonly innerval: string | undefined = undefined) {}
}

export class PermType implements ViperType {
    typename = "Perm"
    constructor(readonly innerval: string | undefined = undefined) {}
}

export class SetType implements ViperType {
    typename: string
    constructor(readonly innerval: string | undefined = undefined, 
                readonly type_arg: ViperType) {
        this.typename = `Set[${type_arg.typename}]`
    }
}

export class OtherType implements ViperType {
    typename = "Other"
    constructor(readonly innerval: string | undefined = undefined) {}
}

// TODO: support other types e.g. Maps, Multisets, etc. 

export class Node {
    /** This dynamic field enables JSONFormatter to pretty pront the node. */
    private _: string 

    public repr(): string {
        let readable_name = Array.isArray(this.aliases) ? `${this.aliases.join(' = ')}` : this.aliases
        if (this.type) {
            return `${readable_name}: ${this.type.typename} = ${this.val}`
        } else {
            return `${readable_name} = ${this.val}`
        }
    }
    constructor(public aliases: string | Array<string>, // e.g. "X@7@12" or ["$FOOTPRINT@0@12", "$FOOTPRINT@1@12"]
                readonly type: ViperType | undefined,     // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                readonly id: number,                      // 0, 1, 2, ...
                readonly val: string,                     // e.g. "$Ref!val!0"
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

export class Graph extends Node {

    constructor(readonly nodes: Array<Node>, 
                public aliases: string | Array<string>, 
                readonly type: ViperType, 
                readonly id: number, 
                readonly val: string, 
                public proto: string | undefined = undefined) {

        super(aliases, type, id, val, proto)
    }
}

export class Relation {
    private _: string
    constructor(readonly name: string,  // e.g. "NEXT", "edge", or "exists_path"
                readonly state: State,  // e.g. { name: "Heap@@1", val: "T@U!val!11" }
                readonly pred: Node, 
                readonly succ: Node) {
    
        this._ = `${name}[ ${state} ](${pred.aliases}, ${succ.aliases})`
    }
}

export class State { 
    constructor(readonly name: string,
                readonly val: string) {}
}

export class GraphModel {
    constructor(
        public states: Array<State>, 
        public graphs: Array<Graph>,
        public nodes: Array<Node>,

        public fields: Array<Relation>,
        public edges: Array<Relation>,
        public paths: Array<Relation>,

        public equivalence_classes: EquivClasses) {}

}

export class EquivClasses {
    [Key: string]: Array<Node>   // mapping inner values to nodes
}