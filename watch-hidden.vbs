Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
If WScript.Arguments.Count > 0 Then extra = " " & WScript.Arguments(0)
CreateObject("WScript.Shell").Run "node """ & dir & "\inject.js"" --watch" & extra, 0, False
