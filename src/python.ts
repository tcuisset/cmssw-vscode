import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'
import { promisify } from 'node:util';
import { PythonExtension, VersionInfo, ResolvedVersionInfo } from '@vscode/python-extension';
import * as cp from 'node:child_process'

import { CmsRelease, workspaceFolderForRelease, Package, listCheckedOutPackages, getCurrentRelease } from './cmsRelease';
import { ConfigManager } from "./utils";
import { updateConfigKeepingTrack } from "./utils";
import * as com from './cmsRelease'
import * as utils from "./utils";

enum CmsFileType {
    RegularPython, // cff or regular .py
    CfiPython, // cfi file (located in cfipython)
    Cpp,
}

/**
 * Target of symbolic link of python package
 */
enum LinkTarget {
    Local, // To local release (package is checked out)
    CVMFS // To CVMFS (in case package is not checked out)
}

/*
function pythonPkgsToIndexFromConfig() : Package[] {
	return vscode.workspace.getConfiguration('cmssw').get('pythonPackagesToIndex', []).map((modStr) => new Package(modStr))
}*/

/**
 * Path to the python symlink folder for given release (for python or cfipython)
 * @param release 
 * @param fileType 
 * @param mkdir if true, will create the dir if it does not exist. if false, it will return the path but the dir may not exist
 * @returns 
 */
async function getPythonSymlinkTreeFolder(release:CmsRelease, fileType:CmsFileType, mkdir=true)  : Promise<vscode.Uri>  {
	let folderName = "";
	if (fileType === CmsFileType.RegularPython) {
		folderName = "python";
	} else if (fileType === CmsFileType.CfiPython) {
		folderName = "cfipython";
	} else
		throw Error("Not supported yet")
    try {
		let pySymlinkTreeBasePath = vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", folderName);
		if (mkdir) {
			try {
				// Does not raise even when directory already exists
				await vscode.workspace.fs.createDirectory(pySymlinkTreeBasePath);
			} catch (e) {
				console.log(e)
				throw Error("Could not create python symlink tree directory at path " + pySymlinkTreeBasePath.toString())
			}
		}
		return pySymlinkTreeBasePath;
    } catch (e) {
        console.log(e)
        throw e
    }

}

/**
 * Build a symbolic link for PYthon
 * @param release 
 * @param symlinkTreeBase vscode Uri to the base folder of python symlinks in the release
 * @param pkg the package to create a symlink for
 * @param linkTargetType link target to local release or to CVMFS
 */
async function buildSinglePythonSymlink(release:CmsRelease, symlinkTreeBase:vscode.Uri, pkg:Package, linkTargetType:LinkTarget) {
    // Create link directory
    const linkPathBase = path.join(symlinkTreeBase.fsPath, pkg.subsystem);
    const linkPath = path.join(linkPathBase, pkg.packageName)
    try {
        await nodeFs.mkdir(linkPathBase, {recursive:true});
    } catch (e) {
        if (!utils.isENOENT(e)) {
            console.log("Could not create folder " + linkPathBase + " due to ");
            console.log(e);
            throw e;
        }
        // folder already exists : not a problem normally
    }
    let target:string;
    // Create link itself
    if (linkTargetType === LinkTarget.Local) {
        target = vscode.Uri.joinPath(release.rootFolder, "src", pkg.subsystem, pkg.packageName, "python").fsPath
    } else if (linkTargetType === LinkTarget.CVMFS) {
        // python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/python/thing.py
        target = path.join(release.cvmfsPath(), "src", pkg.subsystem, pkg.packageName, "python")
    } else {
        throw new Error("Unkwown link target type")
    }
    
	// Making the symlink
	let makeSymlinkFct = async () => {
		try {
			await utils.makeOrUpdateSymlink(target, linkPath)
			console.log("Wrote symlink from " + linkPath + " to " + target);
		} catch (e) {
			console.log("Could not create symlink from " + linkPath + " to " + target + " due to ");
			console.log(e);
			throw Error("Could not create symlink from " + linkPath + " to " + target + " due to " + e?.toString())
		}
	}
	// Creating an __init__.py file so pylance will think it's a package 
	let makeInitFct = async () => {
		let initFileHandle;
		try {
			// Todo check if file already exists
			initFileHandle = await nodeFs.open(path.join(linkPathBase, "__init__.py"), "w")
		}  finally {
			await initFileHandle?.close()
		}
	}

	await Promise.all([makeSymlinkFct(), makeInitFct()])
}

