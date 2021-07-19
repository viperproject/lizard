import JSONFormatter from 'json-formatter-js'
import Split from 'split.js'
import * as d3 from 'd3-graphviz'

import { Logger } from './logger'

declare var acquireVsCodeApi: any
export const vscode = acquireVsCodeApi()

const domElem = (q: string) => document.querySelector<HTMLElement>(q)!
const domElems = (q: string) => document.querySelectorAll<HTMLElement>(q)

function removeAllChildren(elem: HTMLElement) {
    while (elem.firstChild) {
        elem.removeChild(elem.firstChild)
    }
}

function getSelectValues(select: HTMLSelectElement): Array<string> {
    // Based on https://stackoverflow.com/a/27781069/12163693

    let result = []
    let options = select && select.options

    for (let opt, i=0; i < options.length; i ++) {
        opt = options[i]

        if (opt.selected) {
            result.push(opt.value || opt.text)
        }
    }

    return result
}

function setSelectedElements(select: HTMLSelectElement, mode: 'all' | 'last'): void {
    let options = select && select.options

    for (let opt, i=0; i < options.length; i ++) {
        opt = options[i]
        if (mode === 'all' || mode === 'last' && i === options.length-1) {
            opt.selected = true
        }
    }
}   

function removeAllOptions(select: HTMLSelectElement) {
    // Based on https://stackoverflow.com/a/3364546/12163693

    for (let i = select.options.length - 1; i >= 0; i--) {
        select.remove(i)
    }
 }

/** Sets up the debugger pane */ 
function activate() {
    Logger.debug("Setting up debug pane...")

    setupPanelSplits()
    setupMessageHandlers()
    setupInputHandlers()

    Logger.debug("...Done setting up debug pane.")
}


/** Sets up the splits in the debug pane.  */
function setupPanelSplits() {
    Logger.info("\tSetting up panel splits...")

    let panels: HTMLElement[] = [...document.querySelectorAll<HTMLElement>('.panel')!]

    Logger.info(`panels: ${panels}`)

    // Determine how many panels are opened by default, so we can compute the size of each open panel
    // let isCollapsed = panels.map(e => e.classList.contains('collapsedByDefault'))
    // This is basically a fold
    // let numberOfCollapsedPanels = isCollapsed.reduce((tot, collapsed) => collapsed ? tot + 1 : tot, 0)
    // let percentForOpenPanel = 100 / (panels.length - numberOfCollapsedPanels)
    // let sizes = isCollapsed.map(e => e ? 0 : percentForOpenPanel)

    let sizes = panels.map(panel => panel.offsetHeight)
    let total = sizes.reduce((tot, x) => tot + x)
    let rel_sizes = sizes.map(size => 100*size/total)
    Logger.info(`panels have sizes: ${rel_sizes.join('% ')}`)

    Split(['#nav', '#graphPanel', '#diagnostics'], {
        sizes: rel_sizes,
        // maxSize: [80, +Infinity, +Infinity], 
        minSize: 0,
        snapOffset: 20,  // When a panel is less than this, it closes
        direction: 'vertical',
        cursor: 'row-resize',
        gutterSize: 10,
    })

    Logger.info("\t...Done setting up panel splits...")
}

/** Sets up the handlers for messages coming from the extension. */
function setupMessageHandlers() {
    Logger.debug("\tSetting up message handlers...")

    // Helper function for setting callbacks
    function on(key: string, callback: (message: any) => void) {
        window.addEventListener('message', e => {
            let message = e.data
            if (message.type === key) {
                callback(message)
            }
        })
    }

    on('logModel', message => handleGraphModelMessage(message))
    on('rawModelMessage', message => handleRawModelMessage(message))
    on('renderDotGraph', message => displayGraph(message))
    on('programStates', message => { initProgramStateSelect(message) })
    on('verificationFailures', message => { initVerificationFailureSelect(message) })
    
    Logger.debug("\t...Done setting up message handlers.")
}

function toggleSection(buttonId: string, sectionId: string) {
    const section = domElem(sectionId)
    section.classList.toggle('hide')
    if (section.classList.contains('hide')) {
        domElem(buttonId).innerText = "Show"
    } else {
        domElem(buttonId).innerText = "Hide"
    }
}

