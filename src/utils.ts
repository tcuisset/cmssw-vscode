import * as vscode from "vscode";
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'

let outputChannel:vscode.OutputChannel|undefined = undefined
export function setOutputChannel(oc:vscode.OutputChannel|undefined) {
    outputChannel = oc
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function logToOC(val:any) {
    val = new String(val)
    if (outputChannel !== undefined)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        outputChannel.appendLine(val)
    else
        console.log(val)
}

export function errorNoReleaseSelected() {
    void vscode.window.showErrorMessage("Cannot run command since no CMSSW release is selected (select it using the status bar at the bottom right)")
}

/**
 * Returns true if the exception is ENOENT (file not found), false in all other cases
 * @param exception
 */
export function isENOENT(exception: unknown): boolean {
    return (
        (exception instanceof vscode.FileSystemError && exception.code === "FileNotFound") // unsing vscode API
        || (exception instanceof Error && "code" in exception && exception.code === "ENOENT") // using nodejs API (readFile)
    );
}

export async function checkDirectoryExists(uri: vscode.Uri): Promise<boolean> {
    try {
        return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
    } catch (e) {
        if (isENOENT(e))
            return false;
        throw e;
    }
}

/**
 * Removes from array the values that are in valsToRemove
 * @param array
 * @param valsToRemove
 * @returns
 */
export function removeFromArray(array: string[], valsToRemove: string[]) {
    const res = Array<string>();
    for (const configVal of array) {
        if (valsToRemove.indexOf(configVal) === -1) {
            res.push(configVal);
        }
    }
    return res;
}

/**
 * Update a workspace configuration key, keeping track in workspace storage of the values added by us
 * Values in config that were added by the extension previously but are no longer in valuesToAdd will be removed
 * @param config workspace configuration
 * @param key key into workspace config to store in
 * @param configManager updateManager to store in workspace storage
 * @param valuesToAdd the list of new values to replace in config
 * @returns
 */
export function updateConfigKeepingTrack(config: vscode.WorkspaceConfiguration, key: string, configManager: ConfigManager, valuesToAdd: string[]): Thenable<unknown> {
    let configValues = config.get<string[]>(key);
    if (configValues === undefined) {
        configValues = new Array<string>();
    }

    // Remove from the wp config the values that were previously added by the extension
    const cleanedConfigValues = removeFromArray(configValues, configManager._values);
    // Also don't add again values that might already be in the config but not managed by us
    // But still register them as added by the extension (not ideal but probably best option)
    cleanedConfigValues.push(...removeFromArray(valuesToAdd, cleanedConfigValues));

    return Promise.all([
        configManager.updateConfig(valuesToAdd),
        config.update(key, cleanedConfigValues, false)
    ]);
}

/**
 * Creates a symlink at linkPath pointing to target. If the link already exists, check that the target is identical.
 * If target is identical, do nothing. If target is different, delete the link and recreate it to the new target
 * @param target
 * @param linkPath
 * @throws only in case of unrecoverable error (such as symlink call fail with error != EEXIST, or unlink fail)
 */
export async function makeOrUpdateSymlink(target: string, linkPath: string) {
    try {
        await nodeFs.symlink(target, linkPath);
        console.log("Wrote symlink from " + linkPath + " to " + target);
    } catch (e) {
        // Any further error here is not recoverable so no try block
        if (e instanceof Error && "code" in e && e.code === "EEXIST") {
            // Symlink already exists. Check it is correct
            if (path.resolve(await nodeFs.readlink(linkPath)) === path.resolve(target))
                return;
            else {
                // recreate it
                await nodeFs.unlink(linkPath);
                await nodeFs.symlink(target, linkPath);
            }
        } else {
            throw e; // Weird error during symlink call
        }
    }
}

/**
 * Create an executable script at given location (creates file and chmod +x)
 * In case the file already exists, will replace its contents
 * @param mkdir create intermediate directories
 */
export async function createExecutableScript(scriptPath: vscode.Uri, content: string, mkdir = true) {
    if (mkdir)
        await vscode.workspace.fs.createDirectory(scriptPath.with({ path: path.dirname(scriptPath.path) }));
    await vscode.workspace.fs.writeFile(scriptPath, new TextEncoder().encode(content));
    // do chmod +x
    const stat = await nodeFs.stat(scriptPath.fsPath);
    let mode = stat.mode & 65535;
    const x = nodeFs.constants.S_IXUSR | nodeFs.constants.S_IXGRP | nodeFs.constants.S_IXOTH;
    mode |= x;
    await nodeFs.chmod(scriptPath.fsPath, mode);
}

/**
 * For a given vscode config key of type list (for ex python.analysis.include), stores in extension storage the values added to teh config by the extension
 * in order to separate user-added values and extension-added values
 */
export class ConfigManager {
    /** List of values that were set by the extension */
    _values: string[];
    /** worokspaceStorage (extension local storage) */
    _store: vscode.Memento;
    /** Name of config key, to be used as key in extension local storage */
    key: string;

    constructor(key: string, store: vscode.Memento) {
        this._values = store.get(key, Array<string>());
        this._store = store;
        this.key = key;
    }
    /** Replace the stored values with the given ones */
    updateConfig(newVals: string[]): Thenable<void> {
        return this._store.update(this.key, newVals);
    }
}