/**
 * Build in the local release in .vscode-cmssw, a tree of symlinks to directories of python files, so that Pylance can work properly
 * Looks for packages currently checked out and map them either to local, the other requested ones to CVMFS
 * @param release 
 */
export async function buildPythonSymlinkTree(release:CmsRelease) : Promise<void> {
	const symlinkTreeBase = await getPythonSymlinkTreeFolder(release, CmsFileType.RegularPython);

    const localPkgs = new Set(await listCheckedOutPackages(release))
    //let cvmfsPkgs = pythonPkgsToIndexFromConfig()
	let cvmfsPkgs = await com.listPackagesOnCvmfsFromCache(release)
    cvmfsPkgs = cvmfsPkgs.filter( x => !localPkgs.has(x) ); // remove from cvmfs pkgs those that are locally checked out

    const promisesRes = [...localPkgs].map((pkg:Package) => buildSinglePythonSymlink(release, symlinkTreeBase, pkg, LinkTarget.Local))
    promisesRes.push(...cvmfsPkgs.map((pkg:Package) => buildSinglePythonSymlink(release, symlinkTreeBase, pkg, LinkTarget.CVMFS)))
    await Promise.allSettled(promisesRes)
}

export async function makeCfiPythonSymlink(release:CmsRelease) : Promise<void> {
	const symlinkTreeBase = await getPythonSymlinkTreeFolder(release, CmsFileType.CfiPython, false);
	// cfi python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/cfipython/$SCRAM_ARCH/Pkg/SubPjg/thing_cfi.py
	const target = path.join(release.cvmfsPath(), "cfipython", release.scram_arch)
	await utils.makeOrUpdateSymlink(target, symlinkTreeBase.fsPath)
}




interface CmsPythonExternal {
	name:string
	path:string ///< Path to the site-packages folder of the python external
}

/**
 * Finds the location of the site-packages for each python external
 * @param release 
 * @param pythonVersion can be "python3.9" for example. Needed to locate externals dir
 * @returns 
 */
async function getPythonExternalsForRelease(release:CmsRelease, pythonVersion:string):Promise<CmsPythonExternal[]> {
	const scramToolResAll = (await promisify(cp.exec)('cmsenv && scram tool list ', {cwd: release.rootFolder.fsPath}));
	const scramToolRes = scramToolResAll.stdout
	// https://regex101.com/r/WNQA21/1
	const re = /^[ \t]{0,}(py3-[a-zA-Z0-9_-]{1,})[ \t]{1,}([0-9\.a-zA-Z_-]{1,})$/gm
	let externals = new Array<CmsPythonExternal>();
	for (const match of scramToolRes.matchAll(re)) {
		// /cvmfs/cms.cern.ch/el8_amd64_gcc12/external/py3-mplhep/0.3.26-7d223e0f2896ae13fa0f51c21ced3c06/lib/python3.9/site-packages
		const name = match[1]
		const version = match[2]
		const pathToPyExternal = path.join("/cvmfs/cms.cern.ch/", release.scram_arch, "external", name, version, "lib", pythonVersion, "site-packages")
		externals.push({name: match[1], path:pathToPyExternal})
	}
	return externals
}

function pathToScramVenv(release:CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, "venv", release.scram_arch)
}

/** list of paths of files that were created for python by the CMSSW extension (to be used on cleanup). Does not include any file in .vscode-cmssw */
export function pathsToDeleteOnCleanupRelease(release:CmsRelease) {
	return [vscode.Uri.joinPath(pathToScramVenv(release), "bin", "python3_cmsenv")]
}

/**
 * Uses the python extension API to resolve the scram venv virtual environment
 * @param release 
 * @returns whatever pythonApi.environments.resolveEnvironment returns (ResolvedEnvironment|undefined)
 * @throws in case venv was not yet created for release
 */
async function resolvePythonEnvironment(release:CmsRelease) {
	const pathToVenv = pathToScramVenv(release)
	const pathToPython = vscode.Uri.joinPath(pathToVenv, "bin", "python3_cmsenv")
	try {
		await vscode.workspace.fs.stat(pathToPython); // to check if venv folder exists and the python3_cmsenv script exists
		const pythonApi: PythonExtension = await PythonExtension.api();
		return pythonApi.environments.resolveEnvironment({id:release.cmssw_release, path: pathToPython.fsPath})
	} catch (e) {
		if (e instanceof vscode.FileSystemError && e.code === "ENOENT") {
			throw Error("Python venv for CMSSW release " + release.toString() + " does not exist yet. You should create it first.")
		}
		throw e
	}
}

