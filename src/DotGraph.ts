import { Graph, GraphModel, GraphNode, isNull, isRef, LocalRelation, Atom, Relation, State, Status, NodeClass } from "./Models"

export interface RenderOpts {
    is_carbon: boolean,
    rankdir_lr: boolean,
    dotnodes: boolean
}

type ReachKey = string
function ReachKey(state: State, graph_id: number, pred_id: number, succ_id: number): string {
    return `${state.nameStr()}|${graph_id}|${pred_id}|${succ_id}`
}

export class DotGraph {

    private static GRAPH_BGCOLOR = '#dddddd'
    private static CLIENT_BGCOLOR = '#ddddff'
    private static CALLEE_BGCOLOR = '#FFE883'

    private static REACH_COLOR = `#3333335f`
    private static CLIENT_COLOR = `#0000ff5f`
    private static CALLEE_COLOR = `#E445005f`

    private __rendered_node_ids = new Set<number>()
    private __state_map = new Map<string, State>()
    private __graph_map = new Map<number, Graph>()
    private __client: Graph | undefined
    private __callee: Graph | undefined
    private __graph_node_map = new Map<number, GraphNode>()
    private __scalar_node_map = new Map<number, NodeClass>()
    private __reach_map = new Map<ReachKey, LocalRelation>()
    
    private getGraphById(graph_id: number): Graph | undefined {
        return this.__graph_map.get(graph_id)
    }

    private getGraphNodeById(node_id: number): GraphNode | undefined {
        return this.__graph_node_map.get(node_id)
    }

    private getScalarNodeById(node_id: number): NodeClass | undefined {
        return this.__scalar_node_map.get(node_id)
    }

    private getReachability(state: State, graph_id: number, pred_id: number, succ_id: number): LocalRelation | undefined {
        return this.__reach_map.get(ReachKey(state, graph_id, pred_id, succ_id))
    }

    private renderNodeValue(node: NodeClass): string {
        if (isNull(node)) {
            return 'null'
        }
        let val_id = this.renderValue(node.val)
        if (val_id === node.val) {
            // Literal values do not require type prefix
            return node.val
        }
        switch (node.type!.typename) {
            case 'Ref':
                return `ρ${val_id}`
            case 'Int': 
                return `ι${val_id}`
            case 'Perm': 
                return `π${val_id}`
            case 'Bool':
                return `β${val_id}`
            case 'Set[Ref]': 
                return `γ${val_id}`
            default: 
                return `α${val_id}`
        }
    }

    private renderValue(value: string): string {

        let m = value.match(/(.*)\!val\!(\d+)/)
        if (!m) {
            return value
        }
        return m[2]
    }

    private graphPreamble(): string {
        let rankdir = this.opts.rankdir_lr ? ` rankdir="LR" ` : ``
        let nodesep = this.opts.rankdir_lr ? ` nodesep=0.5 ` : ` nodesep=0.5 `
        return `graph [outputorder="nodesfirst" label="" fontname="Helvetica" ${nodesep} ranksep=0.5 ${rankdir}]`
    }
    private clusterPreamble(color: string, bgcolor: string): string { 
        return `graph [labelloc="t" style="rounded" fontname="Helvetica" color="${color}" bgcolor="${bgcolor}" margin=18]`
    }
    private nodePreamble(): string {
        let margin = this.opts.dotnodes ? '0.03' : '0.05'
        return `node [height=0 width=0 fontname="Helvetica" shape="none" margin=${margin}]`
    }

    private edgePreamble(): string {
        return `edge [fontname="Helvetica" fontsize="12" arrowsize=0.4]`
    }

    private nodeSettings(node: NodeClass) { 
        return ``//`style="filled" penwidth=1 fillcolor="white" fontname="Courier New" shape="Mrecord" `
    }

    // private edgeSettings(edge: Relation) {
    //     return `penwidth = 1 fontsize = 14 fontcolor = "grey28"`
    // }

    public dotEncoding(): string {
        return this.__buffer
    }

    private isFieldRef(field: Relation): boolean {
        let succ = this.getGraphNodeById(field.succ_id)
        if (succ === undefined) {
            return false
        } else {
            return succ.type !== undefined && succ.type.typename === 'Ref'
        }
    }
    
    private isFieldValueNull(field: Relation): boolean {
        let succ = this.getGraphNodeById(field.succ_id)
        if (succ === undefined) {
            return false
        } else {
            return succ.isNull
        }
    }

