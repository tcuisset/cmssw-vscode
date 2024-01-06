/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'

import {CmsRelease} from '../cmsRelease'
import * as cms from '../cmsRelease'
import * as utils from "../utils";
import { pathToScramVenv, pythonVersionForRelease } from './common';
import * as Externals from '../externals'

function pathToPyrightConfig(release:CmsRelease) {
    return vscode.Uri.joinPath(cms.workspaceFolderForRelease(release).uri, "pyrightconfig.json").fsPath
}

/**
 * Load the pyright_config.json file for the given release (looks in workspace folder root)
 * @returns the pyright config as parsed json
 * @throws in case of parse error or read error (returns {} in case of non-existing file)
 */
async function loadPyrightConfig(release:CmsRelease):Promise<any> {
    try {
        return JSON.parse(await nodeFs.readFile(pathToPyrightConfig(release), "utf-8"))
    } catch (e) {
        if (!utils.isENOENT(e))
            throw new Error("Could not parse existing pyrightconfig.json at " + pathToPyrightConfig(release), {cause:e})
    }
    return {}
}

async function writePyrightConfig(release:CmsRelease, config:any) {
    await nodeFs.writeFile(pathToPyrightConfig(release), JSON.stringify(config, null, 4), 'utf8')
}

export async function updatePythonConfig(release:CmsRelease) : Promise<any> {
    const externalsP = (async (): Promise<[string, Externals.CmsPythonExternal[]]> => {
        const pyVer = await pythonVersionForRelease(release)
        
        return [pyVer, await Externals.getPythonExternalsForRelease(release, pyVer)]
    })()
    
    const pyrightConfig = await loadPyrightConfig(release)

    const releasePrefix = vscode.workspace.asRelativePath(release.rootFolder, false)

    // Pyright config : see https://microsoft.github.io/pyright/#/configuration

    /** Only adds a value to a string[] key if it does not exist already */
    const updateKey = (key:string, newVals:string[]) => {
        if (!(pyrightConfig[key] instanceof Array)) {
            pyrightConfig[key] = newVals
        } else {
            for (const newVal of newVals) {
                if (!pyrightConfig[key].includes(newVal))
                    pyrightConfig[key].push(newVal)
            }
        }
    }

    updateKey("exclude", ["**/CMSSW_*/.vscode-cmssw", "**/CMSSW_*/cfipython", "**/CMSSW_*/python", "**/CMSSW_*/config", "**/CMSSW_*/cfipython", "**/CMSSW_*/venv"])

    // We use an actually valid venv but it might be a better idea to use a dummy venv in extension global storage (since this config is shared among CMSSW releases in this current setup)
    pyrightConfig.venvPath = path.dirname(pathToScramVenv(release).fsPath)
    pyrightConfig.venv = release.scram_arch

    if (pyrightConfig.executionEnvironments === undefined)
        pyrightConfig.executionEnvironments = new Array<{root?:string, extraPaths?:string[], pythonVersion?:string}>()

    let execEnvironment:any = undefined
    // Finding if an executionEnvironment key already exists
    for (const execEnvProbe of pyrightConfig.executionEnvironments) {
        if (execEnvProbe.root === releasePrefix)
            execEnvironment = execEnvProbe
    }
    if (execEnvironment === undefined) {
        execEnvironment = {}
        pyrightConfig.executionEnvironments.push(execEnvironment)
    }

    execEnvironment.root = releasePrefix
    const [pyVer, externals] = await externalsP
    execEnvironment.extraPaths = [
        releasePrefix + "/.vscode-cmssw/python",
        ...externals.map((ext) => ext.path)
    ]
    execEnvironment.pythonVersion = pyVer.slice("python".length)

    // We also set the global settings in case a python script is outside the CMSSW release area
    // Thus any file inside a CMSSW release (that has been setup) will have that release always, and any file outside will have the currently selected release as per the status bar
    pyrightConfig.extraPaths = execEnvironment.extraPaths
    pyrightConfig.pythonVersion = execEnvironment.pythonVersion

    await writePyrightConfig(release, pyrightConfig)
}