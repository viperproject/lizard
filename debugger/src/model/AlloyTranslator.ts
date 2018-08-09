import { AlloyModelBuilder } from "./AlloyModel";
import { State } from "./Record";
import { FieldChunk, QuantifiedFieldChunk, PredicateChunk, HeapChunk } from "./Heap";
import { Logger } from "../logger";
import { VariableTerm, Unary, Term, Application, Binary, Quantification, Literal, LogicalWrapper } from "./Term";
import { getSort, Sort } from './Sort';
import { Verifiable } from "./Verifiable";
import { TranslationEnv } from "./TranslationEnv";
import { TermTranslatorVisitor, sanitize } from "./TermTranslator";
import * as fs from 'fs';
import { getAbsolutePath } from "../extension";


export namespace AlloyTranslator {

    // Signature name definitions, it makes it easier to change them all at once later.
    export const Ref = 'Ref';
    export const Null = 'NULL';
    export const Int = 'Int';
    export const Bool = 'Bool';
    export const Snap = 'Snap';
    export const Unit = 'Unit';
    export const SymbVal = 'SymbVal';
    export const Perm = 'Perm';
    export const WritePerm = 'W';
    export const NoPerm = 'Z';
    export const SigSeq = 'Seq';
    export const SigSet = 'Set';
    export const Multiset = 'Multiset';

    export const Heap = 'Heap';
    export const Store = 'Store';

    export const Combine = 'Combine';
    export const Function = 'Fun';
    export const PermFun = 'PermFun';

    // TODO: Don't like this signature
    export function translate(verifiable: Verifiable,
                              axioms: Term[],
                              macros: Map<Application, Term>,
                              state: State,
                              env: TranslationEnv): string {

        // The translation environment keeps track of the known variable names and the signature they belong to
        const mb = new AlloyModelBuilder();
        const termTranslator = new TermTranslatorVisitor(env);

        emitPrelude(mb);

        encodeRefSignature(env, mb);
        translateStore(env, mb, termTranslator);
        translateHeap(env, mb, termTranslator, state.heap);
        encodePermissions(state.heap, env, mb, termTranslator);
        translateAxioms(axioms, mb, env, termTranslator);

        if (state.pathConditions.length > 0) {
            mb.comment("Path Conditions");
            state.pathConditions.forEach(pc => termToFact(pc, env, mb, termTranslator));
            mb.blank();
        }

        // Translate values and types that have been gathered during translation
        encodeGatheredFacts(env, mb);
        encodeMacros(macros, mb, env, termTranslator);
        encodeReachabilityConstraints(env, mb);
        encodeFailedSMTFact(verifiable, env, mb, termTranslator);
        encodeSignatureRestrictions(mb, env);

        // TODO: Devise a formula for this
        const baseCount = 5 + env.storeVariables.size + env.functions.size + env.predicates.size + 3;
        const countPerInstance = new Map([
            // [AlloyTranslator.Combine, env.totalCombines],
            ['int', 4]
        ]);
            
        return mb.build(baseCount, countPerInstance);
    }

    /** Emits the definitions that never change in the model. */
    function emitPrelude(mb: AlloyModelBuilder) {
        const files = [
            ["Preamble", 'resources/preamble.als'],
            ["Perms", 'resources/perms.als'],
            ["Sets", 'resources/set_fun.als'],
            ["Seqs", 'resources/seq.als']
        ];

        files.forEach(p => {
            const [name, filename] = p;
            const path = getAbsolutePath(filename);
            mb.comment('='.repeat(5) + ` ${name} (${filename}) ` + '='.repeat(5));
            const lines = fs.readFileSync(path)
                            .toString()
                            .split('\n')
                            .filter(l => !l.trim().startsWith('--'))
                            .filter(l => l.trim() !== '');
            mb.text(lines.join('\n'));
        });
    }

