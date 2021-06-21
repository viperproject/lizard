import { BoolType, IntType, PermType, RefType, SetType, OtherType, getConstantEntryValue, ApplicationEntry, Model, ViperType, Node, Graph, Relation, EquivClasses, GraphModel, ConstantEntry, ModelEntry, MapEntry,  } from "./Models"
import { ViperDefinition, AtomicType, BackendType, GenericType, Type, BuiltinCollectionType, MapType, DomainType, TypedViperDefinition } from "./ViperAST"

// import { Session } from './Session'

export class ViperTypesProvider {

    public get: (nodename: string) => ViperType = (nodename: string) => { 
        throw `ViperTypesProvider is not ready yet` 
    }

    constructor(private programDefinitions: Array<ViperDefinition>,
                private innerToProto: (inned_name: string) => string) {

        let viper_type_map = new Map<string, ViperType>()    // for mapping values to types
        let viper_type_cache = new Map<string, ViperType>()  // for reusing the types whenever possible

        let viper_Bool_type = new BoolType();                viper_type_cache.set('Bool', viper_Bool_type)
        let viper_Int_type  = new IntType();                 viper_type_cache.set('Int', viper_Int_type)
        let viper_Ref_type  = new RefType();                 viper_type_cache.set('Ref', viper_Ref_type)
        let viper_Perm_type = new PermType();                viper_type_cache.set('Perm', viper_Perm_type)
        let viper_Wand_type = new OtherType('Wand');         viper_type_cache.set('Wand', viper_Wand_type)
        let viper_Internal_type = new OtherType('Internal'); viper_type_cache.set('Internal', viper_Internal_type)

        let strToType = (strRepr: string) => {
            if (viper_type_cache.has(strRepr)) {
                return viper_type_cache.get(strRepr)!
            } else {
                let new_type: ViperType
                if (strRepr === 'Set[Ref]') {
                    new_type = new SetType(undefined, viper_Ref_type)
                } else {
                    // TODO: track types more precisely
                    new_type = new OtherType(strRepr)
                }
                viper_type_cache.set(strRepr, new_type)
                return new_type
            }
        }
        // Collect things that should be statically typed
        let typed_definitions = this.programDefinitions.filter(def => 
            def.type.hasOwnProperty('viperType')).map(x => <TypedViperDefinition> x)

        // Map typed things to their types
        typed_definitions.forEach(typed_def => {
            let name = typed_def.name
            let vipertype = typed_def.type.viperType
            let type_str: string

            if (vipertype.kind === 'atomic') {
                // Atomic types are normally already cached, unless it is backend-specific
                let atomic_type = <AtomicType> vipertype.typename
                if (atomic_type.hasOwnProperty('smtName')) {
                    // The rare case
                    type_str = (<BackendType> atomic_type).smtName
                } else {
                    // The normal case
                    type_str = <string> atomic_type
                }     
            } else if (vipertype.kind === 'generic') {
                // Generic types can be concrete of with (partially-) instantiated type perameters. 
                if (vipertype.isConcrete) {
                    // This must be a collection (Seq[T], Set[T], Map[T,S], $CustomType[A,B,C,...])
                    type_str = ViperTypesProvider.serializeConcreteViperTypeRec(vipertype)
                } else {
                    // Non-concrete collection types are pre-serialized
                    type_str = <string> vipertype.typename
                }
            } else if (vipertype.kind === 'extension') {
                // Extension types are pre-serialized for now 
                // (See ViperServer viper/server/frontends/http/jsonWriters/ViperIDEProtocol.scala)
                type_str = <string> vipertype.typename
            } else {
                // TODO: generalize to arbitrary types
                type_str = <string> vipertype.typename
            }

            let typ = strToType(type_str)
            viper_type_map.set(name, typ)
        })

        this.get = (nodename: string) => {
            let typed_thing = this.innerToProto(nodename)
            return viper_type_map.get(typed_thing)!
        }
    }

    private static serializeConcreteViperTypeRec(typ: Type): string {
        if (typ.kind === 'atomic') {
            if (typ.typename.hasOwnProperty('smtName')) {
                return (<BackendType> typ.typename).smtName
            } else {
                return <string> typ.typename
            }
        } else if (typ.kind === 'generic') {
            let generic_type = <GenericType> typ.typename
            let collection = generic_type.collection
            if (collection === 'Set' || collection === 'Seq' || collection === 'MultiSet') {
                // Expect one type parameter
                let builtin_collection_type = <BuiltinCollectionType> generic_type
                let elem_type: string = ViperTypesProvider.serializeConcreteViperTypeRec(builtin_collection_type.elements)
                return `${collection}[${elem_type}]`

            } else if (collection == 'Map') {
                // Expect two type parameters
                let map_type = <MapType> generic_type
                let keys_type: string = ViperTypesProvider.serializeConcreteViperTypeRec(map_type.keys)
                let values_type: string = ViperTypesProvider.serializeConcreteViperTypeRec(map_type.values)
                return `Map[${keys_type},${values_type}]`
            } else {
                // Expect an arbitrary number of type parameters (e.g. user-defined type)
                let domain_type = <DomainType> generic_type
                let type_args: Array<string> = domain_type.typeParams.map((t: Type) => 
                    ViperTypesProvider.serializeConcreteViperTypeRec(t))
                return `${collection}[${type_args.join(',')}]`
            }
        } else {
            throw `serialization of type ${JSON.stringify(typ)} is not supported`
        }
    }
}