# Devlopment readme for CMSSW-vscode extension
## Icons
Putting an icon in package.json contributes/terminal/profiles/icon does not seem to do anything, however setting it in JS code works using a ThemeIcon

First convert all SVG icons to woff (follow <https://www.eliostruyf.com/add-custom-themable-icon-visual-studio-code/>). Then add entry in package.json under contributes/icons for each icon in the woff file. Then icons can be referenced as $(iconName) where iconName is the key in package.json

## Python
Pyright (static analysis tool for Python used VSCode) documentation is here : <https://microsoft.github.io/pyright/#/configuration?id=main-configuration-options>
When encountering an import, Pyright will look in the following locations in order :
 - workspace code (repsecting include and exclude config)
 - in extraPaths config paths
 - use the interpreter include paths (ignoring exclude config). This will bring in all the cvmfs paths, externals, as well as $LOCALRT/python