    function encodeRefSignature(env: TranslationEnv, mb: AlloyModelBuilder) {

        const objectMembers: string[] = [];
        const successors: string[] = [];
        env.fields.forEach((sort, field) => {
            const sig = env.translate(sort);
            objectMembers.push(`${field}: lone ${sig}`);
            if (sig === Ref) {
                successors.push(field);
            }
        });

        // Constraint on successors of objects
        objectMembers.push("refTypedFields': set " + Ref);
        const fieldsConstraint = "refTypedFields' = " + ((successors.length < 1) ? 'none' : successors.join(" + "));

        mb.signature(Ref).extends(SymbVal)
            .withMembers(objectMembers)
            .withConstraint(fieldsConstraint);
        mb.blank();

        if (env.fields.size > 0) {
            mb.comment("Constraints on field permission/existence");
            for (const field of env.fields.keys()) {
                const funName = `${Function}.${PermFun}_${field}`;
                // Record the function as an instance of Perm, so that the signature
                // can be properly constrained later.
                env.recordInstance(Sort.Perm, funName + `[${Ref}]`);
                mb.fact(`all o: ${Ref} | one o.${field} <=> ${funName}[o].num > 0`);
                // We canno give permission to the null reference.
                mb.fact(`NULL not in (${funName}).univ`);
            }
        }

        // The null reference
        mb.oneSignature(Null).extends(Ref).withConstraint("refTypedFields' = none");
        mb.blank();
    }

    function translateStore(env: TranslationEnv, mb: AlloyModelBuilder, translator: TermTranslatorVisitor) {
        const refTypedStoreVariables: string[] = [];
        const store = mb.oneSignature(Store);
        const constraints: string[] = [];

        env.storeVariables.forEach((variable, name) => {
            const sig = env.translate(variable.sort);
            store.withMember(`${name}: one ${sig}`);

            // TODO: Do this via termToFact?
            const value = variable.value.accept(translator);
            if (value.res) {
                let fact = value.additionalFacts
                                .concat(`${Store}.${name} = ${value.res}`)
                                .join(" && \n       ");
                constraints.push(fact);
                env.variablesToDeclare.forEach((sort, name) => mb.oneSignature(name).in(env.translate(sort)));
                env.variablesToDeclare.clear();

            } else {
                Logger.error(`Could not translate store value for ${name}: ` + value.leftovers);
            }

            if (sig === Ref) {
                refTypedStoreVariables.push(name);
            }
        });

        // Add a helper relation to keep track of all the objects that are reachable from the store
        store.withMember(`refTypedVars': set ${SymbVal}`);
        store.withConstraint("refTypedVars' = " + (refTypedStoreVariables.length > 0
                                                           ? refTypedStoreVariables.join(" + ")
                                                           : 'none'));
        constraints.forEach(c => mb.fact(c));
        mb.blank();
    }

    function translateHeap(env: TranslationEnv, mb: AlloyModelBuilder, termTranslator: TermTranslatorVisitor, chunks: HeapChunk[]) {
        const heapChunks: Set<string> = new Set();
        const constraints: string[] = [];

        chunks.forEach(hc => {
            if (hc instanceof FieldChunk) {
                if (hc.snap instanceof VariableTerm) {
                    heapChunks.add(`${sanitize(hc.snap.id)}: lone ${env.translate(hc.snap.sort)}`);
                    const rec = hc.receiver.accept(termTranslator);
                    if (rec.res) {
                        constraints.push(rec.res + '.' + hc.field + ' = ' + env.resolve(hc.snap));
                    } else {
                        Logger.warn("Could not translate field receiver: " + rec.leftovers.join("\n"));
                    }
                } else if (hc.snap instanceof Literal) {
                    
                    const rec = hc.receiver.accept(termTranslator);
                    const lit = hc.snap.accept(termTranslator);

                    if (!rec.res) {
                        Logger.error("Could not translate field receiver: " + rec.leftovers.join("\n"));
                        return;
                    }
                    if (!lit.res) {
                        Logger.error("Could not translate field literal: " + lit.leftovers.join("\n"));
                        return;
                    }
                    constraints.push(rec.res + "." + hc.field + " = " + lit.res);
                }
            } else if (hc instanceof PredicateChunk) {
                if (hc.snap instanceof VariableTerm) {
                    heapChunks.add(`${sanitize(hc.snap.id)}: lone ${env.translate(hc.snap.sort)}`);
                }
            } else if (hc instanceof QuantifiedFieldChunk) {
                hc.invAxioms.forEach(axiom => termToFact(axiom, env, mb, termTranslator));
            } else {
                Logger.error(`Heap chunk translation not implemented yet: '${hc}'`);
            }
        });

        mb.oneSignature(Heap).withMembers([...heapChunks.keys()]);
        constraints.forEach(c => mb.fact(c));
        mb.blank();

        Array.from(env.predicates.keys()).forEach(id => {
            const name = "pred_" + id;
            let preds = <PredicateChunk[]> env.predicates.get(id);
            let first = preds[0];
            const vars = 'args: ' + first.args.map(a => env.translate(getSort(a))).join(' one -> one ');

            mb.signature(name).withMembers([vars]);
            preds.forEach(p => {
                const args: string[] = [];
                p.args.forEach(a => {
                    const translated = a.accept(termTranslator);
                    if (translated.res) {
                        args.push(translated.res);
                    } else {
                        Logger.warn(translated.leftovers.join(',\n'));
                    }
                });
                mb.fact(`one p': ${name} | ` + args.join(' -> ') + " in p'.args");
            });
            mb.fact(`#${name} = ${preds.length}`);
            mb.blank();
        });
    }

