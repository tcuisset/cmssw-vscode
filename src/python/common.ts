import * as vscode from 'vscode';
import * as nodeFs from 'node:fs/promises'
import * as path from 'path'

import { CmsRelease, workspaceFolderForRelease, Package, listCheckedOutPackages, getCurrentRelease } from '../cmsRelease';
import * as cms from '../cmsRelease'
import * as utils from "../utils";



export function pathToScramVenv(release:CmsRelease) {
	return vscode.Uri.joinPath(release.rootFolder, "venv", release.scram_arch)
}

/** Retunrs "python3.9" for example */
export async function pythonVersionForRelease(release:CmsRelease):Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return JSON.parse(await nodeFs.readFile(path.join(release.rootFolder.fsPath, ".SCRAM", release.scram_arch, "tools", "python3"), "utf8")).LIB[0]
}