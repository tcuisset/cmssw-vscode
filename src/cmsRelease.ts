import * as vscode from "vscode";
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'
import * as utils from './utils'

// cfi python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/cfipython/$SCRAM_ARCH/Pkg/SubPjg/thing_cfi.py
// python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/python/thing.py
// C++ located at // python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/(include|src|plugins)/(thing.h|cpp)
// TODO patch release
export class Package {
	subsystem: string;
	packageName: string;

	constructor(str: string) {
		const splitStr = str.split('/');
		if (splitStr.length !== 2)
			throw Error("Could not parse " + str + " as CMSSW package (should be of form Pkg/SubPkg)");
		this.subsystem = splitStr[0];
		this.packageName = splitStr[1];
	}
}


export class CmsReleaseBase {
    /** value of $SCRAM_ARCH  */
	scram_arch:string;
    /** scram version of release, ie CMSSW_14_0_0_pre1 */
	cmssw_release:string;

    constructor(scram_arch:string, cmssw_release:string) {
        this.scram_arch = scram_arch
        this.cmssw_release = cmssw_release
    }

    /**
     * Returns path to CMSSW release on CVMFS (ex: /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/)
     */
    cvmfsPath():string {
        return path.join("/cvmfs/cms.cern.ch/", this.scram_arch, "cms", "cmssw", this.cmssw_release)
    }
}

/**
 * A handle on a CMSSW release folder
 */
export class CmsRelease extends CmsReleaseBase {
    /** Path to root folder of release, holding src, bin, etc folders */
	rootFolder:vscode.Uri;

    constructor(rootFolder:vscode.Uri, scram_arch:string, cmssw_release:string) {
        super(scram_arch, cmssw_release)
        this.rootFolder = rootFolder
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

    /** Creates a CmsRelease from the uri of the root folder */
    static async fromBaseUri(releasePath:vscode.Uri):Promise<CmsRelease> {
        const entriesInDotScram = await vscode.workspace.fs.readDirectory(releasePath.with({path: releasePath.path + "/.SCRAM"}))
		let scram_arch:string|null = null
		for (var [entryInDotScram_path, entryInDotScram_fileType] of entriesInDotScram) {
			if (entryInDotScram_fileType === vscode.FileType.Directory) {
				scram_arch = entryInDotScram_path
				break;
			}
		}
		if (scram_arch !== null) {
			const scramEnvironmentFileContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(releasePath.with({path: releasePath.path + "/.SCRAM/Environment"})));
			const matchResult = scramEnvironmentFileContent.match(/SCRAM_PROJECTVERSION=([a-zA-Z0-9_]{1,})/);
			if (matchResult !== null) {
                return new CmsRelease(releasePath, scram_arch, matchResult[1])
			} else
                throw new Error("Could not find SCRAM_PROJECTVERSION in " + releasePath.path)
		}
        throw new Error ("Could not find SCRAM_ARCH for CMSSW release in " + releasePath.path)
    }

    /** Creates a CmsRelease from the uri of any file inside the release */
    static async fromAnyUriInRelease(uri:vscode.Uri):Promise<CmsRelease|CmsReleaseBase> {
        const splitPath = uri.fsPath.split(path.sep)
        // Note that splitPath[0] is empty due to the leading slash
        if (splitPath[1] === "cvmfs") {
            // Path on CVMFS : example /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/
            // uri.with({path:uri.path.split("/").slice(undefined, 6).join("/")}), 
            if (splitPath[2] === "cms.cern.ch" && splitPath[4] === "cms" && splitPath[5] === "cmssw" && splitPath[6] !== undefined)
                return new CmsReleaseBase(splitPath[3], splitPath[6])
        } else {
            // Local path : walk up directories trying to find .SCRAM folder
            let promises:Promise<string|undefined>[] = []
            let parentsPath = uri.path
            while (path.dirname(parentsPath) !== parentsPath) {
                promises.push((async (parentsPathLocal:string) => {
                    if ((await vscode.workspace.fs.stat(uri.with({path:parentsPathLocal+"/.SCRAM"}))).type === vscode.FileType.Directory)
                        return parentsPathLocal
                    else
                        throw new Error()
                })(parentsPath).catch((e)=>undefined)) // Avoid rejected promise errors
                parentsPath = path.dirname(parentsPath)
            }
            for (let promise of promises) {
                let path = await promise
                if (path !== undefined)
                    return CmsRelease.fromBaseUri(uri.with({path:path}))
            }
        }
        throw new Error("Could not find CMSSW release for file : " + uri.toString())
    }
}

/** Map a CmsReleaseBase (ie just release name + scram_arch) to an actual cmssw working area in the workspace */
export async function resolveBaseRelease(base:CmsReleaseBase):Promise<CmsRelease> {
    if (base instanceof CmsRelease)
        return base
    if (cmsswReleaseCache.length === 0)
        await findCmsswReleases() // Populate the cache
    for (const release of cmsswReleaseCache) {
        if (release.cmssw_release === base.cmssw_release)
            return release
    }
    throw new Error("Could not resolve cvmfs release " + base + " to a local release")
}