    private nodeFields(node: GraphNode, only_scalar: boolean = false): string {
        return node.fields.filter(field => 
            this.__state_map.has(field.state.nameStr()))
        .flatMap(field => {  

            let state = this.renderStateLabel(field.state)

            

            let succ = this.getGraphNodeById(field.succ_id)

            let val: string
            if (succ === undefined) {
                // Treat as scalar field
                let scalar_succ = this.getScalarNodeById(field.succ_id)
                if (scalar_succ === undefined) {
                    throw `there shouldn't be any unhashed nodes if the saturation mechanism is working properly, but N${field.succ_id} is not hashed`
                }
                val = this.renderNodeValue(scalar_succ)
            } else if (only_scalar) {
                // Skip Ref-fields
                return []
            } else {
                // Treat as Ref-field
                val = this.renderNodeValue(succ)
            }

            let status = field.status === 'default' ? `*` : ``

            return [`<TR><TD align="text" BGCOLOR="#ffffff" PORT="${field.name}@${field.state.nameStr()}">` + 
                `${status}${field.name}${state}` +
                (this.isFieldValueNull(field) ? ` = null` : (!this.isFieldRef(field) ? ` = ${val}` : ``)) +
                `<BR ALIGN="left" /></TD></TR>`]
                   
        }).join('\n\t\t') + `\n`
    }

    private renderNode(node: GraphNode, graph: Graph | undefined = undefined): string {
        let status: string
        if (graph !== undefined) {
            status = (graph.getNodeStatus(node) === 'default') ? `*` : ``
        } else {
            status = ``
        }
        let withoutStates = (this.__state_map.size === 1)
        let head_label = node.isLocal() 
            ? `${node.repr(true, true, withoutStates, true, true)} = ${this.renderNodeValue(node)}` 
            : this.renderNodeValue(node)
        head_label = `${status}${head_label}`

        let table: string
        if (this.opts.dotnodes) {
            table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>${head_label}</B></FONT></TD></TR>\n` + 
                    `\t\t` + this.nodeFields(node, true) + 
                    `\t\t</TABLE>`
        } else {
            table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>${head_label}</B></FONT></TD></TR>\n` + 
                    `\t\t` + this.nodeFields(node) + 
                    `\t\t</TABLE>`
        }
        this.__rendered_node_ids.add(node.id)
        return `"N${node.id}" [${this.nodeSettings(node)} label=<${table}> ]`
    }

    private renderGraph(graph: Graph): string {
        return `subgraph cluster_${graph.id} {\n` + 
                `\t\t${this.clusterPreamble(DotGraph.REACH_COLOR, DotGraph.GRAPH_BGCOLOR)}\n` + 
                `\t\tlabel="${graph.repr(true, true)} = ${this.renderNodeValue(graph)}"\n` + 
                `\t${graph.mapNodes(node => this.renderNode(node, graph)).join('\n\t')}\n\t}`
    }

    private renderCalleeGraph(): string {
        let callee = this.__callee!
        let state = this.renderStateLabel(callee.aliases[0].states)
        return `subgraph cluster_${callee.id} {\n` + 
               `\t\t${this.clusterPreamble(DotGraph.CALLEE_COLOR, DotGraph.CALLEE_BGCOLOR)}\n` + 
               `\t\tlabel=<Callee${state} = ${this.renderNodeValue(callee)}>\n` + 
               `\t${callee.mapNodes(node => this.renderNode(node, callee)).join('\n\t')}\n\t}`
    }

    private renderClientGraph(): string {
        
        let client = this.__client!
        let callee = this.__callee!

        let callee_str = ``
        let frame_str = ``
        if (callee !== undefined) {
            callee_str = this.renderCalleeGraph()
            let callee_nodes = callee.getNodesSet()
            let frame_nodes = client.filterNodes(node => !callee_nodes.has(node))
            frame_str = frame_nodes.map(node => this.renderNode(node, client)).join('\n\t')
        } else {
            frame_str = client.getNodesArray().map(node => this.renderNode(node, client)).join('\n\t')   
        }

        let state = this.renderStateLabel(client.aliases[0].states)

        return `subgraph cluster_${client.id} {\n` + 
                `\t\t${this.clusterPreamble(DotGraph.CLIENT_COLOR, DotGraph.CLIENT_BGCOLOR)}\n` + 
                `\t\tlabel=<Client${state} = ${this.renderNodeValue(client)}>\n` + 
                `\t${callee_str}\n` + 
                `\t${frame_str}\n\t}`
    }

    private renderStateLabel(state: State | Array<State>): string {
        if (this.__state_map.size < 2 || Array.isArray(state) && state.length === 0) {
            return ``
        } else if (Array.isArray(state)) {
            return `<SUB><FONT POINT-SIZE="10">${state.map(s => s.nameStr()).join('/')}</FONT></SUB> `
        } else {
            return `<SUB><FONT POINT-SIZE="10">${state.nameStr()}</FONT></SUB> `
        }
    }

