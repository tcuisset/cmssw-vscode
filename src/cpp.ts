import * as vscode from 'vscode';
import * as nodeFs from 'node:fs/promises'
import {CppToolsApi, Version, CustomConfigurationProvider, getCppToolsApi, SourceFileConfigurationItem, WorkspaceBrowseConfiguration} from 'vscode-cpptools';
import { CmsRelease, getCurrentRelease } from './common';
import * as com from './common'

let cppApi:CppToolsApi|undefined = undefined;
let cppConfProvider:CmsswConfigurationProvider|undefined = undefined

interface CompileCommand {
    command:string; directory:string; file:string;
}

async function loadCompileCommands(release:CmsRelease) : Promise<CompileCommand[]> {
    return JSON.parse(await nodeFs.readFile('/home/cuisset/cms/vscode-extension/test_workspace/compile_commands.json', {encoding : 'utf8'}));
}

/**
 * Configuration for a single release
 */
class CmsswReleaseConfiguration {
    release:CmsRelease
    compile_commands?:CompileCommand[]

    constructor(release:CmsRelease) {
        this.release = release
    }

    async init() {
        this.compile_commands = await loadCompileCommands(this.release)
    }

    getCompileCommandForFile(uri:vscode.Uri) {
        if (this.compile_commands === undefined)
            throw Error("C++ configuration was not initialized")
        for (const command of this.compile_commands) {
            
        }
    }
}

class CmsswConfigurationProvider implements CustomConfigurationProvider {
    name: string = "CMSSW";
    extensionId: string = "cmssw-vscode"


    async canProvideBrowseConfiguration(token?: any): Promise<boolean> {
        return (getCurrentRelease() !== undefined)
    }
    async provideBrowseConfiguration(token?: any): Promise<WorkspaceBrowseConfiguration> {
        return {
            browsePath:[],

        }
    }
    async canProvideConfiguration(uri: vscode.Uri, token?: any): Promise<boolean> {
        return false
    }
    async provideConfigurations(uris: vscode.Uri[], token?: any): Promise<SourceFileConfigurationItem[]> {
        return []
    }
    dispose() {
        
    }
}

async function setupForCurrentRelease() {
    
}

export async function setupCpptools() : Promise<vscode.Disposable> {
	cppApi = await getCppToolsApi(Version.v2)
    if (!cppApi) {
        vscode.window.showErrorMessage("CMSSW : Could not load the Cpptools API")
        return new vscode.Disposable(()=>{})
    }
    cppConfProvider = new CmsswConfigurationProvider()
    cppApi.registerCustomConfigurationProvider(cppConfProvider)
    com.onReleaseChange.event((e) => setupForCurrentRelease())
    await setupForCurrentRelease()
    cppApi.notifyReady(cppConfProvider)
    return cppApi
}


