import { Graph, GraphModel, Node, Relation } from "./Models";


export class DotGraph {

    private fieldNames: Array<string> | undefined = undefined

    private static graphPreamble = `graph [fontsize=20 labelloc="t" label="" splines=true overlap=false rankdir="LR"];`
    private static clusterPreamble = `graph [labelloc="t" style="rounded" bgcolor="#dddddd"];`
    private static nodePreamble = `node [style="filled" penwidth=1 fillcolor="white" fontname="Courier New" shape="none" margin="0"];`

    private nodeSettings(node: Node) { 
        return ``//`style="filled" penwidth=1 fillcolor="white" fontname="Courier New" shape="Mrecord" `
    }

    // private edgeSettings(edge: Relation) {
    //     return `penwidth = 1 fontsize = 14 fontcolor = "grey28"`
    // }

    public dotEncoding(): string {
        return this.__buffer
    }

    private renderNode(node: Node): string {
        let table = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">\n` +
                    `\t\t<TR><TD BGCOLOR="black" PORT="$HEAD"><FONT COLOR="white"><B>${node.repr(true)}</B></FONT></TD></TR>\n` + 
                    `\t\t` + this.fieldNames!.map(fname => `<TR><TD align="text" PORT="${fname}">${fname}<BR ALIGN="left" /></TD></TR>`).join('\n\t\t') + `\n` +
                    `\t\t</TABLE>`
        return `"N${node.id}" [${this.nodeSettings(node)} label=<${table}> ];`
    }

    private renderGraph(graph: Graph): string {
        return `subgraph cluster_${graph.id} {\n` + 
                `\t\t${DotGraph.clusterPreamble}\n` + 
                `\t\tlabel="${graph.repr(true)}";\n` + 
                `\t${graph.nodes.map(node => this.renderNode(node)).join('\n\t')}\n\t}`
    }

    private renderField(field: Relation): string {
        return `N${field.pred.id}:"${field.name}" -> N${field.succ.id}:"$HEAD";`
    }

    private __buffer: string

    constructor(public model: GraphModel) {

        // collect all fields names used in the model
        let fields_hash = new Set<string>()
        model.fields.forEach(field => fields_hash.add(field.name))
        this.fieldNames = Array.from(fields_hash)

        // let nodes = model.nodes.map(node => this.renderNode(node)).join('\n\t')
        let graphs = model.graphs.map(graph => this.renderGraph(graph)).join('\n\t')
        let edges = model.fields.map(field => this.renderField(field)).join('\n\t')
        this.__buffer = `digraph g {\n` + 
                        `\t${DotGraph.graphPreamble}\n` + 
                        `\t${DotGraph.nodePreamble}\n` + 
                        `\t${graphs}\n` + 
                        `\t${edges}\n}`
    }
}