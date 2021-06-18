export interface ModelEntry {
    type: string
}

export class ConstantEntry implements ModelEntry {
    type = 'constant_entry'
    value: string
    constructor(v: string) {
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
    value: FunctionValue
    constructor(value: FunctionValue) {
        this.value = value
    }
}

export interface ModelCase {
    args: Array<ModelEntry>
    value: ModelEntry
}

export class MapEntry implements ModelEntry {
    type = 'map_entry'
    cases: Array<ModelCase>  
    default: ModelEntry
    constructor(cs: Array<ModelCase>, df: ModelEntry) {
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
    constructor(public innerval: string | undefined = undefined) {}
}

export class IntType implements ViperType {
    typename = "Int"
    constructor(public innerval: string | undefined = undefined) {}
}

export class BoolType implements ViperType {
    typename = "Bool"
    constructor(public innerval: string | undefined = undefined) {}
}

export class PermType implements ViperType {
    typename = "Perm"
    constructor(public innerval: string | undefined = undefined) {}
}

export class SetType implements ViperType {
    typename: string
    constructor(public innerval: string | undefined = undefined, 
                public type_arg: ViperType) {
        this.typename = `Set[${type_arg.typename}]`
    }
}

export class OtherType implements ViperType {
    typename = "Other"
    constructor(public innerval: string | undefined = undefined) {}
}

// TODO: support other types e.g. Maps, Multisets, etc. 

export class Node {
    private _: string
    constructor(public name: string | Array<string>, // e.g. "X@7@12" or ["$FOOTPRINT@0@12", "$FOOTPRINT@1@12"]
                public type: ViperType | undefined,  // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                public id: number,                   // 0, 1, 2, ...
                public val: string,                  // e.g. "$Ref!val!0"
                public proto: string | undefined = undefined) { // e.g. "X"
    
        if (type) {
            this._ = `${proto}: ${type.typename} = ${val}`
        } else {
            this._ = `${proto} = ${val}`
        }
    }  
}

export class Graph {
    constructor(public name: string, 
                //public state: string, 
                public node_ids: Array<number>) {}
}

export class Relation {
    private _: string
    constructor(public name: string,  // e.g. "NEXT", "edge", or "exists_path"
                public state: string, // Heap@@1
                public pred: Node, 
                public succ: Node) {
    
        this._ = `${name}[ ${state} ](${pred.name}, ${succ.name})`
    }
}

export class GraphModel {
    constructor(
        public graph: Graph,
        public nodes: Array<Node>,

        public fields: Array<Relation>,
        public edges: Array<Relation>,
        public paths: Array<Relation>,

        public equivalence_classes: EquivClasses) {}
}

export class EquivClasses {
    [Key: string]: Array<Node>   // mapping inner values to nodes
}