function parsePythonVersionToCmssw(versionInfo:(VersionInfo & { readonly sysVersion: string | undefined; } & ResolvedVersionInfo) | undefined): string {
	if (versionInfo?.major !== undefined && versionInfo.minor !== undefined) {
		return "python" + versionInfo.major + "." + versionInfo.minor
	} else {
		throw Error("Could not find python version in " + versionInfo?.toString())
	}
}

/**  Update config of current workspace to point python extension include path to correct locations
 * @param keepExternals list of externals to keep in include path (otherwise too many are included and it slows down everything) (for now does not work, all externals are included)
 */
export async function updatePythonConfig(release:CmsRelease, store:vscode.Memento, keepExternals:string[]=[]) : Promise<any> {
	const pythonEnvironment = resolvePythonEnvironment(release) // Needed to show the environment in the list of python envs for notebooks/python files

	let pythonConfig = vscode.workspace.getConfiguration("python.analysis", workspaceFolderForRelease(release)) // python.analysis.include
	const prefix = vscode.workspace.asRelativePath(release.rootFolder, false) + "/"
	
	let promises:Thenable<any>[] = []
	//promises.push(updateConfigKeepingTrack(pythonConfig, "include", new ConfigManager("workspaceConfig.python.analysis.include", store),
	//	[prefix + ".vscode-cmssw/python", prefix+"cfipython", prefix + ".vscode-cmssw/cfipython"]))
	
	// "CMSSW_14_0_0_pre1/.vscode-cmssw/cfipython",
    //     "CMSSW_14_0_0_pre1/.vscode-cmssw/python"
	promises.push(updateConfigKeepingTrack(pythonConfig, "extraPaths", new ConfigManager("workspaceConfig.python.analysis.extraPaths", store),
		[prefix + ".vscode-cmssw/cfipython", prefix + ".vscode-cmssw/python"]))
	
	promises.push(updateConfigKeepingTrack(pythonConfig, "exclude", new ConfigManager("workspaceConfig.python.analysis.exclude", store),
		[prefix + ".vscode-cmssw", prefix + "cfipython"]))

	// Temporary : 
	promises.push(pythonEnvironment)

	return Promise.allSettled(promises)
}

// Old code for external exclude (does not work due to pylance ignoring it)
	/*
	
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/python
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/lib/el8_amd64_gcc12
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/coral/CORAL_2_3_21-28dabfc38a6bf00dd35728bb54daa6e2/el8_amd64_gcc12/python
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/coral/CORAL_2_3_21-28dabfc38a6bf00dd35728bb54daa6e2/el8_amd64_gcc12/lib
	
	const cvmfsPrefix = path.join("/cvmfs", "cms.cern.ch", release.scram_arch)
	// Prevent access of python packages on CVMFS as they use __init__ magic that does not work with pylance
	// We want to use our symlink tree instead, so exclude the paths
	let excludePaths = [
		path.join(release.cvmfsPath(), "python"),
		path.join(release.cvmfsPath(), "lib", release.scram_arch),
		path.join(cvmfsPrefix, "cms", "coral", "*", release.scram_arch, "python"),
		path.join(cvmfsPrefix, "cms", "coral", "*", release.scram_arch, "lib", release.scram_arch),
	]

	const pythonVersion = (await pythonEnvironment)?.version
	if (pythonVersion == undefined) {
		throw Error("Could not determine the python version. Environment is " +(await pythonEnvironment)?.toString())
	}
	
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/external/py3-tensorflow/2.12.0-b1d544bcde4b10a0c0da88f060f65dc9/lib/python3.9/site-packages
	for (let external of await getPythonExternalsForRelease(release, parsePythonVersionToCmssw(pythonVersion))) {
		if (keepExternals.indexOf(external.name) == -1) {
			excludePaths.push(external.path)
		}
	}
	promises.push(updateConfigKeepingTrack(pythonConfig, "exclude", new ConfigManager("workspaceConfig.python.analysis.exclude", store), excludePaths)) 
	*/


/**
 * Run scram-venv if needed, then make a python executable that runs cmsenv then python
 * @todo this needs to be recreated whenever the aboslute path to CMSSW release changes (ie renaming/moving folders)
 * @param release 
 * @param forceRecreate 
 * @returns 
 */
