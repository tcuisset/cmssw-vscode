import * as vscode from "vscode";

/**
 * A handle on a CMSSW release folder
 */
export class CmsRelease {
    /**
     * Path to root folder of release, holding src, bin, etc folders
     */
	rootFolder:vscode.Uri;
    /**
     * value of $SCRAM_ARCH
     */
	scram_arch:string;
    /**
     * scram version of release, ie CMSSW_14_0_0_pre1
     */
	cmssw_release:string;

    constructor(rootFolder:vscode.Uri, scram_arch:string, cmssw_release:string) {
        this.rootFolder = rootFolder
        this.scram_arch = scram_arch
        this.cmssw_release = cmssw_release
    }
}

export function userFriendlyReleaseLocation(release:CmsRelease):string {
    return vscode.workspace.asRelativePath(release.rootFolder) + " (" + release.cmssw_release + ")"
}

export function workspaceFolderForRelease(release:CmsRelease) : vscode.WorkspaceFolder {
	const res = vscode.workspace.getWorkspaceFolder(release.rootFolder);
	if (res === undefined) {
		throw new Error("Could not find workspace folder for release root " + release.rootFolder.toString())
	}
	return res
}
// cfi python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/cfipython/$SCRAM_ARCH/Pkg/SubPjg/thing_cfi.py
// python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/python/thing.py
// C++ located at // python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/(include|src|plugins)/(thing.h|cpp)
// TODO patch release
export class Package {
	subsystem: string;
	packageName: string;

	constructor(str: string) {
		const splitStr = str.split('/');
		if (splitStr.length != 2)
			throw Error("Could not parse " + str + " as CMSSW package (should be of form Pkg/SubPkg)");
		this.subsystem = splitStr[0];
		this.packageName = splitStr[1];
	}
}

export class ConfigManager {
    _values:string[]
    _store:vscode.Memento
    key:string

    constructor(key:string, store:vscode.Memento) {
        this._values = store.get(key, Array<string>())
        this._store = store
        this.key = key
    }

    updateConfig(newVals:string[]):Thenable<void> {
        return this._store.update(this.key, newVals)
    }
}

/**
 * Removes from configValues the values that are in extensionValues
 * @param configValues 
 * @param extensionValues 
 * @returns 
 */
function removeOurValuesFromConfig(configValues:string[], extensionValues:string[]) {
    let res = Array<string>();
    for (const configVal of configValues) {
        if (extensionValues.indexOf(configVal) === -1) {
            res.push(configVal)
        }
    }
    return res
}

/**
 * Update a workspace configuration key, keeping track in workspace storage of the keys added by us
 * @param config workspace configuration
 * @param key key into workspace config to store in
 * @param configManager updateManager to store in workspace storage
 * @param valuesToAdd the list of new values to replace in config
 * @returns 
 */
export function updateConfigKeepingTrack(config: vscode.WorkspaceConfiguration, key: string, configManager:ConfigManager, valuesToAdd: string[]): Thenable<any> {
	let configValues = config.get<string[]>(key);
	if (configValues === undefined) {
		configValues = new Array<string>();
	}

    let cleanedConfigValues = removeOurValuesFromConfig(configValues, configManager._values)
    cleanedConfigValues.push(...valuesToAdd)
    
    return Promise.all([
        configManager.updateConfig(valuesToAdd),
	    config.update(key, cleanedConfigValues, false)
    ])
}