    function encodePermissions(chunks: HeapChunk[],
                               env: TranslationEnv,
                               mb: AlloyModelBuilder,
                               termTranslator: TermTranslatorVisitor) {
        chunks.forEach(chunk => {
            if (chunk instanceof FieldChunk) {
                const functionName = PermFun + "_" + chunk.field;
                const permFun = new Binary('==', 
                                           new Application(functionName, [chunk.receiver], new Sort('Perm')),
                                           chunk.perm);

                termToFact(permFun, env, mb, termTranslator);

            } else if (chunk instanceof QuantifiedFieldChunk) {
                const r = new VariableTerm('r', new Sort('Ref'));
                const functionName = PermFun + "_" + chunk.field;
                const permFun = new Binary('==',
                                            new Application(functionName, [r], new Sort('Perm')),
                                            chunk.perm);
                const quant = new Quantification('QA', [r], permFun, null);

                termToFact(quant, env, mb, termTranslator);
            }
        });
        mb.blank();
    }

    function translateAxioms(axioms: Term[], mb: AlloyModelBuilder, env: TranslationEnv, termTranslator: TermTranslatorVisitor) {
        if (axioms.length > 0) {
            mb.comment("Domain Axioms");
            axioms.forEach(a => termToFact(a, env, mb, termTranslator));
            mb.blank();
        }
    }

    function termToFact(t: Term, env: TranslationEnv, mb: AlloyModelBuilder, termTranslator: TermTranslatorVisitor) {
        let body = new LogicalWrapper(t).accept(termTranslator);
        if (!body.res) {
            mb.comment("!!! Non-translated fact: ");
            mb.comment(body.leftovers.map(l => "    " + l.toString()).join("\n"));
            mb.blank();
            return;
        }

        mb.comment(t.toString());
        // The translation of a fact might have introduces some variables and facts to constrain them.
        let facts = body.additionalFacts.concat(body.res).join(" && \n       ");
        env.variablesToDeclare.forEach((sort, name) => mb.oneSignature(name).in(env.translate(sort)));
        env.variablesToDeclare.clear();
        // let facts = [body.res].concat(body.additionalFacts).join(" && ");
        if (body.quantifiedVariables.length > 0) {
            mb.fact(body.quantifiedVariables.concat(facts).join(" | "));
        } else {
            mb.fact(facts);
        }
    }

    // NOTE: Inverse function, functions and temp variables are added to the Alloy model "at the bottom" because
    // we gather them mostly when traversing the path conditions. Alloy does not care for where the variables are
    // declared as long as they are.
    function encodeGatheredFacts(env: TranslationEnv, mb: AlloyModelBuilder) {

        if (env.functions.size > 0) {
            mb.comment("Functions");
            const members: string[] = [];
            for (let [name, sorts] of env.functions) {
                // Add multiplicity of 'lone' to return type of function
                const tSorts = sorts.map(s => env.translate(s));
                tSorts[tSorts.length - 1] = 'lone ' + tSorts[tSorts.length - 1];

                members.push(name + ': (' + tSorts.join(' -> ') + ')');
            }
            mb.oneSignature(Function).withMembers(members);
            mb.blank();
        }

        const fvfFacts = new Set<string>();
        env.lookupFunctions.forEach((v) => {
            const [sort, field] = v;
            const f = `all fvf: ${env.translate(sort)}, r: Ref | r in mid[Fun.lookup_${field}] => Fun.lookup_${field}[fvf, r] = r.${field}`;
            if (!fvfFacts.has(f)) {
                fvfFacts.add(f);
                mb.fact(f);
            }
        });

        env.sortWrappers.forEach((sort, name) => {
            const sigName = name.charAt(0).toUpperCase() + name.slice(1);
            const tSort = env.translate(sort);
            mb.abstractSignature(sigName).extends(AlloyTranslator.Snap)
                .withMember('v: ' + env.translate(sort));
            mb.fun(`fun ${name.toLowerCase()} [ o: ${tSort} ]: ${Sort.Snap} {
    { s: ${sigName} | s.v = o }
}`);
        });
        mb.blank();

        if (env.userSorts.size > 0) {
            mb.comment("User sorts");
            env.userSorts.forEach(s => mb.signature(s));  
            mb.blank();
        } 

        if (env.sorts.size > 0) {
            mb.comment("Other sorts");
            env.sorts.forEach(s => mb.signature(s));
            mb.blank();
        }
    }

