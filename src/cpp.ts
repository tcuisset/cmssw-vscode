import * as vscode from 'vscode';
import * as nodeFs from 'node:fs/promises'
import * as path from 'path';
import * as vsCpp from 'vscode-cpptools';

import * as cms from './cmsRelease'
import * as utils from './utils'

let cppApi:vsCpp.CppToolsApi|undefined = undefined;
let cppConfProvider:CmsswConfigurationProvider|undefined = undefined

/** Cache of parsed compile_commands.json. Values are Promise so we ensure parsing is only done once (otherwise it could be done multiple times in parallel) */
const compileCommandsCache = new Map<cms.CmsReleaseBase, Promise<CompileCommand[]>>()

/** Cache of CXX compiler path (gcc) for release and arch */
//let cppCompilerCache:Map<cms.CmsReleaseBase, Promise<string>> = new Map()

/** Finds C++ compiler path for release (cached) */
// async function getCppCompilerPath(release:cms.CmsRelease|cms.CmsReleaseBase):Promise<string> {
//     const releaseBase = new cms.CmsReleaseBase(release.scram_arch, release.cmssw_release)
//     let compilerPathPromise = cppCompilerCache.get(releaseBase)
//     if (compilerPathPromise === undefined) {
//         if (!(release instanceof cms.CmsRelease)) // TODO better support for this case
//             throw new Error("C++ : could not find compiler path for release " + release + ", you should start by opening a file in the local release, not in cvmfs")
//         compilerPathPromise = (async () =>
//             JSON.parse(await nodeFs.readFile(path.join(release.rootFolder.fsPath, ".SCRAM", release.scram_arch, "tools", "gcc-cxxcompiler"), "utf8")).CXX
//         )()
//         cppCompilerCache.set(release, compilerPathPromise)
//     }
//     return compilerPathPromise
// }
async function getCppCompilerPath(release:cms.CmsRelease):Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return JSON.parse(await nodeFs.readFile(path.join(release.rootFolder.fsPath, ".SCRAM", release.scram_arch, "tools", "gcc-cxxcompiler"), "utf8")).CXX
}

interface CompileCommand {
    /** 
     * Compiler command used
     * Example : clang++ -c -Dxxx -I... -O2 -pthread -pipe -W.. -std=c++17 --gcc-toolchain=/cvmfs/cms.cern.ch/el8_amd64_gcc12/external/gcc/12.3.1-40d504be6370b5a30e3947a6e575ca28 /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/FWCore/Utilities/src/ESInputTag.cc -o tmp/el8_amd64_gcc12/src/FWCore/Utilities/src/FWCoreUtilities/ESInputTag.cc.o
     * */
    command:string;
    /** example : /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1 */
    directory:string;
    /** example : /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/FWCore/Utilities/src/ESInputTag.cc */
    file:string;
}

interface ParsedCompileCommand {
    defines:string[]
    cppStandard:string
    regularIncludes:string[]
    systemIncludes:string[]
    sourcePath:string
}

function parseCppStandard(cppStandard:string):vsCpp.SourceFileConfiguration["standard"] {
    if (!["c++98", "c++03", "c++11", "c++14", "c++17"].includes(cppStandard))
        throw new Error("Could not parse cpp standard from compile_commands.json : " + cppStandard)
    return cppStandard as vsCpp.SourceFileConfiguration["standard"]
}
function parsedCompileCommandToSourceConfiguration(parsedCommand:ParsedCompileCommand):vsCpp.SourceFileConfiguration {
    return {defines:parsedCommand.defines, includePath:parsedCommand.systemIncludes.concat(parsedCommand.regularIncludes),
      intelliSenseMode:'gcc-x64', standard:parseCppStandard(parsedCommand.cppStandard)}
}

