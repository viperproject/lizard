export class ViperLocation {
    constructor(public file: string,
                public line: number,
                public column: number) {}

    public static from(pos: string, file: string): ViperLocation {

        let m = pos.split(':').map(str => parseInt(str))
        let ln = m[0]
        let col = m[1]
    
        return new ViperLocation(file, ln, col)
    }

    public leq(other: ViperLocation): boolean {
        if (this.file !== other.file) {
            throw `locations are comparible only within the same file`
        }
        let my_line = this.line
        let my_column = this.column
        
        let their_line = other.line
        let their_column = other.column

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

export class Failure {
    constructor (readonly id: string,
                 readonly file: string,
                 readonly line: number, 
                 readonly column: number, 
                 readonly text: string) {}

    public static from(id: string, pos: string, file: string, text: string): Failure {
        let loc = ViperLocation.from(pos, file)
        return new Failure(id, file, loc.line, loc.column, text)
    }

    public toStr(): string {
        return `Failure ${this.id} (Ln ${this.line}, Col ${this.column})`
    }

    public getViperLocation(): ViperLocation {
        return new ViperLocation(this.file, this.line, this.column)
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