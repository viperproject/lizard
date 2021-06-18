export interface ViperLocation {
    start: string
    end: string
    file: string
}

export interface ViperDefinition {
    name: string
    location: ViperLocation
    scopeStart: ViperLocation | "global"
    scopeEnd: ViperLocation | "global"
    type: { name: string, viperType: { kind: string, typename: any, isConcrete?: boolean } }
}