function parseCompileCommand(command:CompileCommand):ParsedCompileCommand {
    const defines:string[] = []
    const defineRe = /([a-zA-Z0-9_]{1,})={0,1}/
    let cppStandard:string|undefined = undefined
    const regularIncludes:string[] = []
    const systemIncludes:string[] = []
    let sourcePath:string|undefined = undefined
    /** Ignore next argument if set to true */
    let ignoreNext = false
    for (const arg of command.command.split(" ")) {
        if (ignoreNext) {
            ignoreNext = false
            continue
        }
        let failedParse = false
        if (arg.startsWith("-")) {
            const commandWoDash = arg.slice(1)
            if (commandWoDash.startsWith("std")) { // -std=c++17
                cppStandard = commandWoDash.slice(4)
            } else if (commandWoDash.startsWith("isystem")) {
                systemIncludes.push(arg.slice(8))
            } else {
                switch (arg[1]) {
                    case "D": {
                        const matchRes = defineRe.exec(arg.slice(2))
                        if (matchRes?.[1] !== undefined)
                            defines.push(matchRes[1])
                        else 
                            failedParse = true
                        break
                    }
                    case "I":
                        regularIncludes.push(arg.slice(2))
                        break
                    case "o": // output file (we do not care)
                    case "-": // double-dash option
                        ignoreNext = true
                        break
                    case "c":
                    case "W":
                    case "f":
                        break
                    
                    case undefined:
                        failedParse = true
                        break
                }
            }
            
        } else if (arg === "clang++" || arg === "") { // discard
        } else {
            if (sourcePath === undefined)
                sourcePath = arg
            else
                failedParse = true
        }
        if (failedParse) {
            console.log("Failed parsing of compile_commands argument : " + arg)
            console.log(command)
        }
    }
    if (cppStandard === undefined || sourcePath === undefined) {
        console.log("Failed parsing compile_commands.json")
        console.log(command)
        throw new Error("Failed parsing compile_commands.json")
    }
    return {defines:defines, cppStandard:cppStandard, regularIncludes:regularIncludes, systemIncludes:systemIncludes, sourcePath:sourcePath}
}

async function loadCompileCommands(release:cms.CmsReleaseBase) : Promise<CompileCommand[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(await nodeFs.readFile(path.join(release.cvmfsPath(), "compile_commands.json"), {encoding : 'utf8'}));
}

/** Gets the compile commands for the release (either loads them from file or gets them from cache) */
async function getCompileCommandsForRelease(release:cms.CmsRelease) {
    let cachedCommandsP = compileCommandsCache.get(new cms.CmsReleaseBase(release.scram_arch, release.cmssw_release))
    if (cachedCommandsP === undefined) {
        cachedCommandsP = loadCompileCommands(release)
        compileCommandsCache.set(release, cachedCommandsP)
    }
    return cachedCommandsP
}

function getCompileCommandForFile(release:cms.CmsRelease|cms.CmsReleaseBase, compileCommands:CompileCommand[], uri:vscode.Uri):CompileCommand {
    let pathFromRelease:string|undefined = undefined
    if (uri.fsPath.startsWith("/cvmfs")) {
        pathFromRelease = uri.fsPath.split("/").slice(7).join()
    } else {
        if (!(release instanceof cms.CmsRelease) || !uri.fsPath.startsWith(release.rootFolder.fsPath))
            throw new Error("C++ : Could not map file " + uri.toString() + " to release " + release.toString())
        pathFromRelease = uri.fsPath.slice(release.rootFolder.fsPath.length)
    }
    const pathSplit = pathFromRelease.split("/")
    if (!pathFromRelease.endsWith(".h")) {
        // exact search
        for (const command of compileCommands) {
            if (command.file.endsWith(pathFromRelease))
                return command
        }
    }
    if (pathSplit.at(-1) !== "interface") {
        // Did not find an exact match. Fall back on another file in the same folder (src/plugins) (in case of newly created file)
        for (const command of compileCommands) {
            if (command.file.split("/").slice(undefined, -2).join().endsWith(pathSplit.slice(undefined, -2).join()))
                return command
        }
    }
    // Fallback on anything in same package
    for (const command of compileCommands) {
        if (command.file.split("/").slice(undefined, -3).join().endsWith(pathSplit.slice(undefined, -3).join()))
            return command
    }
    // Ultimate fallback
    console.log("Could not find compile command for file " + uri.toString() + ". Falling back")
    return compileCommands[0]
    //throw new Error("Could not find compile command for file " + uri.toString())
}

