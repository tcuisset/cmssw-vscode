# cmssw-vscode README

This extension provides support for CMSSW, the software framework of the CMS experiment, in Visual Studio Code.

## Features

 - Creation of a Python virtual environment, so you can run notebooks in a CMSSW environment straight from VSCode, without any complicated setup. 
 - Automatic completion (Pylance) in Python files (an notebooks). Works for CMSSW packages, local ones and externals (such as ROOT, tensorflow, etc)
 - Automatic completion (Intellisense) in C++ files.


## Requirements
*You need to have `source /cvmfs/cms.cern.ch/cmsset_default.sh` in your `.bashrc`* on the remote machine (lxplus or whatever), as the extension assumes you can just call `cmsenv` in a fresh shell. This is usually the case for most people.

The extension will activate if you have a CMSSW release area in your workspace.

Python and C++ VSCode extensions are required (they should be automatically installed when you install this extension)

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

