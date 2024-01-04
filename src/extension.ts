// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as cms from './cmsRelease';
import * as utils from "./utils";
import * as cpp from './cpp'
import * as py from './python'


function cmsenvLauncherPath(release:cms.CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "cmsenv_launcher.sh")
}

/**
 * Creates a cmsenv_launcher.sh file in .vscode-cmssw
 * @param release 
 */
async function createCmsenvLauncher(release:cms.CmsRelease) {
	await utils.createExecutableScript(cmsenvLauncherPath(release),
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
function bashCmsenvLauncherPath(release:cms.CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "cmsenv_launchers", "bash")
}
async function createBashCmsenvLauncher(release:cms.CmsRelease) {
	await utils.createExecutableScript(bashCmsenvLauncherPath(release),
		"#!/bin/bash\n" +
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec /bin/bash "$@"\n'
	)
}

function makeTerminalProfile(release:cms.CmsRelease):vscode.TerminalProfile {
	return new vscode.TerminalProfile( {name:release.cmssw_release,
		shellPath:bashCmsenvLauncherPath(release).fsPath
		})
}

/**
 * Makes list of languages that need to be setup
 * @param release 
 * @returns list out of ["python", "cpp"]. Empty is possible
 */
async function listLanguagesToSetupInRelease(release:cms.CmsRelease) : Promise<string[]> {
	let res = new Array<string>()
	if (!await py.isPythonFullySetup(release))
		res.push("python")
	if (!await cpp.isCppFullySetup(release))
		res.push("cpp")
	return res
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "cmssw-vscode" is now active!');
	//console.log(context.storageUri)

	cms.setWorkspaceStorage(context.workspaceState)
	cms.setGlobalStorage(context.globalState)
	/*
	com.findCmsswReleases().then((releases) => {
		console.log(com.listCheckedOutPackages(releases[0]))
	})*/
	let outputChannel = vscode.window.createOutputChannel("CMSSW")
	context.subscriptions.push(outputChannel)
	utils.setOutputChannel(outputChannel)

	let handleExceptionsInCommand = (fct:CallableFunction) => (() => {
		try {
			fct()
		} catch (e) {
			outputChannel.appendLine("ERROR : " + String(e))
			vscode.window.showErrorMessage("CMSSW extension : an error ocurred :\n" + String(e))
		}
	})

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.buildPythonSymlinkTree', handleExceptionsInCommand(() => {
		const rel = cms.getCurrentRelease()
		if (rel !== undefined) {
			py.buildPythonSymlinkTree(rel)
			py.makeCfiPythonSymlink(rel)
		}
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.updatePythonConfig', handleExceptionsInCommand(async () => {
		const release = cms.getCurrentRelease()
		if (release !== undefined) {
			await py.updatePythonConfig(release, context.workspaceState//, vscode.workspace.getConfiguration('cmssw').get('pythonExternalsToIndex', [])
				)
		}
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.makeScramVenv', handleExceptionsInCommand(async () => {
		const release = cms.getCurrentRelease()
		if (release !== undefined)
			return py.makeVirtualEnvironment(release)
		//return addScramVenvToSettings(release) // does not work yet
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.setupPython', async () => {
		vscode.commands.executeCommand('cmssw-vscode.buildPythonSymlinkTree')
		await vscode.commands.executeCommand('cmssw-vscode.makeScramVenv')
		vscode.commands.executeCommand('cmssw-vscode.updatePythonConfig')
	}))

	context.subscriptions.push(vscode.window.registerTerminalProfileProvider("cmssw-vscode.cmsenv-shell", {
		async provideTerminalProfile(token) {
			const release = cms.getCurrentRelease()
			if (release !== undefined)	
				return makeTerminalProfile(release)
			else
				vscode.window.showErrorMessage("CMSSW extension : No CMSSW release selected. You need to select a release (bottom right in status bar) before opening a CMSSW cmsenv terminal")
		},
	}))

	context.subscriptions.push(cms.onReleaseChange.event(async (e)=> {
		// Checking if we need to create a bash launcher for cmsenv terminal
		if (e.newRelease !== undefined) {
			try {
				const stat = await vscode.workspace.fs.stat(bashCmsenvLauncherPath(e.newRelease))
				if (stat.type === vscode.FileType.File)
					return
			} catch (exc) {
				if (utils.isENOENT(exc))
					await createBashCmsenvLauncher(e.newRelease)
				else
					throw exc
			}
		}
	}))

	// Don't await as it can take a long time
	cpp.setupCpptools().then((disp) => context.subscriptions.push(disp))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.resetExtensionForCurrentRelease', handleExceptionsInCommand(async () => {
		const release = cms.getCurrentRelease()
		if (release === undefined) {
			utils.errorNoReleaseSelected()
			return
		}
		// Some of them may reject since files/folder may not exist
		await Promise.allSettled([
			vscode.workspace.fs.delete(vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw"), {recursive:true}),
			py.pathsToDeleteOnCleanupRelease(release).map((path) => vscode.workspace.fs.delete(path))
		])
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.chooseCmsswWorkingArea', handleExceptionsInCommand(async () => {
		const releases = await cms.findCmsswReleases()
		let displayStrings = new Array<string>()
		for (const release of releases) {
			displayStrings.push(cms.userFriendlyReleaseLocation(release))
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
			await cms.setCurrentRelease(newReleaseChosen)
			if (newReleaseChosen === undefined)
				return;
			const newRelease = cms.getCurrentRelease()
			if (newRelease === undefined) {
				throw Error("Could not set release")
			}
			
			let languagesToSetup = await listLanguagesToSetupInRelease(newRelease)
			if (languagesToSetup.length > 0) {
				if (languagesToSetup.length > 1)
					languagesToSetup.push("All")
				let pickRes = await  vscode.window.showInformationMessage(
					"We detected that some lanuguages were not yet configured for VSCode in the current CMSSW languages. Do you wish to set them up ?",
					...languagesToSetup)
				let setupPython = () => vscode.commands.executeCommand("cmssw-vscode.setupPython")
				let setupCpp = () => vscode.commands.executeCommand("cmssw-vscode.setupCpp")
				let setupPromises:Thenable<unknown>[] = []
				if (pickRes === undefined)
					return
				if (pickRes in ["All", "python"])
					setupPromises.push(setupPython())
				if (pickRes in ["All", "cpp"])
					setupPromises.push(setupCpp())
				let setupRes = await Promise.allSettled(setupPromises)
				let rejectedPromises = setupRes.filter((res) => res.status === "rejected") as PromiseRejectedResult[]
				if (rejectedPromises.length > 0) {
					const excString = rejectedPromises.map((res) => res.reason).toString()
					utils.logToOC("ERROR : could not setup languages for CMS release area " + newReleaseChosen.toString() + "\nDue to : " + excString)
					const clearRes = await vscode.window.showErrorMessage("CMSSW : could not setup languages for CMSSW release area, due to " +excString + "\nYou can try clearing the extension state", "Clear")
					if (clearRes === "Clear")
						vscode.commands.executeCommand("cmssw-vscode.resetExtensionForCurrentRelease")
					
				}
			}
		}
	})))

	let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	statusBar.command = "cmssw-vscode.chooseCmsswWorkingArea"
	let updateStatusbarText = (release:cms.CmsRelease|undefined) => {
		if (release !== undefined) {
			statusBar.text = cms.userFriendlyReleaseLocation(release)
		} else {
			statusBar.text = "No CMSSW release set"
		}
	}
	updateStatusbarText(cms.getCurrentRelease())
	cms.onReleaseChange.event((e:cms.ReleaseChangeEvent) => updateStatusbarText(e.newRelease))
	statusBar.show()
	context.subscriptions.push(statusBar)
	context.subscriptions.push(cms.onReleaseChange)
}

// This method is called when your extension is deactivated
export function deactivate() {
	cms.setWorkspaceStorage(undefined)
	cms.setGlobalStorage(undefined)
	utils.setOutputChannel(undefined)
}
