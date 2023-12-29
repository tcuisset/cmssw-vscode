// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';

import * as com from './common';
import * as cpp from './cpp'
import * as py from './python'
import { assert } from 'console';


function cmsenvLauncherPath(release:com.CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "cmsenv_launcher.sh")
}

/**
 * Creates a cmsenv_launcher.sh file in .vscode-cmssw
 * @param release 
 */
async function createCmsenvLauncher(release:com.CmsRelease) {
	await com.createExecutableScript(cmsenvLauncherPath(release),
		"#!/bin/bash\n" +
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec "$@"\n'
	)
}

/**
 * Path to the bash cmsenv launcher. The file has to be named bash so that the VSCode shell integration works automatically
 */
function bashCmsenvLauncherPath(release:com.CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "cmsenv_launchers", "bash")
}
async function createBashCmsenvLauncher(release:com.CmsRelease) {
	await com.createExecutableScript(bashCmsenvLauncherPath(release),
		"#!/bin/bash\n" +
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec /bin/bash "$@"\n'
	)
}

function makeTerminalProfile(release:com.CmsRelease):vscode.TerminalProfile {
	return new vscode.TerminalProfile( {name:release.cmssw_release,
		shellPath:bashCmsenvLauncherPath(release).fsPath,
		})
}

/**
 * Makes list of languages that need to be setup
 * @param release 
 * @returns list out of ["python", "cpp"]. Empty is possible
 */
async function listLanguagesToSetupInRelease(release:com.CmsRelease) : Promise<string[]> {
	let res = new Array<string>()
	if (!await py.isPythonFullySetup(release))
		res.push("python")
	return res// TODO C++
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "cmssw-vscode" is now active!');
	//console.log(context.storageUri)

	com.setWorkspaceStorage(context.workspaceState)
	/*
	com.findCmsswReleases().then((releases) => {
		console.log(com.listCheckedOutPackages(releases[0]))
	})*/

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.buildPythonSymlinkTree', () => {
		const rel = com.getCurrentRelease()
		if (rel !== undefined) {
			py.buildPythonSymlinkTree(rel)
			py.makeCfiPythonSymlink(rel)
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.updatePythonConfig', async () => {
		const release = com.getCurrentRelease()
		if (release !== undefined) {
			try {
				await py.updatePythonConfig(release, context.workspaceState, vscode.workspace.getConfiguration('cmssw').get('pythonExternalsToIndex', []))
			} catch (e) {
				console.log("Caught e")
				console.log(e)
			}
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.makeScramVenv', async () => {
		const release = com.getCurrentRelease()
		if (release !== undefined)
			return py.makeVirtualEnvironment(release)
		//return addScramVenvToSettings(release) // does not work yet
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.setupPython', async () => {
		vscode.commands.executeCommand('cmssw-vscode.buildPythonSymlinkTree')
		await vscode.commands.executeCommand('cmssw-vscode.makeScramVenv')
		vscode.commands.executeCommand('cmssw-vscode.updatePythonConfig')
	}))

	context.subscriptions.push(vscode.window.registerTerminalProfileProvider("cmssw-vscode.cmsenv-shell", {
		async provideTerminalProfile(token) {
			const release = com.getCurrentRelease()
			if (release !== undefined)	
				return makeTerminalProfile(release)
			else
				vscode.window.showErrorMessage("No CMSSW release selected. You need to select a release before opening a CMSSW cmsenv terminal")
		},
	}))

	context.subscriptions.push(com.onReleaseChange.event(async (e)=> {
		if (e.newRelease !== undefined) {
			try {
				const stat = await vscode.workspace.fs.stat(bashCmsenvLauncherPath(e.newRelease))
				if (stat.type == vscode.FileType.File)
					return
			} catch (exc) {
				if (com.isENOENT(exc))
					await createBashCmsenvLauncher(e.newRelease)
				else
					throw exc
			}
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.chooseCmsswWorkingArea', async () => {
		const releases = await com.findCmsswReleases()
		let displayStrings = new Array<string>()
		for (const release of releases) {
			displayStrings.push(com.userFriendlyReleaseLocation(release))
		}
		displayStrings.push("Disable")
		// TODO add custom location option
		const qpResult = await vscode.window.showQuickPick(displayStrings,
			{ title : "Choose a CMSSW working area", }
		)
		if (qpResult !== undefined) {
			let newReleaseChosen;
			if (qpResult === "Disable") {
				newReleaseChosen = undefined
			} else {
				newReleaseChosen = releases[displayStrings.indexOf(qpResult)]
			}
			await com.setCurrentRelease(newReleaseChosen)
			if (newReleaseChosen === undefined)
				return;
			const newRelease = com.getCurrentRelease()
			if (newRelease === undefined) {
				throw Error("Could not set release")
			}
			try {
				let languagesToSetup = await listLanguagesToSetupInRelease(newRelease)
				if (languagesToSetup.length > 0) {
					if (languagesToSetup.length > 1)
						languagesToSetup.push("All")
					let pickRes = await  vscode.window.showInformationMessage(
						"We detected that some lanuguages were not yet configured for VSCode in the current CMSSW languages. Do you wish to set them up ?",
						...languagesToSetup)
					let setupPython = () => vscode.commands.executeCommand("cmssw-vscode.setupPython")
					let setupCpp = () => vscode.commands.executeCommand("cmssw-vscode.setupCpp")
					if (pickRes === undefined)
						return
					else if (pickRes == "All") {
						setupPython()
						setupCpp()
					} else if (pickRes == "python") {
						setupPython()
					} else if (pickRes == "cpp") {
						setupCpp()
					} else {
						assert(false)
					}
					
				}
			} catch (e) {
				throw e; //TODO here we should offer resetting the config
			}
			
		}
	}))

	let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	statusBar.command = "cmssw-vscode.chooseCmsswWorkingArea"
	let updateStatusbarText = (release:com.CmsRelease|undefined) => {
		if (release !== undefined) {
			statusBar.text = com.userFriendlyReleaseLocation(release)
		} else {
			statusBar.text = "No CMSSW release set"
		}
	}
	updateStatusbarText(com.getCurrentRelease())
	com.onReleaseChange.event((e:com.ReleaseChangeEvent) => updateStatusbarText(e.newRelease))
	statusBar.show()
	context.subscriptions.push(statusBar)
	context.subscriptions.push(com.onReleaseChange)

	//cpp.setupCpptools()

}

// This method is called when your extension is deactivated
export function deactivate() {
	com.setWorkspaceStorage(undefined)
}
