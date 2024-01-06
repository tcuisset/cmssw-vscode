import * as vscode from 'vscode';
import { PythonExtension, VersionInfo, ResolvedVersionInfo } from '@vscode/python-extension';
import { promisify } from 'node:util';
import * as cp from 'node:child_process'

import { CmsRelease, workspaceFolderForRelease, Package, listCheckedOutPackages, getCurrentRelease } from '../cmsRelease';
import * as cms from '../cmsRelease'
import * as utils from "../utils";
import { pathToScramVenv } from './common'

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

/**
 * Run scram-venv if needed, then make a python executable that runs cmsenv then python
 * @todo this needs to be recreated whenever the aboslute path to CMSSW release changes (ie renaming/moving folders)
 * @param release 
 * @param forceRecreate 
 * @returns 
 */
export async function makeVirtualEnvironment(release:CmsRelease, forceRecreate=false):Promise<void> { 
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
	} catch { /* empty */ }
	
	await utils.createExecutableScript(pathToPythonCmsenv, 
		"#!/bin/bash\n" + 
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec "$LOCALRT/venv/$SCRAM_ARCH/bin/python3" "$@"\n'
	)
}