async function provideConfigurationForFile(uri:vscode.Uri) : Promise<vsCpp.SourceFileConfiguration> {
    const release = await cms.resolveBaseRelease(await cms.CmsRelease.fromAnyUriInRelease(uri))
    const compileCommands = getCompileCommandForFile(release, await getCompileCommandsForRelease(release), uri)
    const parsedCommand = parseCompileCommand(compileCommands)
    const res:vsCpp.SourceFileConfiguration = {defines:parsedCommand.defines, includePath:parsedCommand.systemIncludes.concat(parsedCommand.regularIncludes),
        intelliSenseMode:'gcc-x64', standard:parseCppStandard(parsedCommand.cppStandard),
        compilerPath: pathToGccStarter(release).fsPath} 
    console.log(res)
    return res
}

class CmsswConfigurationProvider implements vsCpp.CustomConfigurationProvider {
    name = "CMSSW";
    extensionId = "cmssw-vscode"


    // eslint-disable-next-line @typescript-eslint/require-await
    async canProvideBrowseConfiguration(): Promise<boolean> {
        return cms.getCurrentRelease() !== undefined
    }
    async provideBrowseConfiguration(): Promise<vsCpp.WorkspaceBrowseConfiguration> {
        const release = cms.getCurrentRelease()
        if (release === undefined)
            throw new Error("Cannot provide browseConfiguration since no CMSSW release is set")
        // TODO do something better than just taking a random file's configuration
        const parsedCompileCommand = parseCompileCommand((await getCompileCommandsForRelease(release))[0])
        return {
            browsePath:parsedCompileCommand.systemIncludes.concat(parsedCompileCommand.regularIncludes),
            compilerPath:pathToGccStarter(release).fsPath,
            standard:parseCppStandard(parsedCompileCommand.cppStandard)
        }
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {
        return true
    }
    async provideConfigurations(uris: vscode.Uri[]): Promise<vsCpp.SourceFileConfigurationItem[]> {
        const resultConfs:Promise<vsCpp.SourceFileConfigurationItem|undefined>[] = []
        for (const uri of uris) {
            resultConfs.push((async ():Promise<vsCpp.SourceFileConfigurationItem|undefined> => {
                try {
                    return {uri:uri, configuration:await provideConfigurationForFile(uri)}
                } catch (e) {
                    console.log("Could not get C++ configuration for file " + uri.toString())
                    console.log(e)
                    return undefined
                }
            })())
        }
        return (await Promise.all(resultConfs)).filter((val) => val !== undefined) as vsCpp.SourceFileConfigurationItem[]
    }
    dispose() {
        compileCommandsCache.clear()
        //cppCompilerCache.clear()
    }
}

function pathToGccStarter(release:cms.CmsRelease) {
    return vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", "cmsenv_launchers", "g++")
}

async function setupForCurrentRelease() {
    const release = cms.getCurrentRelease()
    if (release === undefined)
        return
    const pathToGcc = await getCppCompilerPath(release)
    await utils.createExecutableScript(pathToGccStarter(release),
        "#!/bin/bash\n" + 
		'cd "$(dirname "$0")"\n' + // cd to script directory
		"cmsenv\n" +
		"cd - > /dev/null\n" +
		'exec "'+pathToGcc+'" "$@"\n'
    )
}

export async function setupCpptools() : Promise<vscode.Disposable> {
	cppApi = await vsCpp.getCppToolsApi(vsCpp.Version.v2)
    if (!cppApi) {
        void vscode.window.showErrorMessage("CMSSW : Could not load the Cpptools API")
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        return new vscode.Disposable(()=>{})
    }
    cppConfProvider = new CmsswConfigurationProvider()
    cppApi.registerCustomConfigurationProvider(cppConfProvider)
    cms.onReleaseChange.event((e) => setupForCurrentRelease())
    await setupForCurrentRelease()
    cppApi.notifyReady(cppConfProvider)
    return cppApi
}


/**
 * Checks if Cpp setup is already done 
 * @param release 
 * @returns true if python is fully setup, false if some setup is missing
 * @throws in case something is wrong in the config (should probably clear everything in this case)
 */
export async function isCppFullySetup(release:cms.CmsRelease):Promise<boolean> {
	const checkGccStarter = async () => {
		try {
			await vscode.workspace.fs.stat(pathToGccStarter(release))
			return true;
		} catch (e) {
			if (utils.isENOENT(e))
				return false;
			throw e;
		}
	}
	const res = await Promise.all([checkGccStarter()])
	console.log("isCppFullySetup result")
	console.log(res)
	return (res[0])
}