let cmsswReleaseCache:CmsRelease[] = []
export async function findCmsswReleases() : Promise<CmsRelease[]> {
	const releasesPaths = await vscode.workspace.findFiles('**/.SCRAM/Environment', null,  10);
	let res:CmsRelease[] = Array();
	for (var releasePath of releasesPaths) {
		const rootFolder = releasePath.with({path: path.dirname(path.dirname(releasePath.path))}) // Go up twice in directory chain
        try {
            res.push(await CmsRelease.fromBaseUri(rootFolder))
        } catch (e) {
            console.log("Could not resolve CMSSW release for folder " + rootFolder.toString())
        }
	}
    cmsswReleaseCache = res
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
let globalStorage:vscode.Memento|undefined = undefined;
export function setGlobalStorage(st:vscode.Memento|undefined) {
    globalStorage = st
}
export async function setCurrentRelease(release:CmsRelease|undefined) {
    if (workspaceStorage === undefined)
        throw new Error("Trying to set current CMSSW release whilst extension is not properly initialized")
	await workspaceStorage.update("currentRelease", release)
	onReleaseChange.fire({newRelease:release})
}

/**
 * Retrives the currently selected CmsRelease
 * @returns the selected release, or undefined in case none are selected
 * @throws Error in case we could not determine the current release
 */
export function getCurrentRelease():CmsRelease|undefined {
    try {
        const rawRelease = workspaceStorage?.get<CmsRelease>("currentRelease")
        if (rawRelease === undefined)
            return undefined
        try {
            return CmsRelease.revive(rawRelease)
        } catch (e) {
            utils.logToOC("Could not revive CMSSW release from workspaceStorage (probably due to extension update). Will reset storage. Stored release was :")
            utils.logToOC(rawRelease)
            utils.logToOC("Exception whilst reviving was :")
            utils.logToOC(e)
            setCurrentRelease(undefined);
        }   
    } catch (e) {
        throw new Error("Could not access workspaceStorage to get CMSSW release", {cause:e})
    }
    return undefined
}






/**
 * List all packages that are contained in folder (ie cd to folder, and glob subSystem/pkg)
 * .folders are ignored
 * @param folder 
 */
async function findPackagesInFolder(folder:string):Promise<Package[]> {
    const subsystems = await nodeFs.readdir(folder)
	// List of promises for each subsystem, holding an array of promises of packages
	let promisedResults = subsystems.map(async (subsystem) => {
        if (subsystem.startsWith("."))
            return undefined // Remove .git and other things
        try {
            const curPkgs = await nodeFs.readdir(path.join(folder, subsystem))
            return curPkgs.map(async (pkg):Promise<Package|undefined> => {
                if ((await nodeFs.stat(path.join(folder, subsystem, pkg))).isDirectory()) {
                    return {subsystem:subsystem, packageName:pkg}
                } else {
                    return undefined
                }
            })
        } catch (e) {
            // In case object "subsystem" is in fact a file (eg .gitignore) then readdir will return ENOENT, just ignore in this case
            if (!(e instanceof Error && "code" in e && e.code !== "ENOENT"))
                console.log(e)
            return undefined
        }
	})
    // Now flatten and await all promises
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

/**
 * List all packages that are currently checked out in the release (ie are in src directory)
 */
export async function listCheckedOutPackages(release:CmsRelease):Promise<Package[]> {
	return findPackagesInFolder(vscode.Uri.joinPath(release.rootFolder, "src").fsPath)
}

/**
 * Finds all packages for the current release that are on cvmfs
 */
export async function listPackagesOnCvmfs(release:CmsRelease) : Promise<Package[]> {
    return findPackagesInFolder(release.cvmfsPath())
}


/**
 * List all packages for the release that are on cvmfs, using global extension cache
 */
export async function listPackagesOnCvmfsFromCache(release:CmsRelease):Promise<Package[]> {
    const cacheKey = "cvmfs-packages"
    type CvmfsPackageStore = { [cmssw_release:string]:Package[] }
    let cachedStore:CvmfsPackageStore|undefined;
    if (globalStorage !== undefined) {
        cachedStore = globalStorage.get<CvmfsPackageStore>(cacheKey)
        if (cachedStore !== undefined && cachedStore[release.cmssw_release] !== undefined)
            return cachedStore[release.cmssw_release]
    }
    let computedValue = await listPackagesOnCvmfs(release)
    if (globalStorage !== undefined) {
        if (cachedStore === undefined)
            cachedStore = {};
        cachedStore[release.cmssw_release] = computedValue
        globalStorage.update(cacheKey, cachedStore)
    }
    return computedValue
}


/**  Computes the list of names of externals (withou version) available for given arch
*/
async function getListOfExternalsForArch(scram_arch:string) : Promise<string[]> {
	return nodeFs.readdir(path.join("/cvmfs", "cms.cern.ch", scram_arch, "external"))
}


