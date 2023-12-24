import * as vscode from 'vscode';
import * as nodeFs from 'node:fs/promises'
import {CppToolsApi, Version, CustomConfigurationProvider, getCppToolsApi, SourceFileConfigurationItem, WorkspaceBrowseConfiguration} from 'vscode-cpptools';
import { CmsRelease, getCurrentRelease } from './common';


async function loadCompileCommands(release:CmsRelease) {
    return JSON.parse(await nodeFs.readFile('/home/cuisset/cms/vscode-extension/test_workspace/compile_commands.json', {encoding : 'utf8'}));
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

async function setupCpptools() {
	let api = await getCppToolsApi(Version.v2)
    if (!api) {
        vscode.window.showErrorMessage("CMSSW : Could not load the Cpptools API")
        return
    }


    //api.notifyReady()
}
