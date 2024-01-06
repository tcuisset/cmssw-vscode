
import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeFs from 'node:fs/promises'

import {CmsRelease, Package} from '../cmsRelease'
import * as cms from '../cmsRelease'
import * as utils from "../utils";

/**
 * Target of symbolic link of python package
 */
enum LinkTarget {
    Local, // To local release (package is checked out)
    CVMFS // To CVMFS (in case package is not checked out)
}


/**
 * Path to the python symlink folder for given release (for python or cfipython)
 * @param release 
 * @param fileType 
 * @param mkdir if true, will create the dir if it does not exist. if false, it will return the path but the dir may not exist
 * @returns 
 */
export async function getPythonSymlinkTreeFolder(release:CmsRelease,  mkdir=true)  : Promise<vscode.Uri>  {
	// eslint-disable-next-line prefer-const
	let folderName = "python";
	const pySymlinkTreeBasePath = vscode.Uri.joinPath(release.rootFolder, ".vscode-cmssw", folderName);
	if (mkdir) {
		try {
			// Does not raise even when directory already exists
			await vscode.workspace.fs.createDirectory(pySymlinkTreeBasePath);
		} catch (e) {
			throw Error("Could not create python symlink tree directory at path " + pySymlinkTreeBasePath.toString(), {cause:e})
		}
	}
	return pySymlinkTreeBasePath;
}


enum CmsFileType {
    RegularPython, // cff or regular .py
    CfiPython, // cfi file (located in cfipython)
    Cpp,
}

/**
 * Build a symbolic link for PYthon, folder mode
 * @param release 
 * @param symlinkTreeBase vscode Uri to the base folder of python symlinks in the release
 * @param pkg the package to create a symlink for
 * @param linkTargetType link target to local release or to CVMFS
 * @throws in case of unrecoverable error (does not throw in case link already exists)
 */
async function buildSinglePythonSymlinkForPackage(release:CmsRelease, symlinkTreeBase:vscode.Uri, pkg:Package, linkTargetType:LinkTarget) {
    // Create package directory in symlink folder
    const linkPackagePath = path.join(symlinkTreeBase.fsPath, pkg.subsystem, pkg.packageName);
    try {
        await nodeFs.mkdir(linkPackagePath, {recursive:true});
    } catch (e) {
        if (!utils.isENOENT(e)) {
            throw Error("Python symlink creation : Could not create folder " + linkPackagePath, {cause:e});
        }
        // folder already exists : not a problem normally
    }

	/** Path to package python folder to link to */
	let targetPackagePythonDir:string;
	/** Path to package cfipythpn folder */
	let targetPackageCfiDir:string;
    if (linkTargetType === LinkTarget.Local) {
        targetPackagePythonDir = vscode.Uri.joinPath(release.rootFolder, "src", pkg.subsystem, pkg.packageName, "python").fsPath
		targetPackageCfiDir = vscode.Uri.joinPath(release.rootFolder, "cfipython", pkg.subsystem, pkg.packageName, "python").fsPath
    } else if (linkTargetType === LinkTarget.CVMFS) {
        // python located at /cvmfs/cms.cern.ch/el8_amd64_gcc12/cms/cmssw/CMSSW_14_0_0_pre1/src/Pkg/SubPjg/python/thing.py
        targetPackagePythonDir = path.join(release.cvmfsPath(), "src", pkg.subsystem, pkg.packageName,  "python")
		targetPackageCfiDir = path.join(release.cvmfsPath(), "cfipython", release.scram_arch, pkg.subsystem, pkg.packageName)
    } else {
        throw new Error("Unkwown link target type")
    }

	/** Helper for making a symlink */
	const makeSymlinkFct = async (target:string, linkPath:string) => {
		try {
			await utils.makeOrUpdateSymlink(target, linkPath)
			//console.log("Wrote symlink from " + linkPath + " to " + target);
		} catch (e) {
			throw Error("Could not create symlink from " + linkPath + " to " + target, {cause:e})
		}
	}

	const makeSymlinksForAllFilesInFolder = async (folder:string) => {
		const filesInTarget = await nodeFs.readdir(folder)
		const promises:Promise<void>[] = []
		for (const file of filesInTarget) {
			if (file.endsWith(".py") || (file !== "__pycache__" && file !== ".scram")) { // sometimes there are nested folders
				promises.push(makeSymlinkFct(path.join(folder, file), path.join(linkPackagePath, file)))
			}
		}
		return Promise.all(promises)
	}

	await Promise.all([makeSymlinksForAllFilesInFolder(targetPackagePythonDir), makeSymlinksForAllFilesInFolder(targetPackageCfiDir)])
}

/**
 * Build in the local release in .vscode-cmssw, a tree of symlinks to directories of python files, so that Pylance can work properly
 * Looks for packages currently checked out and map them either to local, the other requested ones to CVMFS
 * @param release 
 */
export async function buildPythonSymlinkTree(release:CmsRelease) : Promise<void> {
	const symlinkTreeBase = await getPythonSymlinkTreeFolder(release);

    const localPkgs = new Set(await cms.listCheckedOutPackages(release))
    //let cvmfsPkgs = pythonPkgsToIndexFromConfig()
	let cvmfsPkgs = await cms.listPackagesOnCvmfsFromCache(release)
    cvmfsPkgs = cvmfsPkgs.filter( x => !localPkgs.has(x) ); // remove from cvmfs pkgs those that are locally checked out


    const promisesRes = [...localPkgs].map((pkg:cms.Package) => buildSinglePythonSymlinkForPackage(release, symlinkTreeBase, pkg, LinkTarget.Local))
    promisesRes.push(...cvmfsPkgs.map((pkg:cms.Package) => buildSinglePythonSymlinkForPackage(release, symlinkTreeBase, pkg, LinkTarget.CVMFS)))
    await Promise.allSettled(promisesRes)
}