// TODO: keyboard events from panel?
/** Sets up handlers for button events in the debugger pane. */
function setupInputHandlers() {
    Logger.debug("\tSetting up input handlers...")

    domElem('button#toggleGraphModel').onclick = () => 
        toggleSection('button#toggleGraphModel', '#graphModel')

    domElem('button#toggleDotGraphSource').onclick = () => 
        toggleSection('button#toggleDotGraphSource', '#dotGraphSource')
    
    domElem('button#copyGraphModel').onclick = () => {
        const temp = document.createElement('textarea')
        domElem('body').appendChild(temp)
        temp.value = domElem('#graphModel').innerText
        temp.select()
        document.execCommand('copy')
        temp.remove()
    }
    domElem('button#toggleRawModel').onclick = () => 
        toggleSection('button#toggleRawModel', '#rawModel')

    domElem('button#expandRawModel').onclick = () => 
        PanelState.rawModel!.openAtDepth(Infinity)

    let progStateSelect = <HTMLSelectElement> domElem('select#programStates')
    progStateSelect.onchange = function() {
        const disabled = progStateSelect.hasAttribute('disabled')
        if (!disabled) {
            let selected = getSelectValues(progStateSelect)
            vscode.postMessage({ command: 'filterStates', state_names: selected })
        }
    }

    let verFailureSelect = <HTMLSelectElement> domElem('select#verificationFailures')
    verFailureSelect.onchange = function () {
        const disabled = verFailureSelect.hasAttribute('disabled')
        if (!disabled) {
            let selected: Array<string> = getSelectValues(verFailureSelect)
            if (selected.length !== 1) {
                throw `there should be exacly one selected verification failure at any point in time (found ${selected})`
            }
            vscode.postMessage({ command: 'selectFailure', failure_id: selected[0] })
        }
    }
    
    let toggleRankDirButton = <HTMLButtonElement> domElem('button#toggleRankDir')
    toggleRankDirButton.onclick = () => {
        const disabled = progStateSelect.hasAttribute('disabled')
        if (!disabled) {
            vscode.postMessage({ command: 'toggleRankDir' })
        }
    }

    let toggleDotNodesButton = <HTMLButtonElement> domElem('button#toggleDotNodes')
    toggleDotNodesButton.onclick = () => {
        const disabled = progStateSelect.hasAttribute('disabled')
        if (!disabled) {
            vscode.postMessage({ command: 'toggleDotNodes' })
        }
    }
   
    Logger.debug("\t...Done setting up input handlers.")
}

const JsonConfig = {
    hoverPreviewEnabled: true,
    hoverPreviewArrayCount: 3,
    hoverPreviewFieldCount: 4,
    theme: 'dark',
    animateOpen: false,
    animateClose: false,
    useToJSON: false,
    sortPropertiesBy: (a: string, b: string) => (a === '_' ? -1 : 0)
}

namespace PanelState {
    export var rawModel: JSONFormatter | undefined = undefined
}

function handleRawModelMessage(message: any, expand_all=false) {

    Logger.info(`Processing raw model message...`)

    const expansion_level = expand_all ? Infinity : 1
    PanelState.rawModel = new JSONFormatter(message.text, expansion_level, JsonConfig)

    const pre = document.createElement('pre')
    pre.classList.add('json')
    pre.appendChild(PanelState.rawModel.render())

    let rawModel = domElem('#rawModel')
    removeAllChildren(rawModel)
    rawModel.appendChild(pre)

    Logger.info(`...Done processing raw model message.`)
}

function handleGraphModelMessage(message: any) {

    Logger.info(`Processing graph model message...`)

    const current = new JSONFormatter(message.text, 1, JsonConfig)

    const pre = document.createElement('pre')
    pre.classList.add('json')
    pre.appendChild(current.render())

    const modelElem = domElem('#graphModel')
    removeAllChildren(modelElem)
    modelElem.appendChild(pre)

    Logger.info(`...Done processing graph model message.`)
}

function initProgramStateSelect(message: any) {

    Logger.info(`Processing program states message...`)

    let progStateSelect = <HTMLSelectElement> domElem('select#programStates')
    removeAllOptions(progStateSelect)

    let states: Array<{name: string, val: string}> = message.text
    states.forEach(state => {
        let item: HTMLOptionElement = document.createElement('option')
        item.value = state.name
        item.title = state.val
        item.label = `State ${state.name}`
        progStateSelect.add(item)
    })
    progStateSelect.disabled = false
    setSelectedElements(progStateSelect, 'all')

    Logger.info(`...Done processing program states message.`)
}

function initVerificationFailureSelect(message: any) {

    Logger.info(`Processing verification failures message...`)

    let verFailureSelect = <HTMLSelectElement> domElem('select#verificationFailures')
    removeAllOptions(verFailureSelect)

    let failures: Array<{line: number, column: number, text: string, id: string}> = message.text
    failures.forEach(f => {
        let item: HTMLOptionElement = document.createElement('option')
        item.value = f.id
        item.title = f.text
        item.label = `Failure ${f.id} (Ln ${f.line}, Col ${f.column})`
        verFailureSelect.add(item)
    })
    verFailureSelect.disabled = false
    setSelectedElements(verFailureSelect, 'last')

    Logger.info(`...Done processing verification failures message.`)
}

function displayGraph(message: any) {

    Logger.info(`Processing display graph message...`)

    let dot = message.text

    // Print the DOT code for debug purposes
    const pre = document.createElement('pre')
    pre.classList.add('json')
    pre.innerText = dot

    const dotGraphSource = domElem('#dotGraphSource')
    removeAllChildren(dotGraphSource)
    dotGraphSource.appendChild(pre)
    
    const graph = document.createElement('div')
    graph.id = 'graph'

    const graphPanel = domElem('#graphPanel')
    removeAllChildren(graphPanel)
    graphPanel.appendChild(graph)
    
    let options = {
        fit: true, 
        useWorker: false
    }
    Logger.info(`\tStarting graph render...`)
    d3.graphviz("#graph", options).renderDot(dot)
    Logger.info(`\tDone rendering graph.`)

    window.setTimeout(() => graph.style.opacity = '1', 100)

    // Enable all render-related buttons
    let graph_buttons = domElems('#renderOptions button')
    graph_buttons.forEach(button => (<HTMLButtonElement> button).disabled = false)

    Logger.info(`...Done processing display graph message.`)
}


// Start up the debugger pane
activate()
