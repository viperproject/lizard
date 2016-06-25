'use strict';

//import {Position} from 'vscode';
import {Log} from './Log';
import {Model} from './Model';

export enum StatementType { EXECUTE, EVAL, CONSUME, PRODUCE };

interface Position {
    line: number;
    character: number;
}

interface Variable {
    name: string;
    value: string;
    variablesReference: number;
}
class HeapChunk {
    name: string;
    value: string;
    permission: string;

    constructor(name: string, value: string, permission: string) {
        this.name = name;
        this.value = value;
        this.permission = permission;
    }

    pretty(): string {
        return this.name + (this.value ? " -> " + this.value : "") + " # " + this.permission;
    }
    equals(other: HeapChunk): boolean {
        return this.name == other.name && this.permission == other.permission && this.value == other.value;
    }
}

interface SplitResult {
    prefix: string;
    rest: string;
}

export class Statement {
    type: StatementType;
    public position: Position;
    formula: string;
    public store: Variable[];
    heap: HeapChunk[];
    oldHeap: HeapChunk[];
    conditions: string[];

    constructor(firstLine: string, store: string, heap: string, oldHeap: string, conditions: string, model: Model) {
        this.parseFirstLine(firstLine);
        this.store = this.parseVariables(this.unpack(store, model));
        this.heap = this.unpackHeap(this.unpack(heap, model));
        this.oldHeap = this.unpackHeap(this.unpack(oldHeap, model));
        //TODO: implement unpackConditions
        this.conditions = this.unpack(conditions, model);
    }

    private parseVariables(vars: string[]): Variable[] {
        let result = [];
        vars.forEach((variable) => {
            let parts: string[] = variable.split('->');
            if (parts.length == 2) {
                result.push({ name: parts[0].trim(), value: parts[1].trim(), variablesReference: 0 });
            }
            else {
                //TODO: make sure this doesn't happen
                result.push({ name: variable, value: "unknown", variablesReference: 0 });
            }
        });
        return result;
    }

    private unpack(line: string, model: Model): string[] {
        line = line.trim();
        if (line == "{},") {
            return [];
        } else {
            let res = [];
            line = line.substring(line.indexOf("(") + 1, line.lastIndexOf(")"));
            line = model.fillInValues(line);
            return this.splitAtComma(line);
        }
    }

    private unpackHeap(parts: string[]): HeapChunk[] {
        if (!parts) {
            return [];
        }
        let res = [];
        try {
            parts.forEach((part) => {
                let arrowPosition = part.indexOf("->");
                let hashTagPosition = part.indexOf("#", arrowPosition);
                if (arrowPosition > 0) {
                    var name: string = part.substring(0, arrowPosition - 1).trim();
                    var value: string = part.substring(arrowPosition + 3, hashTagPosition - 1).trim();
                } else {
                    name = part.substring(0, hashTagPosition - 1).trim();
                    value = null;
                }
                let permission = part.substring(hashTagPosition + 2, part.length);
                res.push(new HeapChunk(name, value, permission));
            });
        } catch (e) {
            Log.error("Heap parsing error: " + e);
        }
        return res;
    }

    private splitAtComma(line: string): string[] {
        let parts = [];
        let i = 0;
        let bracketCount = 0;
        let lastIndex = -1;
        //walk through line to determine end of permission
        while (i < line.length) {
            let char = line[i];
            if (char == '(' || char == '[' || char == '{') {
                bracketCount++;
            }
            else if (char == ')' || char == ']' || char == '}') {
                bracketCount--;
            }
            else if (char == ',' && bracketCount == 0) {
                parts.push(line.substring(lastIndex+1, i).trim())
                lastIndex = i;
            }
            i++;
        }
        if (i + 1 < line.length) {
            parts.push(line.substring(i + 1, line.length))
        }
        return parts;
    }

    public pretty(): string {
        let positionString = "\nPosition: " + (this.position ? this.position.line + ":" + this.position.character : "<no position>") + "\n";

        let res: string = "Type: " + StatementType[this.type] + positionString;
        res += "Formula: " + this.formula + "\n";
        if (this.store.length > 0) {
            res += "Store: \n";
            this.store.forEach(element => {
                res += "\t" + element.name + " = " + element.value + "\n"
            });
        }

        let heapChanged = !this.oldHeapEqualsHeap();
        if (this.heap.length > 0) {
            if (!heapChanged) {
                res += "Heap == OldHeap: \n";
            } else {
                res += "Heap: \n";
            }
            this.heap.forEach(element => {
                res += "\t" + element.pretty() + "\n";
            });
        }
        if (heapChanged && this.oldHeap.length > 0) {
            res += "OldHeap: \n";
            this.oldHeap.forEach(element => {
                res += "\t" + element.pretty() + "\n";
            });
        }
        if (this.conditions.length > 0) {
            res += "Condition: \n";
            this.conditions.forEach(element => {
                res += "\t" + element + "\n"
            });
        }
        return res;
    }

    private oldHeapEqualsHeap(): boolean {

        if (this.heap.length != this.oldHeap.length) {
            return false;
        }
        for (let i = 0; i < this.heap.length; i++) {
            if (!this.heap[i].equals(this.oldHeap[i])) {
                return false;
            }
        }
        return true;
    }

    private parseFirstLine(line: string): Position {
        let parts = /(.*?)\s+((\d*):(\d*)|<no position>):\s+(.*)/.exec(line);
        if (!parts) {
            Log.error('could not parse first Line of the silicon trace message : "' + line + '"');
            return;
        }
        let type = parts[1];
        if (type === "CONSUME") {
            this.type = StatementType.CONSUME;
        } else if (type === "PRODUCE") {
            this.type = StatementType.PRODUCE;
        } else if (type === "EVAL") {
            this.type = StatementType.EVAL;
        } else if (type === "EXECUTE") {
            this.type = StatementType.EXECUTE;
        }
        if (parts.length == 6) {
            //subtract 1 to confirm with VS Codes 0-based numbering
            let lineNr = +parts[3] - 1;
            let charNr = +parts[4] - 1;
            this.position = { line: lineNr, character: charNr };

            this.formula = parts[5].trim();
        }
        if (parts.length == 4) {
            this.formula = parts[3].trim();
        }
    }
}