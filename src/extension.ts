// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
//import * as cmsFs from './fsProvider'
import * as nodeFs from 'node:fs/promises'
import * as path from 'path';
import * as cp from 'node:child_process'
import { promisify } from 'node:util';
import { PythonExtension, VersionInfo, ResolvedVersionInfo } from '@vscode/python-extension';

import { CmsRelease, workspaceFolderForRelease, Package, ConfigManager, updateConfigKeepingTrack, userFriendlyReleaseLocation } from './common';

enum CmsFileType {
    RegularPython, // cff or regular .py
    CfiPython, // cfi file (located in cfipython)
    Cpp,
}

// function getSymlinkTreeFolder(release:CmsRelease) /* : Thenable<vscode.Uri> */ {
// 	return vscode.workspace.fs.stat(vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "python")).then((pyFolder) => {// success
// 		console.log(pyFolder);
// 	}, (reason) => {// not found
// 		if (reason == "EntryNotADirectory")
// 	})
// }

interface ReleaseChangeEvent {
	//oldRelease:CmsRelease
	newRelease:CmsRelease|undefined
}
let onReleaseChange = new vscode.EventEmitter<ReleaseChangeEvent>()


async function findCmsswReleases() : Promise<CmsRelease[]> {
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
			res.push({rootFolder : rootFolder, scram_arch : scram_arch, cmssw_release: matchResult[1]})
		} else {
			console.log("Could not find SCRAM_ARCH for CMSSW release in " + releasePath.path)
		}	
	}
	return res;
}

function getCurrentRelease(storage:vscode.Memento):CmsRelease|undefined {
	return storage.get<CmsRelease>("currentRelease")
}

async function setCurrentRelease(storage:vscode.Memento, release:CmsRelease|undefined) {
	await storage.update("currentRelease", release)
	onReleaseChange.fire({newRelease:release})
}



async function getPythonSymlinkTreeFolder(release:CmsRelease, fileType:CmsFileType, mkdir=true)  : Promise<vscode.Uri>  {
	let folderName = "";
	if (fileType == CmsFileType.RegularPython) {
		folderName = "python";
	} else if (fileType == CmsFileType.CfiPython) {
		folderName = "cfipython";
	} else
		throw Error("Not supported yet")
	let pySymlinkTreeBasePath = vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", folderName);
	if (mkdir)
		await vscode.workspace.fs.createDirectory(pySymlinkTreeBasePath);
	return pySymlinkTreeBasePath;
}

/**
 * List all packages that are currently checked out in the release (ie are in src directory)
 * @param release 
 * @returns 
 */
async function listCheckedOutPackages(release:CmsRelease):Promise<Package[]> {
	const pathToSrc = vscode.Uri.joinPath(release.rootFolder, "src").fsPath

	const subsystems = await nodeFs.readdir(pathToSrc)
	let packagesPromises = new Array<string>()
	let promisedResults = subsystems.map(async (subsystem) => {
		if ((await nodeFs.stat(subsystem)).isDirectory()) {
			const curPkgs = await nodeFs.readdir(path.join(pathToSrc, subsystem))
			return curPkgs.map(async (pkg):Promise<Package|undefined> => {
				if ((await nodeFs.stat(path.join(pathToSrc, subsystem, pkg))).isDirectory()) {
					return {subsystem:subsystem, packageName:pkg}
				} else {
					return undefined
				}
			})
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

function pySymlinks(release:CmsRelease) {

}

async function buildPythonSymlinkTree(release:CmsRelease, modules:Package[]) : Promise<any> { // Only for Python
	const symlinkTreeBase = await getPythonSymlinkTreeFolder(release, CmsFileType.RegularPython);

	return Promise.allSettled(modules.map(async (module:Package) => {
		const linkPathBase = path.join(symlinkTreeBase.fsPath, module.subsystem);
		const linkPath = path.join(linkPathBase, module.packageName)
		try {
			await nodeFs.mkdir(linkPathBase, {recursive:true});
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code == "EEXIST")) {
				console.log("Could not create folder " + linkPathBase + " due to ");
				console.log(e);
				throw e;
			}
			// folder already exists : not a problem normally
			
		}
		// python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/python/thing.py
		const target = path.join("/cvmfs/cms.cern.ch/", release.scram_arch, "cms", "cmssw", release.cmssw_release, "src", module.subsystem, module.packageName, "python")
		try {
			await nodeFs.symlink(target, linkPath);
			console.log("Wrote symlink from " + linkPath + " to " + target);
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code == "EEXIST")) {
				console.log("Could not create symlink from " + linkPath + " to " + target + " due to ");
				console.log(e);
				throw e;
			}
			// symlink already exists
		}
	}))
}

