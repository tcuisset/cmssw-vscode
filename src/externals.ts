import { promisify } from 'node:util';
import * as cp from 'node:child_process'
import * as path from 'path';

import {CmsRelease} from './cmsRelease'
import * as cms from './cmsRelease'
import * as utils from "./utils";


export interface CmsPythonExternal {
	name:string
	path:string ///< Path to the site-packages folder of the python external
}

/**
 * Finds the location of the site-packages for each python external
 * @param release 
 * @param pythonVersion can be "python3.9" for example. Needed to locate externals dir
 * @returns 
 */
export async function getPythonExternalsForRelease(release:CmsRelease, pythonVersion:string):Promise<CmsPythonExternal[]> {
	const scramToolResAll = (await promisify(cp.exec)('cmsenv && scram tool list ', {cwd: release.rootFolder.fsPath}));
	const scramToolRes = scramToolResAll.stdout
	// https://regex101.com/r/WNQA21/1
	const re = /^[ \t]{0,}(py3-[a-zA-Z0-9_-]{1,})[ \t]{1,}([0-9.a-zA-Z_-]{1,})$/gm
	const externals = new Array<CmsPythonExternal>();
	for (const match of scramToolRes.matchAll(re)) {
		// /cvmfs/cms.cern.ch/el8_amd64_gcc12/external/py3-mplhep/0.3.26-7d223e0f2896ae13fa0f51c21ced3c06/lib/python3.9/site-packages
		const name = match[1]
		const version = match[2]
		const pathToPyExternal = path.join("/cvmfs/cms.cern.ch/", release.scram_arch, "external", name, version, "lib", pythonVersion, "site-packages")
		externals.push({name: match[1], path:pathToPyExternal})
	}
	return externals
}