export async function makeVirtualEnvironment(release:CmsRelease, forceRecreate:boolean=false):Promise<void> { 
	// CMSSW_14_0_0_pre1/venv/el8_amd64_gcc12/bin/python3_cmsenv
	const pathToPythonCmsenv = vscode.Uri.joinPath(pathToScramVenv(release), "bin", "python3_cmsenv")

	try {
		await vscode.workspace.fs.stat(pathToScramVenv(release))
	} catch {
		await promisify(cp.exec)('cmsenv && scram-venv', {cwd: release.rootFolder.fsPath});
	}

	try {
		await vscode.workspace.fs.stat(pathToPythonCmsenv)
		if (!forceRecreate)
			return;
	} catch {}
	
	await utils.createExecutableScript(pathToPythonCmsenv, 
		"#!/bin/bash\n" + 
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec "$LOCALRT/venv/$SCRAM_ARCH/bin/python3" "$@"\n'
	)
}

/**
 * Add to python config so that the virtual environment from scram if found. Does not work for now as python.venvFolders does not exist at workspace level
 * @param release 
 */
/*
async function addScramVenvToSettings(release:CmsRelease) {
	let pythonConfig = vscode.workspace.getConfiguration("python", workspaceFolderForRelease(release)) // python.analysis.include
	const configKey = "venvFolders"
	let pythonConfigVenvFolders = pythonConfig.get<string[]>(configKey)
	if (pythonConfigVenvFolders === undefined) {
		pythonConfigVenvFolders = new Array<string>()
	}
	const pathToAdd = path.join("${workspaceFolder}", vscode.workspace.asRelativePath(release.rootFolder, false), "venv", release.scram_arch) 
	if (pythonConfigVenvFolders.indexOf(pathToAdd) === -1) {
		pythonConfigVenvFolders.push(pathToAdd)
		await pythonConfig.update(configKey, pythonConfigVenvFolders, false)
	}
}*/



/**
 * Ensures all the steup for python is already done (scram venv, etc)
 * @param release 
 * @returns true if python is fully setup, false if some setup is missing
 * @throws in case something is wrong in the config (should probably clear everything in this case)
 */
export async function isPythonFullySetup(release:CmsRelease):Promise<boolean> {
	let checkScramVenv = async () => {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(pathToScramVenv(release), "bin", "python3_cmsenv"))
			return true;
		} catch (e) {
			if (utils.isENOENT(e))
				return false;
			throw e;
		}
	}

	let checkPythonConfig = async () => {
		let pythonConfig = vscode.workspace.getConfiguration("python.analysis", workspaceFolderForRelease(release)) // python.analysis.include

		// CHeck that all values given are in the settings config key
		let checkValuesAreInConfig = (key:string, values:string[]):boolean => {
			const configValsInSettings = pythonConfig.get<string[]>(key)
			if (configValsInSettings === undefined)
				return false;
			for (const configVal of values) {
				if (configValsInSettings.indexOf(configVal) === -1)
					return false;
			}
			return true;
		}

		const prefix = vscode.workspace.asRelativePath(release.rootFolder, false) + "/"
		return checkValuesAreInConfig("extraPaths", [prefix + ".vscode-cmssw/cfipython", prefix + ".vscode-cmssw/python"]) 
			&& checkValuesAreInConfig("exclude", [prefix + ".vscode-cmssw", prefix+"cfipython"]) 
	}

	let checkSymlinkFolders = async () => {
		let promises = [getPythonSymlinkTreeFolder(release, CmsFileType.RegularPython, false), 
			getPythonSymlinkTreeFolder(release, CmsFileType.CfiPython, false)].map(async (folder) => {
			try {
				const statRes = (await vscode.workspace.fs.stat(await folder)).type
				// RegularPython will be Directory, CfiPython will be SymbolicLink to a directory
				if (statRes === vscode.FileType.Directory || statRes === (vscode.FileType.Directory | vscode.FileType.SymbolicLink))
					return true;
				throw Error("Symlink folder " + (await folder).toString() + " should be a directory or non-existent.")
			} catch (e) {
				if (utils.isENOENT(e))
					return false;
				throw Error("Unkwnown error when checking for symlink folder " + e?.toString())
			}
		});
		return (await Promise.all(promises)).every(Boolean)
	}
	
	let res = await Promise.all([checkScramVenv(), checkPythonConfig(), checkSymlinkFolders()])
	console.log("isPythonFullySetup result")
	console.log(res)
	return (res[0] && res[1] && res[2])
}