async function makeCfiPythonSymlink(release:CmsRelease) : Promise<void> {
	const symlinkTreeBase = await getPythonSymlinkTreeFolder(release, CmsFileType.CfiPython, false);
	// cfi python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/cfipython/$SCRAM_ARCH/Pkg/SubPjg/thing_cfi.py
	const target = path.join("/cvmfs/cms.cern.ch/", release.scram_arch, "cms", "cmssw", release.cmssw_release, "cfipython", release.scram_arch)
	await nodeFs.symlink(target, symlinkTreeBase.fsPath);
}

function pythonPkgsToIndexFromConfig() : Package[] {
	return vscode.workspace.getConfiguration('cmssw').get('pythonPackagesToIndex', []).map((modStr) => new Package(modStr))
}

/**  Computes the list of names of externals (withou version) available for given arch
*/
async function getListOfExternalsForArch(scram_arch:string) : Promise<string[]> {
	return nodeFs.readdir(path.join("/cvmfs", "cms.cern.ch", scram_arch, "external"))
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

async function getPythonVersion(release:CmsRelease) {
	const pythonApi: PythonExtension = await PythonExtension.api();
	return (await pythonApi.environments.resolveEnvironment({id:release.cmssw_release, path: pathToScramVenv(release).fsPath}))?.version;
}
function parsePythonVersionToCmssw(versionInfo:(VersionInfo & { readonly sysVersion: string | undefined; } & ResolvedVersionInfo) | undefined): string {
	if (versionInfo?.major !== undefined && versionInfo.minor !== undefined) {
		return "python" + versionInfo.major + "." + versionInfo.minor
	} else {
		throw Error("Could not find python version")
	}
}

/**  Update config of current workspace to point python extension include path to correct locations
@param keepExternals list of externals to keep in include path (otherwise too many are included and it slows down everything)
*/
async function updatePythonConfig(release:CmsRelease, store:vscode.Memento, keepExternals:string[]=[]) : Promise<any> {
	const pythonVersion = getPythonVersion(release)

	let pythonConfig = vscode.workspace.getConfiguration("python.analysis", workspaceFolderForRelease(release)) // python.analysis.include
	const prefix = vscode.workspace.asRelativePath(release.rootFolder, false) + "/"
	
	let promises:Thenable<any>[] = []
	promises.push(updateConfigKeepingTrack(pythonConfig, "include", new ConfigManager("workspaceConfig.python.analysis.include", store),
		[prefix + ".vscode-cmssw/python", prefix + ".vscode-cmssw/cfipython"]))
	
	/* 
	/cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/python
	/cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/lib/el8_amd64_gcc12
	/cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/coral/CORAL_2_3_21-28dabfc38a6bf00dd35728bb54daa6e2/el8_amd64_gcc12/python
	/cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/coral/CORAL_2_3_21-28dabfc38a6bf00dd35728bb54daa6e2/el8_amd64_gcc12/lib
	*/
	const cvmfsPrefix = path.join("/cvmfs", "cms.cern.ch", release.scram_arch)
	// Prevent access of python packages on CVMFS as they use __init__ magic that does not work with pylance
	// We want to use our symlink tree instead, so exclude the paths
	let excludePaths = [
		path.join(cvmfsPrefix, "cms", "cmssw", release.cmssw_release, "python"),
		path.join(cvmfsPrefix, "cms", "cmssw", release.cmssw_release, "lib", release.scram_arch),
		path.join(cvmfsPrefix, "cms", "coral", "*", release.scram_arch, "python"),
		path.join(cvmfsPrefix, "cms", "coral", "*", release.scram_arch, "lib", release.scram_arch),
	]
	
	// /cvmfs/cms.cern.ch/el8_amd64_gcc12/external/py3-tensorflow/2.12.0-b1d544bcde4b10a0c0da88f060f65dc9/lib/python3.9/site-packages
	for (let external of await getPythonExternalsForRelease(release, parsePythonVersionToCmssw(await pythonVersion))) {
		if (keepExternals.indexOf(external.name) == -1) {
			excludePaths.push(external.path)
		}
	}
	promises.push(updateConfigKeepingTrack(pythonConfig, "exclude", new ConfigManager("workspaceConfig.python.analysis.exclude", store), excludePaths)) 
	return Promise.allSettled(promises)
}

function makeTerminalOptions(release:CmsRelease):vscode.TerminalOptions {
	return {name:release.cmssw_release, 
		shellPath:path.join(release.rootFolder.fsPath, ".vscode-cmssw", "cmsenv_launcher.sh"),
	shellArgs : [release.rootFolder.fsPath, "/bin/bash"]}
}

function makeTerminalProfile(release:CmsRelease):vscode.TerminalProfile {
	return new vscode.TerminalProfile(makeTerminalOptions(release))
}



// TODO : this needs to be recreated whenever the aboslute path to CMSSW release changes (ie renaming/moving folders)
async function makeVirtualEnvironment(release:CmsRelease, forceRecreate:boolean=false):Promise<void> { // Run scram-venv if needed, then make a python executable that runs cmsenv then python
	// CMSSW_14_0_0_pre1/venv/el8_amd64_gcc12/bin/python3_cmsenv
	const pathToScramVenv =  vscode.Uri.joinPath(release.rootFolder, "venv")
	const pathToPythonCmsenv = vscode.Uri.joinPath(pathToScramVenv, release.scram_arch, "bin", "python3_cmsenv")

	
	try {
		await vscode.workspace.fs.stat(pathToScramVenv)
	} catch {
		await promisify(cp.exec)('cmsenv && scram-venv', {cwd: release.rootFolder.fsPath});
	}

	try {
		await vscode.workspace.fs.stat(pathToPythonCmsenv)
		if (!forceRecreate)
			return;
	} catch {}
	
	await vscode.workspace.fs.writeFile(pathToPythonCmsenv,
		new TextEncoder().encode(
		"#!/bin/bash\n" + 
		"cd " + release.rootFolder.fsPath + "\n" +
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec "$LOCALRT/venv/$SCRAM_ARCH/bin/python3" "$@"\n'
	))
	// do chmod +x
	let stat = await nodeFs.stat(pathToPythonCmsenv.fsPath)
	let mode = stat.mode & 0xFFFF;
    const x = nodeFs.constants.S_IXUSR | nodeFs.constants.S_IXGRP | nodeFs.constants.S_IXOTH;
    mode |= x;
	return nodeFs.chmod(pathToPythonCmsenv.fsPath, mode)
}

/**
 * Add to python config so that the virtual environment from scram if found. Does not work for now as python.venvFolders does not exist at workspace level
 * @param release 
 */
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
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "cmssw-vscode" is now active!');
	//console.log(context.storageUri)

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.buildPythonSymlinkTree', () => {
		findCmsswReleases().then((releases) => {
			return Promise.allSettled(
				releases.map((release) => buildPythonSymlinkTree(release, pythonPkgsToIndexFromConfig()))
				.concat(releases.map((release) => makeCfiPythonSymlink(release))))
		}).catch((reason) => console.log(reason))
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.updatePythonConfig', async () => {
		const release = getCurrentRelease(context.workspaceState)
		if (release !== undefined)
			return updatePythonConfig(release, context.workspaceState, vscode.workspace.getConfiguration('cmssw').get('pythonExternalsToIndex', []))
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.makeScramVenv', async () => {
		const release = getCurrentRelease(context.workspaceState)
		if (release !== undefined)
			return makeVirtualEnvironment(release)
		//return addScramVenvToSettings(release) // does not work yet
	}))

	context.subscriptions.push(vscode.window.registerTerminalProfileProvider("cmssw-vscode.cmsenv-shell", {
		async provideTerminalProfile(token) {
			const release = getCurrentRelease(context.workspaceState)
			if (release !== undefined)	
				return makeTerminalProfile(release)
			else
				vscode.window.showErrorMessage("No CMSSW release selected. You need to select a release before opening a CMSSW cmsenv terminal")
		},
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.chooseCmsswWorkingArea', async () => {
		const releases = await findCmsswReleases()
		let displayStrings = new Array<string>()
		for (const release of releases) {
			displayStrings.push(userFriendlyReleaseLocation(release))
		}
		// TODO add custom location option
		const qpResult = await vscode.window.showQuickPick(
			displayStrings
		)
		if (qpResult !== undefined) {
			setCurrentRelease(context.workspaceState, releases[displayStrings.indexOf(qpResult)])
		}
	}))

	let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	statusBar.command = "cmssw-vscode.chooseCmsswWorkingArea"
	let updateStatusbarText = (release:CmsRelease|undefined) => {
		if (release !== undefined) {
			statusBar.text = userFriendlyReleaseLocation(release)
		} else {
			statusBar.text = "No CMSSW release set"
		}
	}
	updateStatusbarText(getCurrentRelease(context.workspaceState))
	onReleaseChange.event((e:ReleaseChangeEvent) => updateStatusbarText(e.newRelease))
	statusBar.show()
	context.subscriptions.push(statusBar)
	context.subscriptions.push(onReleaseChange)
}

// This method is called when your extension is deactivated
export function deactivate() {}