    private renderFieldRelation(field: Relation): string {
        let pred = this.getGraphNodeById(field.pred_id)
        let succ = this.getGraphNodeById(field.succ_id)

        if (pred === undefined || succ === undefined) {
            throw `both pred and succ of a heap-related graph nodes must be hashed at this point, ` + 
                  `but N${field.pred_id} or N${field.succ_id} are not`
        }

        let status = (field.status === 'default') ? `labeldistance=0 taillabel=<*>` : ``
        if (this.opts.dotnodes) {
            let state_lbl = this.renderStateLabel(field.state)
            let label = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR><TD>${field.name}${state_lbl}</TD></TR></TABLE>`
            return `N${pred.id} -> N${succ.id} [label=<${label}> ${status}]`
        } else if (pred.id === succ.id && this.opts.rankdir_lr) {
            // special case for self-edges
            return `N${pred.id}:"${field.name}@${field.state.nameStr()}":e -> N${succ.id}:"$HEAD":e [${status}]`
        } else {
            return `N${pred.id}:"${field.name}@${field.state.nameStr()}":e -> N${succ.id}:"$HEAD" [${status}]`
        }
    }

    private renderReachRelation(rel: LocalRelation, is_mutual: boolean): string {
        let graph = this.getGraphById(rel.graph_id)
        let pred = this.getGraphNodeById(rel.pred_id)
        let succ = this.getGraphNodeById(rel.succ_id)

        if (graph === undefined || pred === undefined || succ === undefined) {
            throw `graph, pred, and succ of a local reachability relation must be hashed at this point, ` + 
                  `but some of these were not: G${rel.graph_id}, N${rel.pred_id}, or N${rel.succ_id}`
        }

        let state = this.renderStateLabel(rel.state)
        let graph_lbl 
        let color 
        if (this.__client !== undefined && graph.id === this.__client.id) {
            graph_lbl = ``
            color = DotGraph.CLIENT_COLOR
        } else if (this.__callee !== undefined && graph.id === this.__callee.id) {
            graph_lbl = ``
            color = DotGraph.CALLEE_COLOR
        } else {
            graph_lbl = (this.__graph_map.size > 1) ? `(${graph.repr(true, true)})` : ``
            color = DotGraph.REACH_COLOR
        }
        let status = rel.status === 'default' ? `labeldistance=0 taillabel=<<FONT COLOR="${color}">*</FONT>>` : ``
        let label = `<<FONT COLOR="${color}">${rel.name}${state}${graph_lbl}</FONT>>`
        let dashed = rel.name === 'P' ? `` : `style="dashed"`
        // let constrant = rel.name === 'P' ? `true` : `false`
        let constrant = `false`
        if (is_mutual) {
            return `N${pred.id} -> N${succ.id} [label=${label} ${status} color="${color}" penwidth=2 ${dashed} arrowhead="none" arrowtail="none" dir="both" constraint=${constrant} ]`
        } else {
            return `N${pred.id} -> N${succ.id} [label=${label} ${status} color="${color}" penwidth=2 ${dashed} arrowhead="open" arrowsize=0.8 constraint=${constrant} ]`
        }
    }

    private storeNodes(nodes: Array<NodeClass>): string {
        return nodes.map(node => {
            let repr: string
            let withoutStateMarkers = (this.__state_map.size === 1)
            let extraSpace = withoutStateMarkers ? `` : ` `
            if (isRef(node.type) && !isNull(node)) {
                // this is a graph node
                repr = node.repr(true, true, withoutStateMarkers, true, true)
            } else {
                // not a graph node
                repr = `${node.repr(true, true, withoutStateMarkers, true, true)}${extraSpace} = ${this.renderNodeValue(node)}`
            }

            return `<TR><TD align="text" PORT="Local_N${node.id}">` + 
                   repr + `<BR ALIGN="left" /></TD></TR>`
        }).join('\n\t\t') + '\n'
    }

    private renderLocalStore(nodes: Array<NodeClass>): string {

        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>Local </B></FONT></TD></TR>\n` + 
                    `\t\t` + this.storeNodes(nodes) + 
                    `\t\t</TABLE>`
        return `"$Store" [ label=<${table}> ]`
    }

    private renderRefs(graph_nodes: Array<GraphNode>): string {
        let constraint = this.opts.rankdir_lr ? `` : `constraint=false `
        let port = this.opts.dotnodes ? `` : `:"$HEAD"`
        return graph_nodes.map(ref_node => 
            `"$Store":Local_N${ref_node.id}:e -> N${ref_node.id}${port} [${constraint}style=dotted]`).join('\n\t')
    }

    private renderReachRelations(rels: Array<LocalRelation>): string {
        let rendered_rels = new Set<LocalRelation>()
        let res = rels.filter(rel => rel.pred_id !== rel.succ_id)
                .flatMap(rel => {
                    let dual_rel = this.getReachability(rel.state, rel.graph_id, rel.succ_id, rel.pred_id)
                    if (dual_rel === undefined || rel.name !== dual_rel.name) {
                        // No dual relation, thus we need to render it
                        rendered_rels.add(rel)
                        return [this.renderReachRelation(rel, false)]
                    } else {
                        // There exists a dual relation, so we want to render these two as a bi-directional edge
                        // But first check that we haven't rendered it before
                        if (!rendered_rels.has(rel)) {
                            rendered_rels.add(rel)
                            rendered_rels.add(dual_rel)
                            return [this.renderReachRelation(rel, true)]
                        } else {
                            return []
                        }
                    } 
                }).join('\n\t')

        return res
    }

    private getLatestFootprint(graphs: Array<Graph>): Graph | undefined {
        if (graphs.length < 1) {
            return undefined
        }
        if (graphs.length === 1) {
            return graphs[0]
        }
        let latest = graphs[0]
        let latestState: State = latest.aliases[0].states[0]
        graphs.forEach(graph => {
            // find this graph's last state
            let lastGraphState: State = graph.aliases[0].states[0]
            graph.aliases.forEach(atom => {
                // find this atom's latest state
                let latestAtomState: State = atom.states[0]
                atom.states.forEach(state => {
                    if (latestAtomState.isStrictlyPreceding(state)) {
                        latestAtomState = state
                    }
                })
                if (lastGraphState.isStrictlyPreceding(latestAtomState)) {
                    lastGraphState = latestAtomState
                }
            })
            if (latestState.isStrictlyPreceding(lastGraphState)) {
                latestState = lastGraphState
                latest = graph
            }
        })
        return latest
    }

    private __buffer: string

    constructor(public model: GraphModel, 
                readonly opts: RenderOpts) {
        
        // hash nodes by their ids and states by their names
        model.states.forEach(state => this.__state_map.set(state.nameStr(), state))
        model.graphs.forEach(graph => this.__graph_map.set(graph.id, graph))
        model.graphNodes.forEach(node => this.__graph_node_map.set(node.id, node))
        model.scalarNodes.forEach(node => this.__scalar_node_map.set(node.id, node))
        model.reach.forEach(rel => this.__reach_map.set(ReachKey(rel.state, rel.graph_id, rel.pred_id, rel.succ_id), rel))

        // collect all field names used in the model
        let fields_hash = new Set<string>()
        model.fields.forEach(field => fields_hash.add(field.name))

        // render the heap graph
        // let graphs = model.graphs.map(graph => this.renderGraph(graph)).join('\n\t')
        this.__client = this.getLatestFootprint(model.footprints.client)
        this.__callee = this.getLatestFootprint(model.footprints.callee)
        let footprint_ids = new Set<number>()
        let graphs = ``
        if (this.__client !== undefined && this.__callee !== undefined && this.__client !== this.__callee) {
            graphs = this.renderClientGraph()
            footprint_ids.add(this.__client.id)
            footprint_ids.add(this.__callee.id)
        } else if (this.__client !== undefined) {
            graphs = this.renderClientGraph()
            footprint_ids.add(this.__client.id)
        } else if (this.__callee !== undefined) {
            graphs = this.renderGraph(this.__callee)
            footprint_ids.add(this.__callee.id)
        }

        let outer_nodes = model.graphNodes.filter(node => 
            !node.isNull && !this.__rendered_node_ids.has(node.id)).map(node => 
                this.renderNode(node)).join('\n\t')
                
        let edges = model.fields.filter(field => 
            this.isFieldRef(field) && !this.isFieldValueNull(field)).map(field => 
                this.renderFieldRelation(field)).join('\n\t')
            
        // Reachability-related stuff
        let reach
        if (footprint_ids.size > 0) {
            // Footprints are defined ==> only footprint-local reachability should be rendered
            reach = this.renderReachRelations(model.reach.filter(rel => footprint_ids.has(rel.graph_id)))
        } else {
            // No footprint information; render all available reachability relations
            reach = this.renderReachRelations(model.reach)
        }
        
        
        // render the local store
        let local_refs = model.graphNodes.filter(n => n.isLocal())
        let local_scalar_nodes = model.scalarNodes.filter(n => n.isLocal())
        let nodes_worth_rendering = local_scalar_nodes.concat(local_refs)
        let store = this.renderLocalStore(nodes_worth_rendering)
        let refs = this.renderRefs(local_refs.filter(n => !n.isNull))
        
        this.__buffer = `digraph g {\n` + 
                        `\t${this.graphPreamble()}\n` + 
                        `\t${this.nodePreamble()}\n` + 
                        `\t${this.edgePreamble()}\n` + 
                        `\t${store}\n` + 
                        `\t${graphs}\n` + 
                        `\t${outer_nodes}\n` + 
                        `\t${refs}\n` + 
                        `\t${edges}\n` + 
                        `\t${reach}\n` + 
                        `}`
    }
}