import { Graph, GraphModel, GraphNode, isRef, Node, Relation, State } from "./Models";

export interface RenderOpts {
    is_carbon: boolean,
    rankdir_lr: boolean
}

export class DotGraph {

    private __state_map = new Map<string, State>()
    private __graph_node_map = new Map<number, GraphNode>()
    private __scalar_node_map = new Map<number, Node>()
    
    private getGraphNodeById(node_id: number): GraphNode | undefined {
        return this.__graph_node_map.get(node_id)
    }

    private getScalarNodeById(node_id: number): Node | undefined {
        return this.__scalar_node_map.get(node_id)
    }

    private renderNodeValue(node: Node): string {
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
        let nodesep = this.opts.rankdir_lr ? `` : ` nodesep="0.5pt" `
        return `graph [outputorder="nodesfirst" labelloc="t" label="" fontname="Helvetica" ${nodesep} ranksep="1pt" overlap=false ${rankdir}];`
    }
    private clusterPreamble(): string { 
        return `graph [labelloc="t" style="rounded" fontname="Helvetica" bgcolor="#dddddd" margin="40pt"];`
    }
    private nodePreamble(): string {
        return `node [height=0 width=0 style="filled" penwidth=1 fillcolor="white" fontname="Helvetica" shape="none" margin="0"];`
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

            return `<TR><TD align="text" PORT="${field.name}@${field.state.name}">` + 
                `${field.name}${state}` +
                (this.isFieldValueNull(field) ? ` = null` : (!this.isFieldRef(field) ? ` = ${val}` : ``)) +
                `<BR ALIGN="left" /></TD></TR>`
                   
        }).join('\n\t\t') + `\n`
    }

    private renderNode(node: GraphNode): string {
        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>${this.renderNodeValue(node)}</B></FONT></TD></TR>\n` + 
                    `\t\t` + this.nodeFields(node) + 
                    `\t\t</TABLE>`
        return `"N${node.id}" [${this.nodeSettings(node)} label=<${table}> ];`
    }

    private renderGraph(graph: Graph): string {
        return `subgraph cluster_${graph.id} {\n` + 
                `\t\t${this.clusterPreamble()}\n` + 
                `\t\tlabel="${graph.repr(true, true)} = ${this.renderNodeValue(graph)}";\n` + 
                `\t${graph.nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
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
            return `N${pred.id}:"${field.name}@${field.state.name}:e" -> N${succ.id}:"$HEAD:e";`
        } else {
            return `N${pred.id}:"${field.name}@${field.state.name}:e" -> N${succ.id}:"$HEAD";`
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

    private __buffer: string

    constructor(public model: GraphModel, 
                readonly opts: RenderOpts) {
        
        // hash nodes by their ids and states by their names
        model.graphNodes.forEach(node => this.__graph_node_map.set(node.id, node))
        model.scalarNodes.forEach(node => this.__scalar_node_map.set(node.id, node))
        model.states.forEach(state => this.__state_map.set(state.name, state))

        // collect all field names used in the model
        let fields_hash = new Set<string>()
        model.fields.forEach(field => fields_hash.add(field.name))

        // render the heap graph
        let graphs = model.graphs.map(graph => this.renderGraph(graph)).join('\n\t')
        let nodes_in_graphs = new Set(model.graphs.flatMap(graph => graph.nodes))
        let outer_nodes = model.graphNodes.filter(node => 
            !node.isNull && !nodes_in_graphs.has(node)).map(node => this.renderNode(node)).join('\n\t')
        let edges = model.fields.filter(field => 
            this.isFieldRef(field) && !this.isFieldValueNull(field)).map(field => 
                this.renderFieldRelation(field)).join('\n\t')
        
        // render the local store
        let local_refs = model.graphNodes.filter(n => n.isLocal)
        let local_scalar_nodes = model.scalarNodes.filter(n => n.isLocal)
        let store = this.renderLocalStore(local_scalar_nodes.concat(local_refs))
        let refs = this.renderRefs(local_refs.filter(n => !n.isNull))
        
        this.__buffer = `digraph g {\n` + 
                        `\t${this.graphPreamble()}\n` + 
                        `\t${this.nodePreamble()}\n` + 
                        `\t${store}\n` + 
                        `\t${graphs}\n` + 
                        `\t${outer_nodes}\n` + 
                        `\t${refs}\n` + 
                        `\t${edges}\n}`
    }
}