import { Graph, GraphModel, GraphNode, isNull, isRef, LocalRelation, Node, Relation, State } from "./Models";

export interface RenderOpts {
    is_carbon: boolean,
    rankdir_lr: boolean
}

type ReachKey = string
function ReachKey(state: State, graph_id: number, pred_id: number, succ_id: number): string {
    return `${state.name}|${graph_id}|${pred_id}|${succ_id}`
}

export class DotGraph {

    private static GRAPH_BGCOLOR = '#dddddd'
    private static CLIENT_BGCOLOR = '#ddddff'
    private static CALLEE_BGCOLOR = '#ffdddd'
    
    private static REACH_COLOR = `#ffffff5f`
    private static CLIENT_COLOR = `#0000ff5f`
    private static CALLEE_COLOR = `#ff00005f`

    private __state_map = new Map<string, State>()
    private __graph_map = new Map<number, Graph>()
    private __client: Graph | undefined
    private __callee: Graph | undefined
    private __graph_node_map = new Map<number, GraphNode>()
    private __scalar_node_map = new Map<number, Node>()
    private __reach_map = new Map<ReachKey, LocalRelation>()
    
    private getGraphById(graph_id: number): Graph | undefined {
        return this.__graph_map.get(graph_id)
    }

    private getGraphNodeById(node_id: number): GraphNode | undefined {
        return this.__graph_node_map.get(node_id)
    }

    private getScalarNodeById(node_id: number): Node | undefined {
        return this.__scalar_node_map.get(node_id)
    }

    private getReachability(state: State, graph_id: number, pred_id: number, succ_id: number): LocalRelation | undefined {
        return this.__reach_map.get(ReachKey(state, graph_id, pred_id, succ_id))
    }

    private renderNodeValue(node: Node): string {
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
        return `graph [outputorder="nodesfirst" label="" fontname="Helvetica" ${nodesep} ranksep=0.5 ${rankdir}];`
    }
    private clusterPreamble(bgcolor: string): string { 
        return `graph [labelloc="t" style="rounded" fontname="Helvetica" bgcolor="${bgcolor}" margin=18];`
    }
    private nodePreamble(): string {
        return `node [height=0 width=0 fontname="Helvetica" shape="none" margin=0.05];`
    }

    private edgePreamble(): string {
        return `edge [fontname="Helvetica" arrowsize=0.4]`
    }

