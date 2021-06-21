export class ViperLocation {
    constructor (public loc: string,
                 public file: string) {}

    public leq(other: ViperLocation): boolean {
        if (this.file !== other.file) {
            throw `locations are comparible only within the same file`
        }
        let my_pos = this.loc.split(':').map(str => parseInt(str))
        let my_line = my_pos[0]
        let my_column = my_pos[1]
        
        let their_pos = other.loc.split(':').map(str => parseInt(str))
        let their_line = their_pos[0]
        let their_column = their_pos[1]

        return my_line < their_line || 
              (my_line === their_line) && my_column <= their_column
    }

    public inScope(start: ViperLocation | 'global', end: ViperLocation | 'global'): boolean {
        if (start === 'global' || end === 'global') {
            if (start !== 'global' || end !== 'global') {
                throw `both start and end of a global scope must be set to 'global' at the same time`
            }
            return true
        }        
        if (start.file !== end.file) {
            throw `scope must start and end in the same file`
        }
        return start.file === this.file && start.leq(this) && this.leq(end)
    }
}

export type BackendType = { boogieName: string, smtName: string }
export type BuiltinCollectionType = { collection: 'Set' | 'Seq' | 'MultiSet', elements: Type }
export type MapType = { collection: 'Map', keys: Type, values: Type }
export type DomainType = { collection: string, typeParams: Array<Type> }
export type GenericType = BuiltinCollectionType | MapType | DomainType
export type AtomicType = string | BackendType
export type TypeName = AtomicType | GenericType | string
export type Type = { kind: 'atomic' | 'generic' | 'extension' | 'weird_type', typename: TypeName, isConcrete?: boolean }

export class ViperDefinition {
    constructor (public name: string,
                 public location: ViperLocation,
                 public scopeStart: ViperLocation | 'global',
                 public scopeEnd: ViperLocation | 'global',
                 public type: { name: string }) {}
}

export class TypedViperDefinition extends ViperDefinition {
    constructor (public name: string,
        public location: ViperLocation,
        public scopeStart: ViperLocation | 'global',
        public scopeEnd: ViperLocation | 'global',
        public type: { name: string, viperType: Type }) {

            super(name, location, scopeStart, scopeEnd, { name: type.name })
        }
}