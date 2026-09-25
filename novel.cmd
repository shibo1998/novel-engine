@echo off
rem novel-engine CLI shim. Add D:\1-work\novel-engine to PATH to run `novel` anywhere,
rem or call with full path, e.g.:
rem   D:\1-work\novel-engine\novel.cmd state --book "D:\1-work\novel\<your-book>"
rem NOTE: keep this file ASCII-only; cmd.exe mis-reads UTF-8 batch comments under GBK.
node "%~dp0apps\cli\dist\index.js" %*
