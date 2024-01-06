# cmssw-vscode README

This extension provides support for CMSSW, the software framework of the CMS experiment, in Visual Studio Code.

## Features

 - Creation of a Python virtual environment, so you can run notebooks in a CMSSW environment straight from VSCode, without any complicated setup. 
 - Opening terminals with cmsenv running automatically
 - Automatic completion (Pylance) in Python files (an notebooks). Works for CMSSW packages, local ones and externals (such as ROOT, tensorflow, etc)
 - Automatic completion (Intellisense) in C++ files.


## Requirements
*You need to have `source /cvmfs/cms.cern.ch/cmsset_default.sh` in your `.bashrc`* on the remote machine (lxplus or whatever), as the extension assumes you can just call `cmsenv` in a fresh shell. This is usually the case for most people.

The extension will activate if you have a CMSSW release area in your workspace.

Python and C++ VSCode extensions are required (they should be automatically installed when you install this extension)

## Extension Settings
None for now

## Known Issues
C++ autocompletion is still work-in-progress. In particular, it does not work properly for newly created packages that do not exist in the release.

## Release Notes

