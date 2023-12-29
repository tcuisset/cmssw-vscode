import * as vscode from "vscode";
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'

/**
 * Returns true if the exception is ENOENT (file not found), false in all other cases
 * @param exception 
 */
export function isENOENT(exception:any) :boolean {
    return (exception instanceof vscode.FileSystemError && exception.code == "FileNotFound") 
        //|| (exception instanceof Error && "code" in exception && exception.code == "FileNotFound") 
}

export async function checkDirectoryExists(uri:vscode.Uri):Promise<boolean> {
    try {
        return (await vscode.workspace.fs.stat(uri)).type == vscode.FileType.Directory
    } catch (e) {
        if (isENOENT(e))
            return false
        throw e;
    }
}

/**
 * CmsRelease  but for serialization
 */
//interface RawCmsRelease {rootFolderRaw:string, scram_arch:string, cmssw_release:string}

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

    /**
     * Returns path to CMSSW release on CVMFS (ex: /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/)
     */
    cvmfsPath():string {
        return path.join("/cvmfs/cms.cern.ch/", this.scram_arch, "cms", "cmssw", this.cmssw_release)
    }

    /**
     * When CmsRelease object is stored into workspaceState, it is converted to JSON and all methods are lost (including the Uri)
     * So when reading back from workspaceState we may need to revive the object. FOr some reason, sometimes when reading back from workspaceState
     * the object is already alive.
     */
    static revive(obj:CmsRelease|any):CmsRelease {
        if ("cvmfsPath" in obj)
            return obj
        else
            return new CmsRelease(vscode.Uri.file(obj.rootFolder.path), obj.scram_arch, obj.cmssw_release)
    }
}


export async function findCmsswReleases() : Promise<CmsRelease[]> {
	const releasesPaths = await vscode.workspace.findFiles('**/.SCRAM/Environment', null,  10);
	let res:CmsRelease[] = Array();
	for (var releasePath of releasesPaths) {
		const rootFolder = releasePath.with({path: path.dirname(path.dirname(releasePath.path))}) // Go up twice in directory chain
		const entriesInDotScram = await vscode.workspace.fs.readDirectory(releasePath.with({path: path.dirname(releasePath.path)}))
		let scram_arch:string|null = null
		for (var [entryInDotScram_path, entryInDotScram_fileType] of entriesInDotScram) {
			if (entryInDotScram_fileType == vscode.FileType.Directory) {
				scram_arch = entryInDotScram_path
				break;
			}
		}
		if (scram_arch != null) {
			const scramEnvironmentFileContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(releasePath));
			const matchResult = scramEnvironmentFileContent.match(/SCRAM_PROJECTVERSION=([a-zA-Z0-9_]{1,})/);
			if (matchResult == null) {
				console.log("Could not find SCRAM_PROJECTVERSION in " + releasePath.path);
				break;
			}
			res.push(new CmsRelease(rootFolder, scram_arch, matchResult[1]))
		} else {
			console.log("Could not find SCRAM_ARCH for CMSSW release in " + releasePath.path)
		}	
	}
	return res;
}

export interface ReleaseChangeEvent {
	//oldRelease:CmsRelease
	newRelease:CmsRelease|undefined
}
export let onReleaseChange = new vscode.EventEmitter<ReleaseChangeEvent>()


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

let workspaceStorage:vscode.Memento|undefined = undefined
export function setWorkspaceStorage(st:vscode.Memento|undefined) {
    workspaceStorage = st
}
export async function setCurrentRelease(release:CmsRelease|undefined) {
    if (workspaceStorage === undefined)
        throw new Error("Trying to set current CMSSW release whilst extension is not properly initialized")
	await workspaceStorage.update("currentRelease", release)
	onReleaseChange.fire({newRelease:release})
}

