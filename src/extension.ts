// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { promisify } from 'node:util';
import * as cp from 'node:child_process'

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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
		shellPath:bashCmsenvLauncherPath(release).fsPath,
		iconPath:new vscode.ThemeIcon("cms-icon")
		})
}

/**
 * Makes list of languages that need to be setup
 * @param release 
 * @returns list out of ["python", "cpp"]. Empty is possible
 */
async function listLanguagesToSetupInRelease(release:cms.CmsRelease) : Promise<string[]> {
	const res = new Array<string>()
	if (!await py.isPythonFullySetup(release))
		res.push("python")
	if (!await cpp.isCppFullySetup(release))
		res.push("cpp")
	return res
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	//console.log('Congratulations, your extension "cmssw-vscode" is now active!');

	cms.setWorkspaceStorage(context.workspaceState)
	cms.setGlobalStorage(context.globalState)
	
	const outputChannel = vscode.window.createOutputChannel("CMSSW")
	context.subscriptions.push(outputChannel)
	utils.setOutputChannel(outputChannel)

	outputChannel.appendLine("CMSSW extension is activating...")

	// Checking for cmsset
	cp.exec("which scramv1", (error) => {
		if (error !== null) {
			void vscode.window.showErrorMessage("CMSSW : the extension was not able to run 'cmsenv'. Ensure that you have 'source /cvmfs/cms.cern.ch/cmsset_default.sh' in your .bashrc. This needs to be on the SSH remote host (lxplus, ...)  or the docker container as applicable.")
			outputChannel.appendLine("Running 'which scramv1' failed due to " + JSON.stringify(error))
		}
	})

	const handleExceptionsInCommand = (fct:(...args: unknown[]) => unknown):(...args: unknown[]) => unknown => (async () => {
		try {
			await fct()
		} catch (e) {
			outputChannel.appendLine("ERROR : " + String(e))
			if (e instanceof Error && e.stack !== undefined) {
				outputChannel.appendLine(e.stack)
				if (e.cause !== undefined) {
					outputChannel.appendLine("Exception caused by : " + e.cause?.toString())
					if (e.cause instanceof Error && e.cause.stack !== undefined)
						outputChannel.appendLine(e.cause.stack)
				}
			}
				
			void vscode.window.showErrorMessage("CMSSW extension : an error ocurred :\n" + String(e))
		}
	})

	py.activateExtensionPython(context, handleExceptionsInCommand)

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.setupCpp', async () => {
		await cpp.setupCpptools()
	}))

	context.subscriptions.push(vscode.window.registerTerminalProfileProvider("cmssw-vscode.cmsenv-shell", {
		provideTerminalProfile() {
			const release = cms.getCurrentRelease()
			if (release !== undefined)	
				return makeTerminalProfile(release)
			else {
				void vscode.window.showErrorMessage("CMSSW extension : No CMSSW release selected. You need to select a release (bottom right in status bar) before opening a CMSSW cmsenv terminal")
				return undefined
			}
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
	}));

	// Don't await as it can take a long time
	cpp.setupCpptools().then((disp) => context.subscriptions.push(disp),
		(e) => {
			outputChannel.appendLine("ERROR : " + String(e))
			void vscode.window.showErrorMessage("CMSSW extension : an error ocurred :\n" + String(e))
		})

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
		const displayStrings = new Array<string>()
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
			
			const languagesToSetup = await listLanguagesToSetupInRelease(newRelease)
			if (languagesToSetup.length > 0) {
				if (languagesToSetup.length > 1)
					languagesToSetup.push("All")
				const pickRes = await  vscode.window.showInformationMessage(
					"We detected that some lanuguages were not yet configured for VSCode in the current CMSSW languages. Do you wish to set them up ?",
					...languagesToSetup)
				const setupPython = () => vscode.commands.executeCommand("cmssw-vscode.setupPython")
				const setupCpp = () => vscode.commands.executeCommand("cmssw-vscode.setupCpp")
				const setupPromises:Thenable<unknown>[] = []
				if (pickRes === undefined)
					return
				if (["All", "python"].includes(pickRes))
					setupPromises.push(setupPython())
				if (["All", "cpp"].includes(pickRes))
					setupPromises.push(setupCpp())
				const setupRes = await Promise.allSettled(setupPromises)
				const rejectedPromises = setupRes.filter((res) => res.status === "rejected") as PromiseRejectedResult[]
				if (rejectedPromises.length > 0) {
					const excString = rejectedPromises.map((res):string => res.reason as string).toString()
					utils.logToOC("ERROR : could not setup languages for CMS release area " + newReleaseChosen.toString() + "\nDue to : " + excString)
					const clearRes = await vscode.window.showErrorMessage("CMSSW : could not setup languages for CMSSW release area, due to " +excString + "\nYou can try clearing the extension state", "Clear")
					if (clearRes === "Clear")
						void vscode.commands.executeCommand("cmssw-vscode.resetExtensionForCurrentRelease")
					
				}
			}
		}
	})))

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	statusBar.command = "cmssw-vscode.chooseCmsswWorkingArea"
	const updateStatusbarText = (release:cms.CmsRelease|undefined) => {
		if (release !== undefined) {
			statusBar.text = "$(cms-icon)" + cms.userFriendlyReleaseLocation(release)
		} else {
			statusBar.text = "$(cms-icon)No CMSSW release set"
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
