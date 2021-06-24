import { Graph, GraphModel, GraphNode, isRef, Node, Relation } from "./Models";


export class DotGraph {

    private __node_map: Map<number, GraphNode> | undefined = undefined 
    
    private getGraphNodeById(node_id: number): GraphNode {
        return this.__node_map!.get(node_id)!
    }

    private renderNodeValue(node: Node): string {
        let val_id = this.renderValue(node.val)
        switch (node.type!.typename) {
            case 'Ref':
                return `r${val_id}`
            case 'Int': 
                return `i${val_id}`
            case 'Perm': 
                return `p${val_id}`
            case 'Bool':
                return `b${val_id}`
            case 'Set[Ref]': 
                return `G${val_id}`
            default: 
                return `v${val_id}`
        }
    }

    private renderValue(value: string): string {
        if (this.isCarbon) {
            let m = value.match(/(T@T|T@U).*val\!(\d+)/)
            if (!m) {
                throw `cannot parse value from Carbon's model: ${value}`
            }
            return m[2]
        } else {
            // TODO
            return value
        }
    }

    private static graphPreamble = `graph [outputorder="nodesfirst" labelloc="t" label="" fontname="Helvetica" nodesep="1pt" ranksep="1pt" overlap=false];`
    private static clusterPreamble = `graph [labelloc="t" style="rounded" fontname="Helvetica" bgcolor="#dddddd" margin="40pt"];`
    private static nodePreamble = `node [height=0 width=0 style="filled" penwidth=1 fillcolor="white" fontname="Helvetica" shape="none" margin="0"];`

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

        // FIXME: there shouldn't be any unhashed nodes if the saturation mechanism is working properly 
        if (succ === undefined) {
            return false
        }

        return succ.type !== undefined && succ.type.typename === 'Ref'
    }
    
    private isFieldValueNull(field: Relation): boolean {
        let succ = this.getGraphNodeById(field.succ_id)
        return this.isFieldRef(field) && succ.isNull
    }

    private nodeFields(node: GraphNode): string {
        return node.fields.map(field => {
            let succ = this.getGraphNodeById(field.succ_id)

            // FIXME: there shouldn't be any unhashed nodes if the saturation mechanism is working properly 
            if (succ === undefined) {
                return ``
            }

            return `<TR><TD align="text" PORT="${field.name}@${field.state.name}">` + 
                   `${field.name}[${field.state.name}]` +
                   (this.isFieldValueNull(field) ? ` = null` : (!this.isFieldRef(field) ? ` = ${this.renderNodeValue(succ)}` : ``)) +
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
                `\t\t${DotGraph.clusterPreamble}\n` + 
                `\t\tlabel="${graph.repr(true, true)} = ${this.renderNodeValue(graph)}";\n` + 
                `\t${graph.nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
    }

    private renderField(field: Relation): string {
        if (this.isFieldValueNull(field)) {
            return ``
        } else {
            let pred = this.getGraphNodeById(field.pred_id)
            let succ = this.getGraphNodeById(field.succ_id)

            // FIXME: there shouldn't be any unhashed nodes if the saturation mechanism is working properly 
            if (succ === undefined) {
                return ``
            }

            return `N${pred.id}:"${field.name}@${field.state.name}:e" -> N${succ.id}:"$HEAD";`
        }
    }

    private storeNodes(nodes: Array<Node>): string {
        return nodes.map(node => {
            let repr: string
            if (isRef(node.type)) {
                repr = node.repr(true, !(<GraphNode> node).isNull)
            } else {
                // not a graph node
                repr = node.repr(true, false)
            }

            return `<TR><TD align="text" PORT="Local_N${node.id}">` + 
                   repr + `<BR ALIGN="left" /></TD></TR>`
        }).join('\n\t\t') + '\n'
    }

    private renderLocalStore(nodes: Array<Node>): string {

        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>Local </B></FONT></TD></TR>\n` + 
                    `\t\t` + this.storeNodes(nodes) + 
                    `\t</TABLE>`
        return `"$Store" [ label=<${table}> ];`
    }

    private renderRefs(graph_nodes: Array<GraphNode>): string {
        return graph_nodes.map(ref_node => {
                if (ref_node.isNull) {
                    return ``
                } else {
                    return `"$Store":Local_N${ref_node.id}:e -> N${ref_node.id}:"$HEAD" [constraint=false style=dotted];`
                }
            }).join('\n\t')
    }

    private __buffer: string

    constructor(public model: GraphModel, 
                readonly isCarbon: boolean) {

        // hash nodes by their ids
        this.__node_map = new Map<number, GraphNode>()
        model.graphNodes.forEach(node => this.__node_map!.set(node.id, node))

        // collect all fields names used in the model
        let fields_hash = new Set<string>()
        model.fields.forEach(field => fields_hash.add(field.name))

        let graphs = model.graphs.map(graph => this.renderGraph(graph)).join('\n\t')
        let edges = model.fields.map(field => this.renderField(field)).join('\n\t')
        
        // render the local store
        let store = this.renderLocalStore(model.scalarNodes.concat(model.graphNodes.filter(n => !n.isNull)))
        let refs = this.renderRefs(model.graphNodes)
        
        this.__buffer = `digraph g {\n` + 
                        `\t${DotGraph.graphPreamble}\n` + 
                        `\t${DotGraph.nodePreamble}\n` + 
                        `\t${store}\n` + 
                        `\t${graphs}\n` + 
                        `\t${refs}\n` + 
                        `\t${edges}\n}`
    }
}