export function getCurrentRelease():CmsRelease|undefined {
    try {
        const rawRelease = workspaceStorage?.get<CmsRelease>("currentRelease")
        if (rawRelease == undefined)
            return undefined
        try {
            return CmsRelease.revive(rawRelease)
        } catch (e) {
            console.log("Could not revive CMSSW release from workspaceStorage (probably due to extension update). Will reset storage. Stored release was :")
            console.log(rawRelease)
            console.log("Exception whilst reviving was :")
            console.log(e)
            setCurrentRelease(undefined);
        }   
    } catch (e) {
        console.log("EROR : Could not access workspaceStorage to get CMSSW release due to : ")
        console.log(e)
    }
    return undefined
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

/**
 * For a given vscode config key of type list (for ex python.analysis.include), stores in extension storage the values added to teh config by the extension
 * in order to separate user-added values and extension-added values
 */
export class ConfigManager {
    /** List of values that were set by the extension */
    _values:string[]
    /** worokspaceStorage (extension local storage) */
    _store:vscode.Memento
    /** Name of config key, to be used as key in extension local storage */
    key:string

    constructor(key:string, store:vscode.Memento) {
        this._values = store.get(key, Array<string>())
        this._store = store
        this.key = key
    }
    /** Replace the stored values with the given ones */
    updateConfig(newVals:string[]):Thenable<void> {
        return this._store.update(this.key, newVals)
    }
}

/**
 * Removes from array the values that are in valsToRemove
 * @param array 
 * @param valsToRemove 
 * @returns 
 */
function removeFromArray(array:string[], valsToRemove:string[]) {
    let res = Array<string>();
    for (const configVal of array) {
        if (valsToRemove.indexOf(configVal) === -1) {
            res.push(configVal)
        }
    }
    return res
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
export function updateConfigKeepingTrack(config: vscode.WorkspaceConfiguration, key: string, configManager:ConfigManager, valuesToAdd: string[]): Thenable<any> {
	let configValues = config.get<string[]>(key);
	if (configValues === undefined) {
		configValues = new Array<string>();
	}

    // Remove from the wp config the values that were previously added by the extension
    let cleanedConfigValues = removeFromArray(configValues, configManager._values)
    // Also don't add again values that might already be in the config but not managed by us
    // But still register them as added by the extension (not ideal but probably best option)
    cleanedConfigValues.push(...removeFromArray(valuesToAdd, cleanedConfigValues))
    
    return Promise.all([
        configManager.updateConfig(valuesToAdd),
	    config.update(key, cleanedConfigValues, false)
    ])
}



/**
 * List all packages that are currently checked out in the release (ie are in src directory)
 * @param release 
 * @returns 
 */
export async function listCheckedOutPackages(release:CmsRelease):Promise<Package[]> {
	const pathToSrc = vscode.Uri.joinPath(release.rootFolder, "src").fsPath

	const subsystems = await nodeFs.readdir(pathToSrc)
	let packagesPromises = new Array<string>()
	let promisedResults = subsystems.map(async (subsystem) => {
        if (subsystem.startsWith("."))
            return undefined // Remove .git and other things
        try {
            const curPkgs = await nodeFs.readdir(path.join(pathToSrc, subsystem))
            return curPkgs.map(async (pkg):Promise<Package|undefined> => {
                if ((await nodeFs.stat(path.join(pathToSrc, subsystem, pkg))).isDirectory()) {
                    return {subsystem:subsystem, packageName:pkg}
                } else {
                    return undefined
                }
            })
        } catch (e) {
            // In case object "subsystem" is in fact a file (eg .gitignore) then readdir will return ENOENT, just ignore in this case
            if (!(e instanceof Error && "code" in e && e.code != "ENOENT"))
                console.log(e)
            return undefined
        }
	})
	let packages = new Array<Package>()
	for (let subsystemPromise of promisedResults) {
		let subsystemPromiseRes = await subsystemPromise
		if (subsystemPromiseRes !== undefined) {
			for (let pkgPromise of subsystemPromiseRes) {
				let pkgPromiseRes = await pkgPromise
			
				if (pkgPromiseRes !== undefined) {
					packages.push(pkgPromiseRes)
				}
			}
			
		}
	}
	return packages
}


/**  Computes the list of names of externals (withou version) available for given arch
*/
async function getListOfExternalsForArch(scram_arch:string) : Promise<string[]> {
	return nodeFs.readdir(path.join("/cvmfs", "cms.cern.ch", scram_arch, "external"))
}

/**
 * Creates a symlink at linkPath pointing to target. If the link already exists, check that the target is identical.
 * If target is identical, do nothing. If target is different, delete the link and recreate it to the new target
 * @param target 
 * @param linkPath 
 * @throws only in case of unrecoverable error (such as symlink call fail with error != EEXIST, or unlink fail)
 */
export async function makeOrUpdateSymlink(target:string, linkPath:string) {
    try {
        await nodeFs.symlink(target, linkPath);
        console.log("Wrote symlink from " + linkPath + " to " + target);
    } catch (e) {
        // Any further error here is not recoverable so no try block
        if (e instanceof Error && "code" in e && e.code == "EEXIST") {
            // Symlink already exists. Check it is correct
            if (path.resolve(await nodeFs.readlink(linkPath)) === path.resolve(target))
                return
            else {
                // recreate it
                await nodeFs.unlink(linkPath);
                await nodeFs.symlink(target, linkPath);
            }
        } else {
            throw e // Weird error during symlink call
        }
    }
}

/**
 * Create an executable script at given location (creates file and chmod +x)
 * In case the file already exists, will replace its contents
 * @param mkdir create intermediate directories
 */
export async function createExecutableScript(scriptPath:vscode.Uri, content:string, mkdir:boolean=true) {
    if (mkdir)
        await vscode.workspace.fs.createDirectory(scriptPath.with({path:path.dirname(scriptPath.path)}));
    await vscode.workspace.fs.writeFile(scriptPath, new TextEncoder().encode(content))
	// do chmod +x
	let stat = await nodeFs.stat(scriptPath.fsPath)
	let mode = stat.mode & 0xFFFF;
    const x = nodeFs.constants.S_IXUSR | nodeFs.constants.S_IXGRP | nodeFs.constants.S_IXOTH;
    mode |= x;
	await nodeFs.chmod(scriptPath.fsPath, mode)
}