    private nodeSettings(node: Node) { 
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

    private nodeFields(node: GraphNode): string {
        return node.fields.filter(field => 
            this.__state_map.has(field.state.name))
        .map(field => {  
            let state = (this.__state_map.size > 1) ? `[${field.state.name}]` : ``
            let succ = this.getGraphNodeById(field.succ_id)

            let val: string
            if (succ === undefined) {
                // Treat as scalar field
                let scalar_succ = this.getScalarNodeById(field.succ_id)
                if (scalar_succ === undefined) {
                    throw `there shouldn't be any unhashed nodes if the saturation mechanism is working properly, but N${field.succ_id} is not hashed`
                }
                val = this.renderNodeValue(scalar_succ)
            } else {
                // Treat as Ref-field
                val = this.renderNodeValue(succ)
            }

            return `<TR><TD align="text" BGCOLOR="#ffffff" PORT="${field.name}@${field.state.name}">` + 
                `${field.name}${state}` +
                (this.isFieldValueNull(field) ? ` = null` : (!this.isFieldRef(field) ? ` = ${val}` : ``)) +
                `<BR ALIGN="left" /></TD></TR>`
                   
        }).join('\n\t\t') + `\n`
    }

    private renderNode(node: GraphNode): string {
        let head_label = node.isLocal ? `${node.proto} = ${this.renderNodeValue(node)}` : this.renderNodeValue(node)
        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>${head_label}</B></FONT></TD></TR>\n` + 
                    `\t\t` + this.nodeFields(node) + 
                    `\t\t</TABLE>`
        return `"N${node.id}" [${this.nodeSettings(node)} label=<${table}> ];`
    }

    private renderGraph(graph: Graph): string {
        return `subgraph cluster_${graph.id} {\n` + 
                `\t\t${this.clusterPreamble(DotGraph.GRAPH_BGCOLOR)}\n` + 
                `\t\tlabel="${graph.repr(true, true)} = ${this.renderNodeValue(graph)}";\n` + 
                `\t${graph.nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
    }

    private renderCalleeGraph(): string {
        let callee = this.__callee!
        return `subgraph cluster_${callee.id} {\n` + 
               `\t\t${this.clusterPreamble(DotGraph.CALLEE_BGCOLOR)}\n` + 
               `\t\tlabel="${callee.repr(true, true)} = ${this.renderNodeValue(callee)}";\n` + 
               `\t${callee.nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
    }

    private renderClientGraph(): string {
        
        let client = this.__client!
        let callee = this.__callee!

        let callee_str = this.renderCalleeGraph()

        let callee_nodes = new Set(callee.nodes)
        let frame_nodes = client.nodes.filter(node => !callee_nodes.has(node))

        return `subgraph cluster_${client.id} {\n` + 
                `\t\t${this.clusterPreamble(DotGraph.CLIENT_BGCOLOR)}\n` + 
                `\t\tlabel="${client.repr(true, true)} = ${this.renderNodeValue(client)}";\n` + 
                `\t${callee_str}\n` + 
                `\t${frame_nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
    }

    private renderFieldRelation(field: Relation): string {
        let pred = this.getGraphNodeById(field.pred_id)
        let succ = this.getGraphNodeById(field.succ_id)

        if (pred === undefined || succ === undefined) {
            throw `both pred and succ of a heap-related graph nodes must be hashed at this point, ` + 
                  `but N${field.pred_id} or N${field.succ_id} are not`
        }

        if (pred.id === succ.id && this.opts.rankdir_lr) {
            // special case for self-edges
            return `N${pred.id}:"${field.name}@${field.state.name}":e -> N${succ.id}:"$HEAD":e;`
        } else {
            return `N${pred.id}:"${field.name}@${field.state.name}":e -> N${succ.id}:"$HEAD";`
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

        let state = (this.__state_map.size > 1) ? `<SUB>${rel.state.name}</SUB>` : ``
        let graph_lbl 
        let color 
        if (graph === this.__client) {
            graph_lbl = ``
            color = DotGraph.CLIENT_COLOR
        } else if (graph === this.__callee) {
            graph_lbl = ``
            color = DotGraph.CALLEE_COLOR
        } else {
            graph_lbl = (this.__graph_map.size > 1) ? `(${graph.repr(true, true)})` : ``
            color = DotGraph.REACH_COLOR
        }
        let label = `<${rel.name}${state}${graph_lbl}>`
        let dashed = rel.name === 'P' ? `` : `style="dashed"`
        // let constrant = rel.name === 'P' ? `true` : `false`
        let constrant = rel.name === `true`
        if (is_mutual) {
            return `N${pred.id} -> N${succ.id} [label=${label} color="${color}" penwidth=2 ${dashed} arrowhead="none" arrowtail="none" dir="both" constraint=${constrant} ];`
        } else {
            return `N${pred.id} -> N${succ.id} [label=${label} color="${color}" penwidth=2 ${dashed} arrowhead="open" arrowsize=0.8 constraint=${constrant} ];`
        }
    }

    private storeNodes(nodes: Array<Node>): string {
        return nodes.map(node => {
            let repr: string
            if (isRef(node.type)) {
                // this is a graph node
                repr = node.repr(true, true)
            } else {
                // not a graph node
                repr = `${node.repr(true, true)} = ${this.renderNodeValue(node)}`
            }

            return `<TR><TD align="text" PORT="Local_N${node.id}">` + 
                   repr + `<BR ALIGN="left" /></TD></TR>`
        }).join('\n\t\t') + '\n'
    }

    private renderLocalStore(nodes: Array<Node>): string {

        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>Local </B></FONT></TD></TR>\n` + 
                    `\t\t` + this.storeNodes(nodes) + 
                    `\t\t</TABLE>`
        return `"$Store" [ label=<${table}> ];`
    }

    private renderRefs(graph_nodes: Array<GraphNode>): string {
        let constraint = this.opts.rankdir_lr ? `` : `constraint=false `
        return graph_nodes.map(ref_node => 
            `"$Store":Local_N${ref_node.id}:e -> N${ref_node.id}:"$HEAD" [${constraint}style=dotted];`).join('\n\t')
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

    private __buffer: string

    constructor(public model: GraphModel, 
                readonly opts: RenderOpts) {
        
        // hash nodes by their ids and states by their names
        model.states.forEach(state => this.__state_map.set(state.name, state))
        model.graphs.forEach(graph => this.__graph_map.set(graph.id, graph))
        model.graphNodes.forEach(node => this.__graph_node_map.set(node.id, node))
        model.scalarNodes.forEach(node => this.__scalar_node_map.set(node.id, node))
        model.reach.forEach(rel => this.__reach_map.set(ReachKey(rel.state, rel.graph_id, rel.pred_id, rel.succ_id), rel))

        // collect all field names used in the model
        let fields_hash = new Set<string>()
        model.fields.forEach(field => fields_hash.add(field.name))

        // render the heap graph
        // let graphs = model.graphs.map(graph => this.renderGraph(graph)).join('\n\t')
        this.__client = model.footprints.client
        this.__callee = model.footprints.callee
        let footprint_ids = new Set<number>()
        let graphs = ``
        if (this.__client !== undefined && this.__callee !== undefined && this.__client !== this.__callee) {
            graphs = this.renderClientGraph()
            footprint_ids.add(this.__client.id)
            footprint_ids.add(this.__callee.id)
        } else if (this.__client !== undefined) {
            graphs = this.renderGraph(this.__client)
            footprint_ids.add(this.__client.id)
        } else if (this.__callee !== undefined) {
            graphs = this.renderGraph(this.__callee)
            footprint_ids.add(this.__callee.id)
        }

        let nodes_in_graphs = new Set(model.graphs.flatMap(graph => graph.nodes))
        let outer_nodes = model.graphNodes.filter(node => 
            !node.isNull && !nodes_in_graphs.has(node)).map(node => this.renderNode(node)).join('\n\t')
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
        let local_refs = model.graphNodes.filter(n => n.isLocal)
        let local_scalar_nodes = model.scalarNodes.filter(n => n.isLocal)
        let store = this.renderLocalStore(local_scalar_nodes.concat(local_refs))
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