    function encodeMacros(macros: Map<Application, Term>, mb: AlloyModelBuilder, env: TranslationEnv, termTranslator: TermTranslatorVisitor) {
        if (macros.size > 0) {
            mb.comment("Macros");
            macros.forEach((body, app) => {
                const params = app.args.map(a => {
                    const translated = a.accept(termTranslator);
                    if (!translated.res) {
                        Logger.error("Could not translate macro argument: " + a);
                    }
                    return `${a}: ${env.translate(getSort(a))}`;
                });

                env.evaluateWithAdditionalVariables(
                    app.args.map(t => t.toString()),
                    () => {
                const tBody = body.accept(termTranslator);
                if (!tBody.res) {
                    Logger.error("Could not translate macro body: " + body);
                }

                const retSort = env.translate(app.sort);
        mb.fun(`fun ${sanitize(app.applicable)} [ ${params.join(', ')} ]: ${retSort} {
    { r': ${retSort} | r' = ${tBody.res} }
}`);
                    });
                }
            );
        }
    }

    function encodeReachabilityConstraints(env: TranslationEnv, mb: AlloyModelBuilder) {
        const reachable = [ Store + ".refTypedVars'.*refTypedFields'", Null ];
        
        reachable.push(`(${Combine}.left :> ${Ref})`);
        reachable.push(`(${Combine}.right :> ${Ref})`);

        // If there are functions that return reference-like object, they have to be accounted in the constraint as
        // well, otherwise we may prevent Alloy from generating any Object.
        for (const [name, sorts] of env.functions) {
            const returnSort = sorts[sorts.length - 1];
            const returnSig = env.translate(returnSort);
            if (returnSig === Ref) { 
                const params = sorts.slice(0, -1).map(s => env.translate(s)).join(', ');
                reachable.push(Function + '.' + name + `[${params}]`);
            }
        }

        mb.comment("No object unreachable from the Store");
        mb.fact(Ref + " = " +  reachable.join(' + '));
        mb.blank();
    }

    function encodeFailedSMTFact(verifiable: Verifiable,
                                       env: TranslationEnv,
                                       mb: AlloyModelBuilder,
                                       termTranslator: TermTranslatorVisitor) {
        // Note that the translation of this fact may not be posssible in statements earlier than the failing one. For
        // example, when the failing query refers to a variable that did not exist yet.
        if (verifiable.lastSMTQuery) {
            env.introduceMissingTempVars = false;
            let constraint: Term = verifiable.lastSMTQuery;
            if (constraint instanceof Unary && constraint.op === '!') {
                constraint = new LogicalWrapper(constraint.p);
            } else {
                constraint = new Unary('!', new LogicalWrapper(constraint));
            }
            const failedQuery = constraint.accept(termTranslator);
            if (failedQuery.res) {
                mb.comment("Constraint from last non-proved smt query");
                let facts = failedQuery.additionalFacts.concat(failedQuery.res).join(" && \n       ");
                env.variablesToDeclare.forEach((sort, name) =>  mb.oneSignature(name).in(env.translate(sort)));
                mb.fact(facts);
                mb.blank();
            } else {
                Logger.debug('Could not translate last SMT query: ' + failedQuery.leftovers.join("\n"));
            }
        }
    }

    function encodeSignatureRestrictions(mb: AlloyModelBuilder, env: TranslationEnv) {
        if (env.recordedInstances.size > 0) {
            mb.comment("Signarure Restrictions");

            env.recordInstance(Sort.Ref, Null);
            env.recordInstance(Sort.Snap, Unit);
            env.recordInstance(Sort.Perm, WritePerm);
            env.recordInstance(Sort.Perm, NoPerm);

            env.recordedInstances.forEach((names, sigName) => {
                if (sigName !== Int && sigName !== Bool && sigName !== Ref) {
                    mb.fact(`${sigName} = ${names.join(" + ")}`);
                }
            });

            // TODO: Multiset
            const sort_sigs = [SigSeq, SigSet, Perm, Snap];
            sort_sigs.forEach(sigName => {
                if (!env.recordedInstances.has(sigName)) {
                    mb.fact(`${sigName} = none`);
                }
            });
            mb.blank();
        }
    }
}