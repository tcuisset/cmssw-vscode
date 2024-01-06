import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'

import { CmsRelease, workspaceFolderForRelease, getCurrentRelease } from './cmsRelease';
import * as cms from './cmsRelease'
import * as utils from "./utils";

import { pathToScramVenv } from './python/common';
import { getPythonSymlinkTreeFolder, buildPythonSymlinkTree } from './python/symlinks'
import { updatePythonConfig } from './python/config'
import { makeVirtualEnvironment } from './python/venv'

export { makeVirtualEnvironment } from './python/venv'
export { updatePythonConfig } from './python/config'
export { buildPythonSymlinkTree } from './python/symlinks'


/** list of paths of files that were created for python by the CMSSW extension (to be used on cleanup). Does not include any file in .vscode-cmssw */
export function pathsToDeleteOnCleanupRelease(release:CmsRelease) {
	return [vscode.Uri.joinPath(pathToScramVenv(release), "bin", "python3_cmsenv")]
}



/**
 * Ensures all the steup for python is already done (scram venv, etc)
 * @param release 
 * @returns true if python is fully setup, false if some setup is missing
 * @throws in case something is wrong in the config (should probably clear everything in this case)
 */
export async function isPythonFullySetup(release:CmsRelease):Promise<boolean> {
	const checkScramVenv = async () => {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(pathToScramVenv(release), "bin", "python3_cmsenv"))
			return true;
		} catch (e) {
			if (utils.isENOENT(e))
				return false;
			throw e;
		}
	}

	const checkPythonConfig = () => {
		const pythonConfig = vscode.workspace.getConfiguration("python.analysis", workspaceFolderForRelease(release)) // python.analysis.include

		// CHeck that all values given are in the settings config key
		const checkValuesAreInConfig = (key:string, values:string[]):boolean => {
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

	const checkSymlinkFolders = async () => {
		const promises = [
			getPythonSymlinkTreeFolder(release, false)].map(async (folder) => {
			try {
				const statRes = (await vscode.workspace.fs.stat(await folder)).type
				// RegularPython will be Directory, CfiPython will be SymbolicLink to a directory
				// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
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
	
	const res = await Promise.all([checkScramVenv(), checkPythonConfig(), checkSymlinkFolders()])
	console.log("isPythonFullySetup result")
	console.log(res)
	return (res[0] && res[1] && res[2])
}

type ComFct = (...args: unknown[]) => unknown
export function activateExtensionPython(context:vscode.ExtensionContext, handleExceptionsInCommand:((f:ComFct) => ComFct)) {
	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.buildPythonSymlinkTree', handleExceptionsInCommand(() => {
		const rel = cms.getCurrentRelease()
		if (rel !== undefined) {
			return buildPythonSymlinkTree(rel)
		}
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.updatePythonConfig', handleExceptionsInCommand(async () => {
		const release = cms.getCurrentRelease()
		if (release !== undefined) {
			await updatePythonConfig(release)
		}
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.makeScramVenv', handleExceptionsInCommand(async () => {
		const release = cms.getCurrentRelease()
		if (release !== undefined)
			return makeVirtualEnvironment(release)
		//return addScramVenvToSettings(release) // does not work yet
	})))

	context.subscriptions.push(vscode.commands.registerCommand('cmssw-vscode.setupPython', async () => {
		await Promise.all([vscode.commands.executeCommand('cmssw-vscode.buildPythonSymlinkTree'), vscode.commands.executeCommand('cmssw-vscode.makeScramVenv')])
		await vscode.commands.executeCommand('cmssw-vscode.updatePythonConfig')
	}))
}
