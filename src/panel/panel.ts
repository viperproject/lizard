import { Logger } from './logger'

import JSONFormatter from 'json-formatter-js'

const Split = require('split-js')

import * as d3 from 'd3-graphviz'

declare var acquireVsCodeApi: any
export const vscode = acquireVsCodeApi()

const domElem = (q: string) => document.querySelector<HTMLElement>(q)!

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

function displayGraph(message: any) {

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
    Logger.info(`starting graph render...`)
    d3.graphviz("#graph", options).renderDot(dot)
    Logger.info(`graph render done.`)

    window.setTimeout(() => graph.style.opacity = '1', 100)
}


/** Sets up the debugger pane */ 
function activate() {
    Logger.debug("Setting up debug pane")

    setupPanelSplits()
    setupMessageHandlers()
    setupInputHandlers()

    Logger.debug("Done setting up debug pane")
}


/** Sets up the splits in the debug pane.  */
function setupPanelSplits() {
    let panels: HTMLElement[] = [...document.querySelectorAll<HTMLElement>('.panel')!]

    // Determine how many panels are opened by default, so we can compute the size of each open panel
    let isCollapsed = panels.map(e => e.classList.contains('collapsedByDefault'))
    // This is basically a fold
    let numberOfCollapsedPanels = isCollapsed.reduce((tot, collapsed) => collapsed ? tot + 1 : tot, 0)
    let percentForOpenPanel = 100 / (panels.length - numberOfCollapsedPanels)
    let sizes = isCollapsed.map(e => e ? 0 : percentForOpenPanel)

    Split(panels, {
        sizes: sizes,
        direction: 'vertical',
        cursor: 'row-resize',
        gutterSize: 5,
        minSize: 0,
        snapOffset: 40,  // When a panel is less than this, it closes
    })
}


/** Sets up the handlers for messages coming from the extension. */
function setupMessageHandlers() {
    Logger.debug("Setting up message handlers")

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
    
    Logger.debug("Done setting up message handlers.")
}

function initProgramStateSelect(message: any) {
    let progStateSelect = <HTMLSelectElement> domElem('select#programStates')
    let states: Array<{name: string, val: string}> = message.text
    states.forEach(state => {
        let item: HTMLOptionElement = document.createElement('option')
        item.value = state.name
        item.title = state.val
        item.label = state.name
        progStateSelect.add(item)
    })
    progStateSelect.disabled = false
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
    Logger.debug("Setting up input handlers.")

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
   
    Logger.debug("Done setting up input handlers.")
}

const JsonConfig = {
    hoverPreviewEnabled: true,
    hoverPreviewArrayCount: 3,
    hoverPreviewFieldCount: 4,
    theme: 'dark',
    animateOpen: false,
    animateClose: false,
    useToJSON: true,
    sortPropertiesBy: (a: string, b: string) => (a === '_' ? -1 : 0)
}

namespace PanelState {
    export var rawModel: JSONFormatter | undefined = undefined
}

function handleRawModelMessage(message: any, expand_all=false) {

    const expansion_level = expand_all ? Infinity : 1
    PanelState.rawModel = new JSONFormatter(message.text, expansion_level, JsonConfig)

    const pre = document.createElement('pre')
    pre.classList.add('json')
    pre.appendChild(PanelState.rawModel.render())

    let rawModel = domElem('#rawModel')
    removeAllChildren(rawModel)
    rawModel.appendChild(pre)
}

function handleGraphModelMessage(message: any) {

    const current = new JSONFormatter(message.text, 1, JsonConfig)

    const pre = document.createElement('pre')
    pre.classList.add('json')
    pre.appendChild(current.render())

    const modelElem = domElem('#graphModel')
    removeAllChildren(modelElem)
    modelElem.appendChild(pre)
}


// Start up the debugger pane
activate()